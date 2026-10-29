"""Internal AGE node storage, composed by the forthcoming graph adapter.

This component is deliberately absent from the public backend factories until
the graph, retrieval and maintenance contracts are implemented.
"""

import json
import math

from typing import Any

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import GraphDBError
from memos.graph_dbs._opengauss_connection import OpenGaussConnectionPool
from memos.log import get_logger


logger = get_logger(__name__)
_TABLE = '"memos_graph"."Memory"'
_UPSERT = (
    f"INSERT INTO {_TABLE} (scope, business_id, memory, embedding, properties) "
    "VALUES (%s, %s, %s, %s::pg_catalog.vector, %s::ag_catalog.agtype) "
    "ON CONFLICT (scope, business_id) DO UPDATE SET memory = EXCLUDED.memory, "
    "embedding = EXCLUDED.embedding, properties = EXCLUDED.properties"
)


class OpenGaussNodeStore:
    """Scoped AGE nodes and adjacency, composed by the forthcoming graph adapter."""

    def __init__(self, config: OpenGaussGraphDBConfig) -> None:
        self.config = config.model_copy(deep=True)
        self._pool = OpenGaussConnectionPool(self.config)
        try:
            self._initialize()
        except BaseException:
            try:
                self._pool.close()
            except GraphDBError:
                logger.warning("openGauss pool cleanup failed after initialization failure")
            raise

    def _initialize(self) -> None:
        with self._pool.transaction() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(621503, 1)")
            cursor.execute("SELECT oid FROM ag_catalog.ag_graph WHERE name = %s", ("memos_graph",))
            if cursor.fetchone() is None:
                cursor.execute("SELECT ag_catalog.create_graph(%s)", ("memos_graph",))
            cursor.execute(
                "SELECT l.kind, n.nspname, c.relname FROM ag_catalog.ag_label l "
                "JOIN ag_catalog.ag_graph g ON g.oid = l.graph "
                "JOIN pg_catalog.pg_class c ON c.oid = l.relation "
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                "WHERE g.name = %s AND l.name = %s",
                ("memos_graph", "Memory"),
            )
            label = cursor.fetchone()
            if label is None:
                cursor.execute("SELECT ag_catalog.create_vlabel(%s, %s)", ("memos_graph", "Memory"))
                cursor.execute(
                    f"ALTER TABLE {_TABLE} ADD COLUMN scope text NOT NULL, "
                    "ADD COLUMN business_id text NOT NULL, ADD COLUMN memory text NOT NULL, "
                    f"ADD COLUMN embedding pg_catalog.vector({self.config.embedding_dimension}), "
                    "ADD UNIQUE(scope, business_id)"
                )
            elif label != ("v", "memos_graph", "Memory"):
                raise GraphDBError("The openGauss Memory label is incompatible")
            cursor.execute(
                "SELECT attname, pg_catalog.format_type(atttypid, atttypmod), attnotnull, "
                "atthasdef, attnum FROM pg_catalog.pg_attribute "
                "WHERE attrelid = %s::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
                (_TABLE,),
            )
            expected = [
                ("id", "graphid", True, True, 1),
                ("properties", "agtype", True, True, 2),
                ("scope", "text", True, False, 3),
                ("business_id", "text", True, False, 4),
                ("memory", "text", True, False, 5),
                ("embedding", f"vector({self.config.embedding_dimension})", False, False, 6),
            ]
            if cursor.fetchall() != expected:
                raise GraphDBError("The openGauss Memory columns are incompatible")
            cursor.execute(
                "SELECT 1 FROM pg_catalog.pg_index WHERE indrelid = %s::regclass "
                "AND indisunique AND indisvalid AND indimmediate AND indpred IS NULL "
                "AND indexprs IS NULL AND indkey::text = '3 4'",
                (_TABLE,),
            )
            if cursor.fetchone() is None:
                raise GraphDBError("The openGauss Memory unique constraint is incompatible")

    def _scope(self, user_name: str | None) -> str:
        scope = self.config.user_name if user_name is None else user_name
        if scope is None and self.config.use_multi_db:
            return ""
        if not isinstance(scope, str) or not scope.strip():
            raise ValueError("user_name must be a nonblank string")
        return scope

    @staticmethod
    def _validate_id(node_id: str) -> None:
        if not isinstance(node_id, str) or not node_id.strip():
            raise ValueError("id must be a nonblank string")

    def _encode_node(
        self, node_id: str, memory: str, metadata: dict[str, Any], scope: str
    ) -> tuple[str, str, str, str | None, str]:
        self._validate_id(node_id)
        if not isinstance(memory, str):
            raise ValueError("memory must be a string")
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be a JSON object")
        if "id" in metadata or "memory" in metadata:
            raise ValueError("metadata cannot override id or memory")
        if "user_name" in metadata and metadata["user_name"] != scope:
            raise ValueError("metadata user_name must match the operation scope")
        properties = {**metadata, "id": node_id, "memory": memory, "user_name": scope}
        embedding = properties.pop("embedding", None)
        if embedding is not None:
            if not isinstance(embedding, list):
                raise ValueError("embedding must be a list of finite numbers")
            if embedding:
                if len(embedding) != self.config.embedding_dimension:
                    raise ValueError("embedding must match embedding_dimension")
                try:
                    if any(
                        type(value) not in (int, float) or not math.isfinite(value)
                        for value in embedding
                    ):
                        raise ValueError("embedding must contain finite numbers, excluding bool")
                except OverflowError as exc:
                    raise ValueError(
                        "embedding numbers must be representable as finite floats"
                    ) from exc
        try:
            payload = json.dumps(properties, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("metadata must contain valid JSON values") from exc
        if json.loads(payload) != properties:
            raise ValueError("metadata must contain JSON objects with string keys and JSON lists")
        vector = json.dumps(embedding) if embedding else None
        return scope, node_id, memory, vector, payload

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Upsert one identity without replacing its native graphid."""
        self.add_nodes_batch([{"id": id, "memory": memory, "metadata": metadata}], user_name)

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        """Prepare the entire batch before borrowing; SQL succeeds or rolls back together."""
        self._pool.ensure_open()
        scope = self._scope(user_name)
        if not isinstance(nodes, list):
            raise ValueError("nodes must be a list")
        rows = []
        for node in nodes:
            if not isinstance(node, dict) or "id" not in node or "memory" not in node:
                raise ValueError("each node must contain id and memory")
            rows.append(
                self._encode_node(node["id"], node["memory"], node.get("metadata", {}), scope)
            )
        if rows:
            with self._pool.transaction() as connection, connection.cursor() as cursor:
                for row in rows:
                    cursor.execute(_UPSERT, row)

    @staticmethod
    def _decode_node(row: tuple, scope: str, include_embedding: bool) -> dict[str, Any]:
        node_id, memory, payload, vector = row
        try:
            properties = json.loads(payload)
        except (TypeError, ValueError) as exc:
            raise GraphDBError("Invalid AGE node properties") from exc
        if not isinstance(properties, dict) or (
            properties.get("id"),
            properties.get("memory"),
            properties.get("user_name"),
        ) != (node_id, memory, scope):
            raise GraphDBError("Inconsistent AGE node properties and retrieval columns")
        for key in ("id", "memory", "user_name"):
            del properties[key]
        if include_embedding:
            properties["embedding"] = json.loads(vector) if vector is not None else None
        return {"id": node_id, "memory": memory, "metadata": properties}

    def get_nodes(
        self, ids: list[str], include_embedding: bool = False, user_name: str | None = None
    ) -> list[dict[str, Any]]:
        """Return existing identities once, in first-requested order, within one scope."""
        self._pool.ensure_open()
        scope = self._scope(user_name)
        if not isinstance(ids, list):
            raise ValueError("ids must be a list")
        for node_id in ids:
            self._validate_id(node_id)
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        ids = list(dict.fromkeys(ids))
        if not ids:
            return []
        with self._pool.transaction() as connection, connection.cursor() as cursor:
            found = self._read_nodes(cursor, ids, scope, include_embedding)
        return [found[node_id] for node_id in ids if node_id in found]

    def _read_nodes(
        self, cursor: Any, ids: list[str], scope: str, include_embedding: bool = False
    ) -> dict[str, dict[str, Any]]:
        vector_column = "embedding::text" if include_embedding else "NULL"
        cursor.execute(
            f"SELECT business_id, memory, properties, {vector_column} FROM ONLY {_TABLE} "
            "WHERE scope = %s AND business_id = ANY(%s)",
            (scope, ids),
        )
        return {
            row[0]: self._decode_node(row, scope, include_embedding) for row in cursor.fetchall()
        }

    def get_node(
        self, id: str, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any] | None:
        """Read an identity; a missing node is None."""
        nodes = self.get_nodes([id], include_embedding, user_name)
        return nodes[0] if nodes else None

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """Merge fields under a row lock, retaining unspecified values and scope."""
        self._pool.ensure_open()
        scope = self._scope(user_name)
        if not isinstance(fields, dict):
            raise ValueError("fields must be a JSON object")
        supplied = {key: value for key, value in fields.items() if key != "memory"}
        self._encode_node(id, fields.get("memory", ""), supplied, scope)
        if not fields:
            return
        with self._pool.transaction() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, embedding::text FROM ONLY {_TABLE} "
                "WHERE scope = %s AND business_id = %s FOR UPDATE",
                (scope, id),
            )
            row = cursor.fetchone()
            if row is None:
                return
            node = self._decode_node(row, scope, True)
            metadata = {**node["metadata"], **supplied}
            _, _, memory, vector, payload = self._encode_node(
                id, fields.get("memory", node["memory"]), metadata, scope
            )
            cursor.execute(
                f"UPDATE {_TABLE} SET memory = %s, embedding = %s::pg_catalog.vector, "
                "properties = %s::ag_catalog.agtype WHERE scope = %s AND business_id = %s",
                (memory, vector, payload, scope, id),
            )

    def close(self) -> None:
        """Close owned connections; repeated successful close is harmless."""
        self._pool.close()
