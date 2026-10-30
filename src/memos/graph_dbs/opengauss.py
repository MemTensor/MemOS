"""openGauss enterprise AGE backend, following the existing GraphDB provider layout.

The provider owns its connection pool, graph operations and filter builders.
Retrieval and maintenance methods are still abstract; factory registration waits
until the full BaseGraphDB contract is implemented.
"""

import json
import math
import re
import threading

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import ConfigurationError, GraphDBError
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


try:
    import psycopg2

    from psycopg2.pool import ThreadedConnectionPool
except ImportError:
    psycopg2 = None
    ThreadedConnectionPool = None

logger = get_logger(__name__)
_TABLE = '"memos_graph"."Memory"'
# This AGE build emits fractional floats as .8 / -.2. Protect quoted JSON
# strings while restoring the leading zero needed by a standard JSON parser.
_AGE_JSON_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|(?<![\w.])(-?)\.(\d+)')
_UPSERT = (
    f"INSERT INTO {_TABLE} (scope, business_id, memory, embedding, properties) "
    "VALUES (%s, %s, %s, %s::pg_catalog.vector, %s::ag_catalog.agtype) "
    "ON CONFLICT (scope, business_id) DO UPDATE SET memory = EXCLUDED.memory, "
    "embedding = EXCLUDED.embedding, properties = EXCLUDED.properties"
)


_ARRAY_FIELDS = {"tags", "sources", "file_ids", "related_id", "message_ids"}
_ROOT_FIELDS = {
    "id",
    "key",
    "tags",
    "type",
    "usage",
    "memory",
    "status",
    "sources",
    "user_id",
    "graph_id",
    "user_name",
    "background",
    "confidence",
    "created_at",
    "session_id",
    "updated_at",
    "memory_type",
    "node_type",
    "info",
    "source",
    "file_ids",
    "project_id",
    "manager_user_id",
    "delete_time",
    "related_id",
    "message_ids",
}
_OPERATORS = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


def _encode_filter_value(value: Any) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if json.loads(encoded) != value:
            raise ValueError("Filter values must be JSON values with string object keys")
        return encoded
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid JSON filter value") from exc


class OpenGaussGraphDB(BaseGraphDB):
    """Scoped AGE graph backend with an owned pool and parameter-bound filters."""

    def __init__(self, config: OpenGaussGraphDBConfig) -> None:
        if ThreadedConnectionPool is None:
            raise ConfigurationError(
                "Install openGauss support with pip install 'MemoryOS[tree-mem]'"
            )
        self.config = config.model_copy(deep=True)
        self.db_name = config.db_name
        self.user_name = config.user_name
        self._semaphore = threading.BoundedSemaphore(config.maxconn)
        self._condition = threading.Condition()
        self._active = 0
        self._closed = False
        self._pool_closed = False
        try:
            self.connection_pool = ThreadedConnectionPool(
                config.minconn,
                config.maxconn,
                host=config.host,
                port=config.port,
                dbname=config.db_name,
                user=config.user,
                password=config.password,
                connect_timeout=config.connect_timeout,
                application_name="memos-opengauss",
            )
        except psycopg2.Error as exc:
            raise GraphDBError("Could not open the openGauss connection pool") from exc

        try:
            self._init_schema()
        except BaseException:
            try:
                self.close()
            except GraphDBError:
                logger.warning("openGauss pool cleanup failed after initialization failure")
            raise

    def _ensure_open(self) -> None:
        """Reject operations after close, including operations on empty inputs."""
        with self._condition:
            if self._closed:
                raise GraphDBError("The openGauss connection pool is closed")

    @contextmanager
    def _get_connection(self) -> Iterator[Any]:
        """Prepare one owned session, commit once, and always release admission."""
        self._ensure_open()
        if not self._semaphore.acquire(timeout=self.config.connection_wait_timeout):
            raise GraphDBError("openGauss connection wait timed out")
        with self._condition:
            if self._closed:
                self._semaphore.release()
                raise GraphDBError("The openGauss connection pool is closed")
            self._active += 1
        connection = None
        failed = discard = False
        try:
            connection = self.connection_pool.getconn()
            if connection.closed:
                raise GraphDBError("The openGauss pool returned a closed connection")
            connection.rollback()
            connection.set_session(
                isolation_level="READ COMMITTED", readonly=False, autocommit=False
            )
            with connection.cursor() as cursor:
                cursor.execute("RESET ALL")
                # Public type input loads AGE hooks without privileged LOAD.
                cursor.execute("SELECT 'null'::ag_catalog.agtype")
                cursor.execute("SET search_path = ag_catalog, public")
            yield connection
            connection.commit()
        except BaseException as exc:
            failed = True
            discard = isinstance(exc, psycopg2.OperationalError | psycopg2.InterfaceError)
            if connection is not None:
                try:
                    connection.rollback()
                except psycopg2.Error:
                    discard = True
                    logger.warning("openGauss rollback failed; discarding the connection")
            if isinstance(exc, psycopg2.Error):
                raise GraphDBError(
                    "openGauss transaction failed; the write was not retried"
                ) from exc
            raise
        finally:
            try:
                if connection is not None:
                    self._return_connection(connection, discard, failed)
            finally:
                with self._condition:
                    self._active -= 1
                    if self._closed and not self._active:
                        try:
                            self._close_pool()
                        except GraphDBError:
                            logger.warning(
                                "openGauss pool shutdown failed during transaction cleanup"
                            )
                    self._condition.notify_all()
                self._semaphore.release()

    def _return_connection(self, connection: Any, discard: bool, failed: bool) -> None:
        try:
            self.connection_pool.putconn(connection, close=discard or bool(connection.closed))
        except psycopg2.Error as exc:
            # A failed return may leave the driver's checkout bookkeeping dirty.
            # Stop admission and drain owners before closing the entire pool.
            with self._condition:
                self._closed = True
            try:
                connection.close()
            except psycopg2.Error:
                logger.warning("openGauss connection close failed during pool cleanup")
            if not failed:
                raise GraphDBError(
                    "Could not return the openGauss connection; the transaction may already be committed"
                ) from exc
            logger.warning("openGauss connection return failed during error cleanup")

    def close(self) -> None:
        """Reject new borrowers, wait for owners, then close; successful close is idempotent."""
        with self._condition:
            self._closed = True
            while self._active:
                self._condition.wait()
            self._close_pool()

    def _close_pool(self) -> None:
        if not self._pool_closed:
            try:
                self.connection_pool.closeall()
            except psycopg2.Error as exc:
                raise GraphDBError("Could not close the openGauss connection pool") from exc
            self._pool_closed = True

    def _init_schema(self) -> None:
        with self._get_connection() as connection, connection.cursor() as cursor:
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
        self._ensure_open()
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
            with self._get_connection() as connection, connection.cursor() as cursor:
                for row in rows:
                    cursor.execute(_UPSERT, row)

    @staticmethod
    def _decode_node(row: tuple, scope: str, include_embedding: bool) -> dict[str, Any]:
        node_id, memory, payload, vector = row
        try:
            payload = _AGE_JSON_TOKEN.sub(
                lambda token: token[0] if token[0].startswith('"') else f"{token[1]}0.{token[2]}",
                payload,
            )
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
        self._ensure_open()
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
        with self._get_connection() as connection, connection.cursor() as cursor:
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
        self._ensure_open()
        scope = self._scope(user_name)
        if not isinstance(fields, dict):
            raise ValueError("fields must be a JSON object")
        supplied = {key: value for key, value in fields.items() if key != "memory"}
        self._encode_node(id, fields.get("memory", ""), supplied, scope)
        if not fields:
            return
        with self._get_connection() as connection, connection.cursor() as cursor:
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
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(id)
        with self._get_connection() as connection, connection.cursor() as cursor:
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
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(source)
        self._validate_id(target)
        self._validate_edge_type(edge_type, allow_any=False)
        endpoints = {source, target}
        with self._get_connection() as connection, connection.cursor() as cursor:
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
        self._ensure_open()
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
        with self._get_connection() as connection, connection.cursor() as cursor:
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
        self._ensure_open()
        self._validate_id(target_id)
        return any(
            (edge["to"] if edge["from"] == source_id else edge["from"]) == target_id
            for edge in self.get_edges(source_id, type, direction, user_name)
        )

    def get_neighbors(
        self, id: str, type: str, direction: str = "out", user_name: str | None = None
    ) -> list[str]:
        """Return unique sorted neighboring business IDs, including self-loops."""
        self._ensure_open()
        if direction not in ("in", "out", "both"):
            raise ValueError("Invalid neighbor direction")
        edges = self.get_edges(
            id, type, {"in": "INCOMING", "out": "OUTGOING", "both": "ANY"}[direction], user_name
        )
        return sorted({edge["to"] if edge["from"] == id else edge["from"] for edge in edges})

    @staticmethod
    def _validate_depth(depth: int) -> None:
        if type(depth) is not int or not 1 <= depth <= 5:
            raise ValueError("depth must be an integer from 1 to 5")

    def get_path(
        self, source_id: str, target_id: str, max_depth: int = 3, user_name: str | None = None
    ) -> list[str]:
        """Find the lexicographically first shortest directed path within 1-5 hops."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(source_id)
        self._validate_id(target_id)
        self._validate_depth(max_depth)
        with self._get_connection() as connection, connection.cursor() as cursor:
            endpoints = {source_id, target_id}
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} WHERE scope = %s AND business_id = ANY(%s)",
                (scope, sorted(endpoints)),
            )
            if {row[0] for row in cursor.fetchall()} != endpoints:
                return []
            if source_id == target_id:
                return [source_id]
            paths = {source_id: [source_id]}
            frontier = [source_id]
            for _ in range(max_depth):
                edges = self._read_edges(cursor, "a.id IN $ids", {"scope": scope, "ids": frontier})
                adjacency: dict[str, set[str]] = {}
                for edge in edges:
                    adjacency.setdefault(edge["from"], set()).add(edge["to"])
                following = []
                # Discovery order preserves lexicographic order of full paths.
                for source in frontier:
                    for target in sorted(adjacency.get(source, set())):
                        if target in paths:
                            continue
                        paths[target] = [*paths[source], target]
                        if target == target_id:
                            return paths[target]
                        following.append(target)
                frontier = following
                if not frontier:
                    break
        return []

    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str | None = "activated",
        user_name: str | None = None,
    ) -> dict[str, Any]:
        """Return full scoped nodes and the induced edges within a two-way radius."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(center_id)
        self._validate_depth(depth)
        if center_status is not None and not isinstance(center_status, str):
            raise ValueError("center_status must be a string or None")
        empty = {"core_node": None, "neighbors": [], "edges": []}
        with self._get_connection() as connection, connection.cursor() as cursor:
            core = self._read_nodes(cursor, [center_id], scope).get(center_id)
            if core is None or (
                center_status and core["metadata"].get("status", "activated") != center_status
            ):
                return empty
            reached = {center_id}
            frontier = [center_id]
            for _ in range(depth):
                edges = self._read_edges(
                    cursor,
                    "(a.id IN $ids OR b.id IN $ids)",
                    {"scope": scope, "ids": frontier},
                )
                following = {edge[key] for edge in edges for key in ("from", "to")} - reached
                if not following:
                    break
                reached.update(following)
                frontier = sorted(following)
            neighbors = self._read_nodes(cursor, sorted(reached - {center_id}), scope)
            present = {center_id, *neighbors}
            edges = self._read_edges(
                cursor,
                "a.id IN $ids AND b.id IN $ids",
                {"scope": scope, "ids": sorted(present)},
            )
            return {
                "core_node": core,
                "neighbors": [neighbors[node_id] for node_id in sorted(neighbors)],
                "edges": [
                    {"source": edge["from"], "target": edge["to"], "type": edge["type"]}
                    for edge in edges
                ],
            }

    @staticmethod
    def _validate_string_list(values: list[str], name: str) -> None:
        if not isinstance(values, list) or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            raise ValueError(f"{name} must be a list of nonblank strings")

    @staticmethod
    def _node_tags(value: Any) -> set[str]:
        if value is None:
            return set()
        try:
            tags = json.loads(value) if isinstance(value, str) else value
            if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
                raise ValueError("Invalid tag list")
            return set(tags)
        except (TypeError, ValueError) as exc:
            raise GraphDBError("Invalid AGE node tags") from exc

    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Rank active, non-reasoning/non-working scoped nodes by unique tag overlap."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_string_list(tags, "tags")
        self._validate_string_list(exclude_ids, "exclude_ids")
        if type(top_k) is not int or top_k < 0:
            raise ValueError("top_k must be a nonnegative integer")
        if type(min_overlap) is not int or min_overlap < 1:
            raise ValueError("min_overlap must be a positive integer")
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        if not tags or top_k == 0:
            return []
        requested = set(tags)
        vector_column = "embedding::text" if include_embedding else "NULL"
        with self._get_connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, {vector_column} FROM ONLY {_TABLE} "
                "WHERE scope = %s AND NOT (business_id = ANY(%s))",
                (scope, exclude_ids),
            )
            ranked = []
            for row in cursor.fetchall():
                node = self._decode_node(row, scope, include_embedding)
                metadata = node["metadata"]
                if (
                    metadata.get("status", "activated") != "activated"
                    or metadata.get("type") == "reasoning"
                    or metadata.get("node_type") == "reasoning"
                    or metadata.get("memory_type") == "WorkingMemory"
                ):
                    continue
                overlap = len(requested & self._node_tags(metadata.get("tags")))
                if overlap >= min_overlap:
                    ranked.append((overlap, node))
        ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
        return [node for _, node in ranked[:top_k]]

    def _filter_scopes(
        self, user_name: str | None, knowledgebase_ids: list[str] | None
    ) -> list[str]:
        scopes = [self._scope(user_name)]
        if knowledgebase_ids is not None:
            self._validate_string_list(knowledgebase_ids, "knowledgebase_ids")
            scopes.extend(knowledgebase_ids)
        return sorted(set(scopes))

    @staticmethod
    def _filter_status(status: str | None, params: list[Any]) -> str:
        if status is None:
            return "TRUE"
        if not isinstance(status, str) or not status.strip():
            raise ValueError("status must be a nonblank string or None")
        params.append(json.dumps(status))
        return (
            "(CASE WHEN properties ? 'status'::text THEN "
            "ag_catalog.agtype_access_operator(properties, '\"status\"'::ag_catalog.agtype) "
            "ELSE '\"activated\"'::ag_catalog.agtype END) = %s::ag_catalog.agtype"
        )

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
        status: str | None = None,
    ) -> list[str]:
        """Read matching IDs in explicit scopes, ordered by scope then business ID."""
        self._ensure_open()
        scopes = self._filter_scopes(user_name, knowledgebase_ids)
        if user_name_flag is not True:
            raise ValueError("Disabling scope isolation is unsupported")
        params: list[Any] = []
        metadata_sql = self._build_metadata_conditions(filters, params)
        filter_sql = self._build_filter_where_clause(filter, params)
        status_sql = self._filter_status(status, params)
        with self._get_connection() as connection, connection.cursor() as cursor:
            cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} WHERE scope = ANY(%s) "
                f"AND ({metadata_sql}) AND ({filter_sql}) AND ({status_sql}) "
                "ORDER BY scope, business_id",
                [scopes, *params],
            )
            return [row[0] for row in cursor.fetchall()]

    def get_all_memory_items(
        self,
        scope: str,
        user_name: str | None = None,
        include_embedding: bool = False,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        """List a memory type without a hidden cap, including explicit Dream types."""
        self._ensure_open()
        scopes = self._filter_scopes(user_name, knowledgebase_ids)
        self._validate_id(scope)
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        params: list[Any] = []
        type_sql = self._build_metadata_conditions(
            [{"field": "memory_type", "value": scope}], params
        )
        filter_sql = self._build_filter_where_clause(filter, params)
        status_sql = self._filter_status(status, params)
        vector_column = "embedding::text" if include_embedding else "NULL"
        with self._get_connection() as connection, connection.cursor() as cursor:
            cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            cursor.execute(
                f"SELECT business_id, memory, properties, {vector_column}, scope FROM ONLY {_TABLE} "
                f"WHERE scope = ANY(%s) AND ({type_sql}) AND ({filter_sql}) AND ({status_sql}) "
                "ORDER BY scope, business_id",
                [scopes, *params],
            )
            nodes = []
            for row in cursor.fetchall():
                node = self._decode_node(row[:4], row[4], include_embedding)
                if len(scopes) > 1:
                    node["metadata"]["user_name"] = row[4]
                nodes.append(node)
            return nodes

    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """Atomically hard-delete one selector in explicit or default scopes."""
        self._ensure_open()
        if writable_cube_ids is None:
            scopes = [self._scope(None)]
        else:
            self._validate_string_list(writable_cube_ids, "writable_cube_ids")
            scopes = sorted(set(writable_cube_ids))
        for name, values in (("memory_ids", memory_ids), ("file_ids", file_ids)):
            if values is not None:
                self._validate_string_list(values, name)
        params: list[Any] = []
        predicate = self._build_filter_where_clause(filter, params)
        modes = sum(bool(value) for value in (memory_ids, file_ids, filter))
        if modes > 1:
            raise ValueError("Select only one of memory_ids, file_ids or filter")
        if memory_ids:
            predicate = self._build_metadata_conditions(
                [{"field": "id", "op": "in", "value": memory_ids}], params
            )
        elif file_ids:
            predicate = self._build_metadata_conditions(
                [{"field": "file_ids", "op": "contains", "value": file_ids}], params
            )
        if not modes or not scopes:
            return 0
        with self._get_connection() as connection, connection.cursor() as cursor:
            cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            cursor.execute("SELECT pg_advisory_xact_lock(621503, 2)")
            cursor.execute(
                f"SELECT scope, business_id FROM ONLY {_TABLE} WHERE scope = ANY(%s) "
                f"AND ({predicate}) ORDER BY scope, business_id FOR UPDATE",
                [scopes, *params],
            )
            selected = cursor.fetchall()
            deleted = 0
            for owner, node_id in selected:
                self._cypher(
                    cursor,
                    "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
                    "(a.id = $id AND a.user_name = $scope) OR "
                    "(b.id = $id AND b.user_name = $scope) DELETE r",
                    {"id": node_id, "scope": owner},
                )
                cursor.execute(
                    f"DELETE FROM ONLY {_TABLE} WHERE scope = %s AND business_id = %s",
                    (owner, node_id),
                )
                deleted += cursor.rowcount
            return deleted

    def _field_expr(self, path: list[str], params: list[Any]) -> str:
        params.append(_encode_filter_value(path[0]))
        root = "ag_catalog.agtype_access_operator(properties, %s::ag_catalog.agtype)"
        if len(path) == 1:
            return root
        # Serialized info strings are preserved by storage, but are not maps.
        params.extend([_encode_filter_value(path[0]), _encode_filter_value(path[1])])
        return (
            f"(CASE WHEN left(ag_catalog.agtype_out({root})::text, 1) = '{{' "
            f"THEN ag_catalog.agtype_access_operator({root}, %s::ag_catalog.agtype) END)"
        )

    def _text_field_expr(self, path: list[str], params: list[Any]) -> str:
        kind = self._field_expr(path, params)
        value = self._field_expr(path, params)
        return (
            f"(CASE WHEN left(ag_catalog.agtype_out({kind})::text, 1) = '\"' "
            f"THEN {value}::text END)"
        )

    def _build_equal_condition(self, path: list[str], value: Any, params: list[Any]) -> str:
        # AGE access returns SQL NULL for both missing fields and JSON null.
        # Containment distinguishes them without converting AGE maps to JSON.
        if value is None:
            nested = value
            for key in reversed(path):
                nested = {key: nested}
            params.append(_encode_filter_value(nested))
            return "(properties @> %s::ag_catalog.agtype)"
        expr = self._field_expr(path, params)
        params.append(_encode_filter_value(value))
        return f"({expr} = %s::ag_catalog.agtype)"

    def _build_filter_condition(self, field: str, op: str, value: Any, params: list[Any]) -> str:
        if not isinstance(field, str) or not re.fullmatch(
            r"(?:info\.)?[A-Za-z_][A-Za-z0-9_]*", field
        ):
            raise ValueError("Invalid filter field")
        if not isinstance(op, str):
            raise ValueError("Invalid filter operator")
        path = field.split(".")
        _encode_filter_value(value)
        operator = _OPERATORS.get(op, op)
        temporal = path[-1].endswith("_at") or path[-1] == "delete_time"
        if operator in {">", ">=", "<", "<="} or (operator == "=" and temporal):
            if temporal:
                try:
                    if not isinstance(value, str):
                        raise ValueError("Time filter must be an ISO date/time string")
                    instant = datetime.fromisoformat(value)
                    if instant.tzinfo is None:
                        instant = instant.replace(tzinfo=timezone.utc)
                except ValueError as exc:
                    raise ValueError("Invalid ISO date/time filter") from exc
                expr = f"{self._text_field_expr(path, params)}::timestamptz"
                params.append(instant.isoformat())
                return f"({expr} {operator} %s::timestamptz)"
            try:
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError("Numeric filter requires a finite number")
            except OverflowError as exc:
                raise ValueError("Numeric filter is too large") from exc
            kind = self._field_expr(path, params)
            numeric = self._field_expr(path, params)
            params.append(value)
            return (
                f"((CASE WHEN ag_catalog.agtype_out({kind})::text ~ '^[-.0-9]' "
                f"THEN ag_catalog.agtype_out({numeric})::text::numeric END) {operator} %s)"
            )
        if operator == "=":
            return self._build_equal_condition(path, value, params)
        if operator in {"in", "contains", "all"}:
            if operator == "in" and not isinstance(value, list):
                raise ValueError("in requires a list")
            values = value if isinstance(value, list) else [value]
            if operator == "all":
                expr = self._field_expr(path, params)
                params.append(_encode_filter_value(values))
                return f"({expr} @> %s::ag_catalog.agtype)"
            if not values:
                return "FALSE"
            array = operator == "contains" or path[-1] in _ARRAY_FIELDS
            parts = []
            for item in values:
                if array:
                    expr = self._field_expr(path, params)
                    params.append(_encode_filter_value([item]))
                    parts.append(f"{expr} @> %s::ag_catalog.agtype")
                else:
                    parts.append(self._build_equal_condition(path, item, params))
            return "(" + " OR ".join(parts) + ")"
        if operator in {"like", "nolike", "starts_with", "ends_with"}:
            if not isinstance(value, str):
                raise ValueError("String filter requires a string")
            escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = ("" if operator == "starts_with" else "%") + escaped
            pattern += "" if operator == "ends_with" else "%"
            expr = self._text_field_expr(path, params)
            params.append(pattern)
            comparison = "NOT LIKE" if operator == "nolike" else "LIKE"
            return f"({expr} {comparison} %s)"
        raise ValueError(f"Unsupported filter operator: {op}")

    def _build_metadata_conditions(self, filters: list[dict[str, Any]], params: list[Any]) -> str:
        """Compile the existing field/op/value list as an AND expression."""
        if not isinstance(filters, list):
            raise ValueError("filters must be a list")
        parts = []
        for item in filters:
            if (
                not isinstance(item, dict)
                or not {"field", "value"} <= item.keys()
                or (item.keys() - {"field", "op", "value"})
            ):
                raise ValueError("Invalid metadata filter")
            parts.append(
                self._build_filter_condition(
                    item["field"], item.get("op", "="), item["value"], params
                )
            )
        return " AND ".join(parts) or "TRUE"

    @staticmethod
    def parse_filter(filter_dict: dict | None = None) -> dict | None:
        """Route business fields to info.*, as in PostgreSQL and PolarDB."""
        if filter_dict is None:
            return None
        if not isinstance(filter_dict, dict):
            raise ValueError("filter must be an object")
        normalized = {}
        for key, value in filter_dict.items():
            if not isinstance(key, str):
                raise ValueError("Invalid filter field")
            if key in ("and", "or"):
                if not isinstance(value, list) or not value:
                    raise ValueError("and/or requires a nonempty list")
                normalized[key] = [OpenGaussGraphDB.parse_filter(item) for item in value]
            else:
                field = key if key in _ROOT_FIELDS or key.startswith("info.") else f"info.{key}"
                normalized[field] = value
        return normalized

    def _build_single_filter_condition(
        self, condition_dict: dict[str, Any], params: list[Any]
    ) -> str:
        """Build parameter-bound predicates for one business condition object."""
        parts = []
        for field, value in condition_dict.items():
            if isinstance(value, dict):
                if not value:
                    raise ValueError("Filter operators cannot be empty")
                parts.extend(
                    self._build_filter_condition(field, op, val, params)
                    for op, val in value.items()
                )
            else:
                op = "all" if field in _ARRAY_FIELDS else "="
                parts.append(self._build_filter_condition(field, op, value, params))
        return " AND ".join(parts)

    def _build_filter_where_clause(
        self, filter_dict: dict | None, params: list[Any], nested: bool = False
    ) -> str:
        """Build a scoped query's business predicate without ignoring invalid children."""
        condition = self.parse_filter(filter_dict)
        if nested and not condition:
            raise ValueError("Nested filter conditions cannot be empty")
        if condition is None:
            return "TRUE"
        parts = []
        for field, value in condition.items():
            if field in ("and", "or"):
                children = [
                    self._build_filter_where_clause(child, params, nested=True) for child in value
                ]
                parts.append("(" + f" {field.upper()} ".join(children) + ")")
            else:
                parts.append(self._build_single_filter_condition({field: value}, params))
        return "(" + " AND ".join(parts) + ")" if parts else "TRUE"
