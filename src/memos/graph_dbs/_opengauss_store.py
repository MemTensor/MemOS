"""Internal AGE node storage, composed by the forthcoming graph adapter.

This component is deliberately absent from the public backend factories until
the graph, retrieval and maintenance contracts are implemented.
"""

import json
import math
import re

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

    @staticmethod
    def _validate_edge_type(edge_type: str, allow_any: bool = True) -> None:
        if (
            not isinstance(edge_type, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", edge_type)
            or (edge_type == "ANY" and not allow_any)
        ):
            raise ValueError("Invalid relationship type")

    @staticmethod
    def _cypher(
        cursor: Any, body: str, parameters: dict[str, Any], columns: str = "result agtype"
    ) -> list[tuple]:
        # AGE requires a literal query body and a prepared agtype parameter.
        # This connection belongs exclusively to the pool borrower. Clearing
        # first also bounds statements left behind by an aborted transaction.
        cursor.execute("DEALLOCATE ALL")
        cursor.execute(
            "PREPARE memos_age (ag_catalog.agtype) AS SELECT * FROM "
            f"ag_catalog.cypher('memos_graph', $memos${body}$memos$, $1) AS ({columns})"
        )
        cursor.execute(
            "EXECUTE memos_age(%s::ag_catalog.agtype)",
            (json.dumps(parameters, ensure_ascii=False),),
        )
        rows = cursor.fetchall()
        cursor.execute("DEALLOCATE memos_age")
        return rows

    @staticmethod
    def _lock_graph_nodes(cursor: Any, ids: list[str], scope: str) -> set[str]:
        # Serialize graph mutations, including concurrent creation of AGE edge
        # labels. Row locks coordinate deletion with existing node upserts.
        cursor.execute("SELECT pg_advisory_xact_lock(621503, 2)")
        cursor.execute(
            f"SELECT business_id FROM ONLY {_TABLE} "
            "WHERE scope = %s AND business_id = ANY(%s) ORDER BY business_id FOR UPDATE",
            (scope, sorted(set(ids))),
        )
        return {row[0] for row in cursor.fetchall()}

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """Atomically hard-delete one scoped node and all its incident native edges."""
        self._pool.ensure_open()
        scope = self._scope(user_name)
        self._validate_id(id)
        with self._pool.transaction() as connection, connection.cursor() as cursor:
            if not self._lock_graph_nodes(cursor, [id], scope):
                return
            self._cypher(
                cursor,
                "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
                "(a.id = $id AND a.user_name = $scope) OR "
                "(b.id = $id AND b.user_name = $scope) DELETE r",
                {"id": id, "scope": scope},
            )
            # Native AGE node deletion bypasses SQL row triggers and DELETE
            # privileges in this build. Keep node mutations on the SQL label
            # path so projection, constraints and failure handling stay aligned.
            cursor.execute(
                f"DELETE FROM ONLY {_TABLE} WHERE scope = %s AND business_id = %s",
                (scope, id),
            )

    def _change_edge(
        self, source: str, target: str, edge_type: str, user_name: str | None, create: bool
    ) -> None:
        self._pool.ensure_open()
        scope = self._scope(user_name)
        self._validate_id(source)
        self._validate_id(target)
        self._validate_edge_type(edge_type, allow_any=False)
        endpoints = {source, target}
        with self._pool.transaction() as connection, connection.cursor() as cursor:
            if self._lock_graph_nodes(cursor, list(endpoints), scope) != endpoints:
                return
            conditions = (
                "a.id = $source AND b.id = $target "
                "AND a.user_name = $scope AND b.user_name = $scope "
            )
            body = (
                f"MATCH (a:Memory), (b:Memory) WHERE {conditions}MERGE (a)-[:{edge_type}]->(b)"
                if create
                else f"MATCH (a:Memory)-[r]->(b:Memory) WHERE {conditions}"
                "AND type(r) = $type DELETE r"
            )
            parameters = {"source": source, "target": target, "scope": scope}
            if not create:
                parameters["type"] = edge_type
            self._cypher(cursor, body, parameters)

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Merge a directed typed edge; a missing scoped endpoint is a no-op."""
        self._change_edge(source_id, target_id, type, user_name, create=True)

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Remove only the given direction and type, retaining parallel edges."""
        self._change_edge(source_id, target_id, type, user_name, create=False)

    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY", user_name: str | None = None
    ) -> list[dict[str, str]]:
        """Return sorted, unique from/to/type records, with both endpoints scoped."""
        self._pool.ensure_open()
        scope = self._scope(user_name)
        self._validate_id(id)
        self._validate_edge_type(type)
        if direction not in ("OUTGOING", "INCOMING", "ANY"):
            raise ValueError("Invalid edge direction")
        endpoint = {
            "OUTGOING": "a.id = $id",
            "INCOMING": "b.id = $id",
            "ANY": "(a.id = $id OR b.id = $id)",
        }[direction]
        condition = "" if type == "ANY" else " AND type(r) = $type"
        with self._pool.transaction() as connection, connection.cursor() as cursor:
            return self._read_edges(
                cursor,
                endpoint + condition,
                {"id": id, "scope": scope, "type": type},
            )

    def _read_edges(
        self, cursor: Any, condition: str, parameters: dict[str, Any]
    ) -> list[dict[str, str]]:
        rows = self._cypher(
            cursor,
            "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
            f"{condition} AND a.user_name = $scope AND b.user_name = $scope "
            "RETURN a.id, b.id, type(r)",
            parameters,
            "source agtype, target agtype, edge_type agtype",
        )
        edges = set()
        try:
            for row in rows:
                edge = tuple(json.loads(value) for value in row)
                if len(edge) != 3 or not all(isinstance(value, str) for value in edge):
                    raise ValueError("Invalid edge fields")
                edges.add(edge)
        except (TypeError, ValueError) as exc:
            raise GraphDBError("Invalid AGE edge projection") from exc
        return [
            {"from": source, "to": target, "type": edge_type}
            for source, target, edge_type in sorted(edges)
        ]

    def edge_exists(
        self,
        source_id: str,
        target_id: str,
        type: str = "ANY",
        direction: str = "OUTGOING",
        user_name: str | None = None,
    ) -> bool:
        """Check adjacency in the requested direction without crossing scopes."""
        self._pool.ensure_open()
        self._validate_id(target_id)
        return any(
            (edge["to"] if edge["from"] == source_id else edge["from"]) == target_id
            for edge in self.get_edges(source_id, type, direction, user_name)
        )

    def get_neighbors(
        self, id: str, type: str, direction: str = "out", user_name: str | None = None
    ) -> list[str]:
        """Return unique sorted neighboring business IDs, including self-loops."""
        self._pool.ensure_open()
        if direction not in ("in", "out", "both"):
            raise ValueError("Invalid neighbor direction")
        edges = self.get_edges(
            id, type, {"in": "INCOMING", "out": "OUTGOING", "both": "ANY"}[direction], user_name
        )
        return sorted({edge["to"] if edge["from"] == id else edge["from"] for edge in edges})

    def close(self) -> None:
        """Close owned connections; repeated successful close is harmless."""
        self._pool.close()
