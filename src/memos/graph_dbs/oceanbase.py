"""OceanBase / seekdb graph backend for MemOS.

Ported from the PostgreSQL + pgvector backend (``graph_dbs/postgres.py``): graph
data is stored as relational tables (nodes + edges) with JSON properties and a
``VECTOR`` embedding column, all in a single MySQL-compatible database.

Access goes through the ``pymysql`` driver over seekdb / OceanBase's
MySQL-compatible protocol. All parameterized DML/DQL uses
``cursor.execute(sql, params)`` (MySQL ``%s`` paramstyle) so user input is bound,
never string-concatenated.

Tables (``{prefix}`` defaults to ``memos_graph``):
- ``{prefix}_nodes``: memory nodes with JSON properties and vector embeddings
- ``{prefix}_edges``: relationships between memory nodes
"""

import json
import queue
import re
import threading

from contextlib import contextmanager, suppress
from datetime import datetime
from typing import Any, Literal

from memos.configs.graph_db import OceanBaseGraphDBConfig
from memos.dependency import require_python_package
from memos.exceptions import GraphDBError
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)

_SAFE_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class _PyMySQLConnectionPool:
    """Minimal thread-safe PyMySQL connection pool.

    PyMySQL's DB-API ``threadsafety`` is 1: a connection must not be shared
    across threads. Each operation therefore borrows a dedicated connection and
    returns it afterwards. Connections are created lazily up to ``maxconn``;
    ``acquire()`` blocks once the pool is exhausted until a connection is freed.
    """

    def __init__(self, connect_fn, maxconn: int):
        self._connect_fn = connect_fn
        self._maxconn = max(1, int(maxconn))
        self._idle: queue.LifoQueue = queue.LifoQueue(maxsize=self._maxconn)
        self._lock = threading.Lock()
        self._created = 0
        self._closed = False

    def acquire(self):
        if self._closed:
            raise GraphDBError("Connection pool is closed")
        # Decide whether to create a new connection while holding the lock, but run
        # the (potentially slow) connect outside the lock so it never blocks peers.
        with self._lock:
            should_create = self._created < self._maxconn and self._idle.empty()
            if should_create:
                self._created += 1
        if should_create:
            try:
                return self._connect_fn()
            except Exception:
                with self._lock:
                    self._created -= 1
                raise
        return self._idle.get()

    def discard(self, conn) -> None:
        """Permanently drop a (likely broken) connection and free its pool slot."""
        if conn is not None:
            with suppress(Exception):
                conn.close()
        with self._lock:
            if self._created > 0:
                self._created -= 1

    def release(self, conn) -> None:
        if conn is None:
            return
        if self._closed:
            with suppress(Exception):
                conn.close()
            return
        try:
            self._idle.put_nowait(conn)
        except queue.Full:
            with suppress(Exception):
                conn.close()

    def close(self) -> None:
        self._closed = True
        while True:
            try:
                conn = self._idle.get_nowait()
            except queue.Empty:
                break
            with suppress(Exception):
                conn.close()


def _prepare_node_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Ensure metadata has proper datetime fields and normalized types."""
    now = datetime.utcnow().isoformat()
    metadata.setdefault("created_at", now)
    metadata.setdefault("updated_at", now)

    embedding = metadata.get("embedding")
    if embedding and isinstance(embedding, list):
        metadata["embedding"] = [float(x) for x in embedding]

    return metadata


def _normalize_dt(value: Any) -> str:
    """Normalize an ISO datetime string to a MySQL-compatible ``DATETIME`` literal."""
    if value is None:
        value = datetime.utcnow().isoformat()
    text = str(value).replace("T", " ").strip()
    # Strip the timezone suffix (+HH:MM / -HH:MM / Z) without touching the date's
    # own hyphens: only the time part after the first space can carry a tz.
    if " " in text:
        date_part, time_part = text.split(" ", 1)
        time_part = re.split(r"[Z+\-]", time_part, maxsplit=1)[0].strip()
        text = f"{date_part} {time_part}"
    return text.strip()


class OceanBaseGraphDB(BaseGraphDB):
    """OceanBase / seekdb implementation of a graph memory store (via pymysql).

    seekdb / OceanBase expose a MySQL-compatible protocol; pyseekdb's Collection
    client does not run arbitrary SQL, so relational graph operations use the
    ``pymysql`` driver directly (already a core MemOS dependency).
    """

    @require_python_package(
        import_name="pymysql",
        install_command="pip install pymysql",
        install_link="https://pypi.org/project/pymysql/",
    )
    def __init__(self, config: OceanBaseGraphDBConfig):
        """Open the MySQL-protocol connection and ensure the schema exists."""
        import pymysql

        self._pymysql = pymysql
        self.config = config
        self.user_name = config.user_name
        self.dim = config.embedding_dimension
        self.nodes_table = f"{config.table_prefix}_nodes"
        self.edges_table = f"{config.table_prefix}_edges"
        self._closed = False
        self._conn_kwargs = {
            "host": config.host,
            "port": config.port,
            "user": config.user,
            "password": config.password,
            "database": config.db_name,
            "autocommit": True,
            "charset": "utf8mb4",
        }
        self._pool = _PyMySQLConnectionPool(
            connect_fn=lambda: self._pymysql.connect(**self._conn_kwargs),
            maxconn=config.maxconn,
        )

        logger.info(
            "Connecting to OceanBase/seekdb: %s:%s/%s",
            config.host,
            config.port,
            config.db_name,
        )
        self._init_schema()

    # =========================================================================
    # Connection / execution helpers
    # =========================================================================

    def _ensure_open(self) -> None:
        if self._closed:
            raise GraphDBError("OceanBaseGraphDB connection is closed")

    def _acquire_live(self):
        """Get a live connection from the pool.

        If the borrowed connection's socket is dead, discard it through the pool
        (so ``_created`` stays accurate) and acquire a fresh one, avoiding the
        counter drift that a raw out-of-band reconnect would cause.
        """
        conn = self._pool.acquire()
        try:
            conn.ping(reconnect=True)
            return conn
        except Exception:
            self._pool.discard(conn)
            return self._pool.acquire()

    @contextmanager
    def _borrow(self):
        """Borrow a single connection for one auto-committed operation."""
        self._ensure_open()
        conn = self._acquire_live()
        try:
            yield conn
        finally:
            self._pool.release(conn)

    @contextmanager
    def _transaction(self):
        """Borrow a connection and run several statements as one atomic unit."""
        self._ensure_open()
        conn = self._acquire_live()
        cur = None
        try:
            cur = conn.cursor()
            conn.begin()
            try:
                yield cur
                conn.commit()
            except Exception:
                with suppress(Exception):
                    conn.rollback()
                raise
        finally:
            if cur is not None:
                with suppress(Exception):
                    cur.close()
            self._pool.release(conn)

    def _query(self, sql: str, params: tuple | list | None = None) -> list[tuple]:
        with self._borrow() as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql, tuple(params) if params else ())
                return list(cur.fetchall())
            finally:
                with suppress(Exception):
                    cur.close()

    def _query_one(self, sql: str, params: tuple | list | None = None) -> tuple | None:
        with self._borrow() as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql, tuple(params) if params else ())
                return cur.fetchone()
            finally:
                with suppress(Exception):
                    cur.close()

    def _execute(self, sql: str, params: tuple | list | None = None) -> int:
        with self._borrow() as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql, tuple(params) if params else ())
                rowcount = cur.rowcount if cur.rowcount is not None else 0
                with suppress(Exception):
                    conn.commit()
                return rowcount
            finally:
                with suppress(Exception):
                    cur.close()

    @staticmethod
    def _vec_literal(vector: list[float]) -> str:
        """Render a vector as an OceanBase vector literal string."""
        return "[" + ",".join(str(float(x)) for x in vector) + "]"

    @staticmethod
    def _placeholders(values: list[Any]) -> str:
        return ", ".join(["%s"] * len(values))

    def _init_schema(self) -> None:
        """Create node/edge tables and indexes if they don't exist."""
        self._execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.nodes_table} (
                id VARCHAR(255) PRIMARY KEY,
                memory LONGTEXT,
                properties JSON,
                embedding VECTOR({self.dim}),
                user_name VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self._execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.edges_table} (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                source_id VARCHAR(255) NOT NULL,
                target_id VARCHAR(255) NOT NULL,
                edge_type VARCHAR(255) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_edge (source_id, target_id, edge_type)
            )
            """
        )
        for ddl in (
            f"CREATE INDEX idx_{self.config.table_prefix}_nodes_user "
            f"ON {self.nodes_table}(user_name)",
            f"CREATE INDEX idx_{self.config.table_prefix}_edges_source "
            f"ON {self.edges_table}(source_id)",
            f"CREATE INDEX idx_{self.config.table_prefix}_edges_target "
            f"ON {self.edges_table}(target_id)",
            f"CREATE VECTOR INDEX idx_{self.config.table_prefix}_nodes_embedding "
            f"ON {self.nodes_table}(embedding) WITH (distance=cosine, type=hnsw)",
        ):
            with suppress(Exception):
                self._execute(ddl)
        logger.info(
            "OceanBase graph schema initialized (%s, %s)", self.nodes_table, self.edges_table
        )

    # =========================================================================
    # Node management
    # =========================================================================

    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """Remove all memories of a type except the latest ``keep_latest`` entries."""
        user_name = user_name or self.user_name
        keep_latest = int(keep_latest)

        with self._transaction() as cur:
            cur.execute(
                f"""
                SELECT id FROM {self.nodes_table}
                WHERE user_name = %s
                  AND JSON_UNQUOTE(JSON_EXTRACT(properties, '$.memory_type')) = %s
                ORDER BY updated_at DESC
                LIMIT %s, 18446744073709551615
                """,
                (user_name, memory_type, keep_latest),
            )
            ids_to_delete = [row[0] for row in cur.fetchall()]
            if not ids_to_delete:
                return

            ph = self._placeholders(ids_to_delete)
            cur.execute(
                f"DELETE FROM {self.edges_table} WHERE source_id IN ({ph}) OR target_id IN ({ph})",
                (*ids_to_delete, *ids_to_delete),
            )
            cur.execute(
                f"DELETE FROM {self.nodes_table} WHERE id IN ({ph})",
                tuple(ids_to_delete),
            )
        logger.info(
            "Removed %s oldest %s memories for user %s",
            len(ids_to_delete),
            memory_type,
            user_name,
        )

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Add (or upsert) a memory node."""
        user_name = user_name or self.user_name
        metadata = _prepare_node_metadata(metadata.copy())

        embedding = metadata.pop("embedding", None)
        created_at = _normalize_dt(metadata.pop("created_at", None))
        updated_at = _normalize_dt(metadata.pop("updated_at", None))

        if metadata.get("sources"):
            metadata["sources"] = [
                json.dumps(s) if not isinstance(s, str) else s for s in metadata["sources"]
            ]

        if embedding:
            self._execute(
                f"""
                INSERT INTO {self.nodes_table}
                    (id, memory, properties, embedding, user_name, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    memory = VALUES(memory),
                    properties = VALUES(properties),
                    embedding = VALUES(embedding),
                    updated_at = VALUES(updated_at)
                """,
                (
                    id,
                    memory,
                    json.dumps(metadata),
                    self._vec_literal(embedding),
                    user_name,
                    created_at,
                    updated_at,
                ),
            )
        else:
            self._execute(
                f"""
                INSERT INTO {self.nodes_table}
                    (id, memory, properties, user_name, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    memory = VALUES(memory),
                    properties = VALUES(properties),
                    updated_at = VALUES(updated_at)
                """,
                (id, memory, json.dumps(metadata), user_name, created_at, updated_at),
            )

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        """Batch add memory nodes."""
        for node in nodes:
            self.add_node(
                id=node["id"],
                memory=node["memory"],
                metadata=node.get("metadata", {}),
                user_name=user_name,
            )

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """Update node fields (merging into JSON properties)."""
        user_name = user_name or self.user_name
        if not fields:
            return

        current = self.get_node(id, user_name=user_name)
        if not current:
            return

        props = current.get("metadata", {}).copy()
        fields = fields.copy()
        embedding = fields.pop("embedding", None)
        memory = fields.pop("memory", current.get("memory", ""))
        props.update(fields)
        props.pop("embedding", None)
        props["updated_at"] = datetime.utcnow().isoformat()
        props.pop("created_at", None)

        if embedding:
            self._execute(
                f"""
                UPDATE {self.nodes_table}
                SET memory = %s, properties = %s, embedding = %s, updated_at = NOW()
                WHERE id = %s AND user_name = %s
                """,
                (memory, json.dumps(props), self._vec_literal(embedding), id, user_name),
            )
        else:
            self._execute(
                f"""
                UPDATE {self.nodes_table}
                SET memory = %s, properties = %s, updated_at = NOW()
                WHERE id = %s AND user_name = %s
                """,
                (memory, json.dumps(props), id, user_name),
            )

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """Delete a node and its incident edges (atomically)."""
        user_name = user_name or self.user_name
        with self._transaction() as cur:
            cur.execute(
                f"DELETE FROM {self.edges_table} WHERE source_id = %s OR target_id = %s",
                (id, id),
            )
            cur.execute(
                f"DELETE FROM {self.nodes_table} WHERE id = %s AND user_name = %s",
                (id, user_name),
            )

    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        """Get a single node by ID."""
        user_name = kwargs.get("user_name") or self.user_name
        cols = "id, memory, properties, created_at, updated_at"
        if include_embedding:
            cols += ", embedding"
        row = self._query_one(
            f"SELECT {cols} FROM {self.nodes_table} WHERE id = %s AND user_name = %s",
            (id, user_name),
        )
        if not row:
            return None
        return self._parse_row(row, include_embedding)

    def get_nodes(
        self, ids: list, include_embedding: bool = False, **kwargs
    ) -> list[dict[str, Any]]:
        """Get multiple nodes by IDs."""
        if not ids:
            return []
        user_name = kwargs.get("user_name") or self.user_name
        cols = "id, memory, properties, created_at, updated_at"
        if include_embedding:
            cols += ", embedding"
        ph = self._placeholders(ids)
        rows = self._query(
            f"SELECT {cols} FROM {self.nodes_table} WHERE id IN ({ph}) AND user_name = %s",
            (*ids, user_name),
        )
        return [self._parse_row(row, include_embedding) for row in rows]

    def _parse_row(self, row, include_embedding: bool = False) -> dict[str, Any]:
        """Parse a database row into a node dict."""
        raw_props = row[2]
        props = raw_props if isinstance(raw_props, dict) else json.loads(raw_props or "{}")
        props["created_at"] = self._iso(row[3])
        props["updated_at"] = self._iso(row[4])
        result = {
            "id": row[0],
            "memory": row[1] or "",
            "metadata": props,
        }
        if include_embedding and len(row) > 5:
            result["metadata"]["embedding"] = self._parse_embedding(row[5])
        return result

    @staticmethod
    def _iso(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

    @staticmethod
    def _parse_embedding(value: Any) -> Any:
        if value is None or isinstance(value, list):
            return value
        text = str(value).strip().strip("[]")
        if not text:
            return []
        try:
            return [float(x) for x in text.split(",")]
        except ValueError:
            return value

    # =========================================================================
    # Metadata filter building (MySQL/OceanBase JSON dialect)
    # =========================================================================

    @staticmethod
    def _is_safe_field_name(field: str) -> bool:
        return bool(_SAFE_FIELD_RE.match(field))

    def _field_expr(self, key: str) -> tuple[str, str]:
        """Build (text_expr, json_expr) SQL fragments for a filter key."""
        direct_columns = {"id", "memory", "user_name", "created_at", "updated_at"}
        if key in direct_columns:
            return key, key

        if key.startswith("info."):
            sub_key = key[5:]
            if not self._is_safe_field_name(sub_key):
                raise ValueError(f"Invalid filter field: {key}")
            path = f"$.info.{sub_key}"
        else:
            if not self._is_safe_field_name(key):
                raise ValueError(f"Invalid filter field: {key}")
            path = f"$.{key}"

        text_expr = f"JSON_UNQUOTE(JSON_EXTRACT(properties, '{path}'))"
        json_expr = f"JSON_EXTRACT(properties, '{path}')"
        return text_expr, json_expr

    def _build_single_filter_condition(
        self, condition_dict: dict[str, Any], params: list[Any]
    ) -> str | None:
        """Build SQL for a single filter condition dict."""
        if not condition_dict:
            return None

        array_fields = {"tags", "sources", "file_ids"}
        timestamp_fields = {"created_at", "updated_at"}
        parts: list[str] = []

        for key, value in condition_dict.items():
            text_expr, json_expr = self._field_expr(key)
            raw_key = key[5:] if key.startswith("info.") else key

            if isinstance(value, dict):
                for op, op_value in value.items():
                    if op in ("gt", "lt", "gte", "lte"):
                        op_map = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
                        sql_op = op_map[op]
                        if raw_key in timestamp_fields or raw_key.endswith("_at"):
                            parts.append(
                                f"CAST({text_expr} AS DATETIME) {sql_op} CAST(%s AS DATETIME)"
                            )
                            params.append(op_value)
                        else:
                            parts.append(
                                f"CAST(NULLIF({text_expr}, '') AS DECIMAL(38,10)) {sql_op} %s"
                            )
                            params.append(op_value)
                    elif op == "contains":
                        if raw_key in array_fields:
                            parts.append(f"JSON_CONTAINS({json_expr}, %s)")
                            params.append(json.dumps(op_value))
                        else:
                            parts.append(f"{text_expr} LIKE %s")
                            params.append(f"%{op_value}%")
                    elif op == "in":
                        if not isinstance(op_value, list):
                            raise ValueError(
                                f"in operator expects list for '{key}', got {type(op_value).__name__}"
                            )
                        if raw_key in array_fields:
                            parts.append(f"JSON_OVERLAPS({json_expr}, %s)")
                            params.append(json.dumps([str(v) for v in op_value]))
                        else:
                            ph = self._placeholders(op_value)
                            parts.append(f"{text_expr} IN ({ph})")
                            params.extend([str(v) for v in op_value])
                    elif op == "like":
                        parts.append(f"{text_expr} LIKE %s")
                        params.append(f"%{op_value}%")
                    else:
                        raise ValueError(f"Unsupported filter operator: {op}")
            elif raw_key in array_fields:
                if isinstance(value, list):
                    parts.append(f"JSON_CONTAINS({json_expr}, %s)")
                    params.append(json.dumps(value))
                else:
                    parts.append(f"JSON_CONTAINS({json_expr}, %s)")
                    params.append(json.dumps([value]))
            else:
                parts.append(f"{text_expr} = %s")
                params.append(str(value))

        if not parts:
            return None
        return " AND ".join(parts)

    def _build_filter_where_clause(self, filter_dict: dict[str, Any], params: list[Any]) -> str:
        """Build a SQL WHERE fragment from a filter dict."""
        if not filter_dict:
            return ""

        if "and" in filter_dict:
            and_conditions = filter_dict.get("and")
            if not isinstance(and_conditions, list):
                raise ValueError("Invalid filter format: 'and' must be a list")
            parts: list[str] = []
            for cond in and_conditions:
                if isinstance(cond, dict):
                    cond_sql = self._build_single_filter_condition(cond, params)
                    if cond_sql:
                        parts.append(f"({cond_sql})")
            return " AND ".join(parts)

        if "or" in filter_dict:
            or_conditions = filter_dict.get("or")
            if not isinstance(or_conditions, list):
                raise ValueError("Invalid filter format: 'or' must be a list")
            parts = []
            for cond in or_conditions:
                if isinstance(cond, dict):
                    cond_sql = self._build_single_filter_condition(cond, params)
                    if cond_sql:
                        parts.append(f"({cond_sql})")
            return f"({' OR '.join(parts)})" if parts else ""

        cond_sql = self._build_single_filter_condition(filter_dict, params)
        return cond_sql or ""

    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """Delete nodes by memory_ids, file_ids, or filter (and clean up edges)."""
        where_conditions: list[str] = []
        params: list[Any] = []

        if memory_ids:
            ph = self._placeholders(memory_ids)
            where_conditions.append(f"id IN ({ph})")
            params.extend(memory_ids)

        if file_ids:
            file_conditions: list[str] = []
            for file_id in file_ids:
                file_conditions.append("JSON_CONTAINS(JSON_EXTRACT(properties, '$.file_ids'), %s)")
                params.append(json.dumps([file_id]))
            if file_conditions:
                where_conditions.append(f"({' OR '.join(file_conditions)})")

        if filter:
            filter_where = self._build_filter_where_clause(filter, params)
            if filter_where:
                where_conditions.append(f"({filter_where})")

        if not where_conditions:
            logger.warning("[delete_node_by_prams] No memory_ids, file_ids, or filter provided")
            return 0

        if writable_cube_ids:
            ph = self._placeholders(writable_cube_ids)
            where_conditions.append(f"user_name IN ({ph})")
            params.extend(writable_cube_ids)

        where_clause = " AND ".join(where_conditions)

        with self._transaction() as cur:
            cur.execute(f"SELECT id FROM {self.nodes_table} WHERE {where_clause}", params)
            ids = [row[0] for row in cur.fetchall()]
            if not ids:
                return 0

            ph = self._placeholders(ids)
            cur.execute(
                f"DELETE FROM {self.edges_table} WHERE source_id IN ({ph}) OR target_id IN ({ph})",
                (*ids, *ids),
            )
            cur.execute(
                f"DELETE FROM {self.nodes_table} WHERE id IN ({ph})",
                tuple(ids),
            )
            deleted = cur.rowcount if cur.rowcount is not None else 0
        logger.info("[delete_node_by_prams] Deleted %s nodes", deleted)
        return deleted

    # =========================================================================
    # Edge management
    # =========================================================================

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Create an edge between nodes (idempotent)."""
        self._execute(
            f"""
            INSERT INTO {self.edges_table} (source_id, target_id, edge_type)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE edge_type = VALUES(edge_type)
            """,
            (source_id, target_id, type),
        )

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Delete an edge."""
        self._execute(
            f"""
            DELETE FROM {self.edges_table}
            WHERE source_id = %s AND target_id = %s AND edge_type = %s
            """,
            (source_id, target_id, type),
        )

    def edge_exists(self, source_id: str, target_id: str, type: str) -> bool:
        """Check if an edge exists."""
        row = self._query_one(
            f"""
            SELECT 1 FROM {self.edges_table}
            WHERE source_id = %s AND target_id = %s AND edge_type = %s
            LIMIT 1
            """,
            (source_id, target_id, type),
        )
        return row is not None

    # =========================================================================
    # Graph queries
    # =========================================================================

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """Get neighboring node IDs by relationship type and direction."""
        if direction == "out":
            rows = self._query(
                f"SELECT target_id FROM {self.edges_table} WHERE source_id = %s AND edge_type = %s",
                (id, type),
            )
        elif direction == "in":
            rows = self._query(
                f"SELECT source_id FROM {self.edges_table} WHERE target_id = %s AND edge_type = %s",
                (id, type),
            )
        else:
            rows = self._query(
                f"""
                SELECT target_id FROM {self.edges_table} WHERE source_id = %s AND edge_type = %s
                UNION
                SELECT source_id FROM {self.edges_table} WHERE target_id = %s AND edge_type = %s
                """,
                (id, type, id, type),
            )
        return [row[0] for row in rows]

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """Get a shortest path from source to target via a recursive CTE.

        Mirrors the PostgreSQL backend, which accumulates the path in a native
        array. OceanBase/MySQL have no array type, so a JSON array is used
        instead: ``JSON_ARRAY_APPEND`` grows the path per element (no delimiter,
        so node ids may contain any character) and ``JSON_CONTAINS`` guards
        against revisiting a node (cycle guard).
        """
        if source_id == target_id:
            return [source_id]

        row = self._query_one(
            f"""
            WITH RECURSIVE paths AS (
                SELECT
                    target_id,
                    JSON_ARRAY(source_id) AS nodes,
                    1 AS depth
                FROM {self.edges_table}
                WHERE source_id = %s
                UNION ALL
                SELECT
                    e.target_id,
                    JSON_ARRAY_APPEND(p.nodes, '$', e.source_id),
                    p.depth + 1
                FROM {self.edges_table} e
                JOIN paths p ON e.source_id = p.target_id
                WHERE p.depth < %s
                  AND NOT JSON_CONTAINS(p.nodes, JSON_QUOTE(e.source_id))
            )
            SELECT JSON_ARRAY_APPEND(nodes, '$', target_id) AS full_path
            FROM paths
            WHERE target_id = %s
            ORDER BY depth
            LIMIT 1
            """,
            (source_id, max_depth, target_id),
        )
        if not row or not row[0]:
            return []
        full_path = row[0]
        return full_path if isinstance(full_path, list) else json.loads(full_path)

    def get_subgraph(self, center_id: str, depth: int = 2) -> list[str]:
        """Get the node IDs of the subgraph around a center node via a recursive CTE.

        seekdb/OceanBase do not support ``UNION`` (DISTINCT) inside a recursive
        CTE, so ``UNION ALL`` is used together with a JSON-array visited-set to
        guard against cycles (mirroring ``get_path``); the outer
        ``SELECT DISTINCT`` collapses the duplicate rows that ``UNION ALL`` keeps.
        """
        rows = self._query(
            f"""
            WITH RECURSIVE subgraph AS (
                SELECT
                    CAST(%s AS CHAR(255)) AS node_id,
                    0 AS level,
                    JSON_ARRAY(%s) AS visited
                UNION ALL
                SELECT
                    CASE WHEN e.source_id = s.node_id THEN e.target_id ELSE e.source_id END,
                    s.level + 1,
                    JSON_ARRAY_APPEND(
                        s.visited, '$',
                        CASE WHEN e.source_id = s.node_id THEN e.target_id ELSE e.source_id END
                    )
                FROM subgraph s
                JOIN {self.edges_table} e
                    ON (e.source_id = s.node_id OR e.target_id = s.node_id)
                WHERE s.level < %s
                  AND NOT JSON_CONTAINS(
                        s.visited,
                        JSON_QUOTE(
                            CASE WHEN e.source_id = s.node_id THEN e.target_id ELSE e.source_id END
                        )
                  )
            )
            SELECT DISTINCT node_id FROM subgraph
            """,
            (center_id, center_id, depth),
        )
        return [row[0] for row in rows]

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """Get the ordered context chain following a relationship type."""
        return self.get_neighbors(id, type, "out")

    # =========================================================================
    # Search operations
    # =========================================================================

    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Search nodes by vector similarity, applying tenant filters before ranking."""
        user_name = user_name or self.user_name

        conditions = ["embedding IS NOT NULL"]
        params: list[Any] = []

        if user_name:
            conditions.append("user_name = %s")
            params.append(user_name)

        if scope:
            conditions.append("JSON_UNQUOTE(JSON_EXTRACT(properties, '$.memory_type')) = %s")
            params.append(scope)

        if status:
            conditions.append("JSON_UNQUOTE(JSON_EXTRACT(properties, '$.status')) = %s")
            params.append(status)
        else:
            conditions.append(
                "(JSON_UNQUOTE(JSON_EXTRACT(properties, '$.status')) = 'activated' "
                "OR JSON_EXTRACT(properties, '$.status') IS NULL)"
            )

        if search_filter:
            for k, v in search_filter.items():
                if not self._is_safe_field_name(k):
                    raise ValueError(f"Invalid search_filter field: {k}")
                conditions.append(f"JSON_UNQUOTE(JSON_EXTRACT(properties, '$.{k}')) = %s")
                params.append(str(v))

        where_clause = " AND ".join(conditions)
        vec = self._vec_literal(vector)

        rows = self._query(
            f"""
            SELECT id, 1 - cosine_distance(embedding, %s) AS score
            FROM {self.nodes_table}
            WHERE {where_clause}
            ORDER BY cosine_distance(embedding, %s)
            LIMIT %s
            """,
            (vec, *params, vec, top_k),
        )

        results = []
        for row in rows:
            score = float(row[1])
            if threshold is None or score >= threshold:
                results.append({"id": row[0], "score": score})
        return results

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        status: str | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
    ) -> list[str]:
        """Get node IDs matching metadata filters."""
        user_name = user_name or self.user_name

        conditions: list[str] = []
        params: list[Any] = []

        if user_name_flag and user_name:
            conditions.append("user_name = %s")
            params.append(user_name)

        if status:
            conditions.append("JSON_UNQUOTE(JSON_EXTRACT(properties, '$.status')) = %s")
            params.append(status)

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]
            if not self._is_safe_field_name(field):
                raise ValueError(f"Invalid filter field: {field}")
            text_expr = f"JSON_UNQUOTE(JSON_EXTRACT(properties, '$.{field}'))"
            json_expr = f"JSON_EXTRACT(properties, '$.{field}')"

            if op == "=":
                conditions.append(f"{text_expr} = %s")
                params.append(str(value))
            elif op == "in":
                ph = self._placeholders(value)
                conditions.append(f"{text_expr} IN ({ph})")
                params.extend([str(v) for v in value])
            elif op in (">", ">=", "<", "<="):
                conditions.append(f"CAST({text_expr} AS DECIMAL(38,10)) {op} %s")
                params.append(value)
            elif op == "contains":
                conditions.append(f"JSON_CONTAINS({json_expr}, %s)")
                params.append(json.dumps([value]))

        where_clause = " AND ".join(conditions) if conditions else "TRUE"

        rows = self._query(f"SELECT id FROM {self.nodes_table} WHERE {where_clause}", params)
        return [row[0] for row in rows]

    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        status: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Get all memory items of a specific memory_type."""
        user_name = kwargs.get("user_name") or self.user_name

        conditions = [
            "JSON_UNQUOTE(JSON_EXTRACT(properties, '$.memory_type')) = %s",
            "user_name = %s",
        ]
        params: list[Any] = [scope, user_name]

        if status:
            conditions.append("JSON_UNQUOTE(JSON_EXTRACT(properties, '$.status')) = %s")
            params.append(status)

        where_clause = " AND ".join(conditions)
        cols = "id, memory, properties, created_at, updated_at"
        if include_embedding:
            cols += ", embedding"
        rows = self._query(f"SELECT {cols} FROM {self.nodes_table} WHERE {where_clause}", params)
        return [self._parse_row(row, include_embedding) for row in rows]

    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False
    ) -> list[dict]:
        """Find isolated nodes (no incident edges) for a given scope."""
        user_name = self.user_name
        cols = "m.id, m.memory, m.properties, m.created_at, m.updated_at"
        if include_embedding:
            cols += ", m.embedding"
        rows = self._query(
            f"""
            SELECT {cols}
            FROM {self.nodes_table} m
            LEFT JOIN {self.edges_table} e1 ON m.id = e1.source_id
            LEFT JOIN {self.edges_table} e2 ON m.id = e2.target_id
            WHERE JSON_UNQUOTE(JSON_EXTRACT(m.properties, '$.memory_type')) = %s
              AND m.user_name = %s
              AND JSON_UNQUOTE(JSON_EXTRACT(m.properties, '$.status')) = 'activated'
              AND e1.id IS NULL
              AND e2.id IS NULL
            """,
            (scope, user_name),
        )
        return [self._parse_row(row, include_embedding) for row in rows]

    # =========================================================================
    # Maintenance
    # =========================================================================

    def deduplicate_nodes(self) -> None:
        """Not implemented - handled at application level."""

    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Count nodes grouped by the given JSON property fields.

        ``where_clause`` is intentionally not supported: splicing a raw SQL
        string would be an injection vector, and no current caller uses it.
        Express additional filters through the structured filter helpers instead.
        """
        user_name = user_name or self.user_name
        if not group_fields:
            raise ValueError("group_fields cannot be empty")
        if where_clause:
            raise ValueError(
                "get_grouped_counts() does not support a raw `where_clause`; "
                "use structured filters instead"
            )
        for field in group_fields:
            if not self._is_safe_field_name(field):
                raise ValueError(f"Invalid group field: {field}")

        select_fields = ", ".join(
            [
                f"JSON_UNQUOTE(JSON_EXTRACT(properties, '$.{field}')) AS {field}"
                for field in group_fields
            ]
        )
        group_by = ", ".join(
            [f"JSON_UNQUOTE(JSON_EXTRACT(properties, '$.{field}'))" for field in group_fields]
        )

        conditions = ["user_name = %s"]
        query_params: list[Any] = [user_name]

        where_sql = " AND ".join(conditions)

        rows = self._query(
            f"""
            SELECT {select_fields}, COUNT(*) AS count
            FROM {self.nodes_table}
            WHERE {where_sql}
            GROUP BY {group_by}
            """,
            query_params,
        )
        results = []
        for row in rows:
            result = {}
            for i, field in enumerate(group_fields):
                result[field] = row[i]
            result["count"] = row[len(group_fields)]
            results.append(result)
        return results

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """Not implemented."""
        return []

    def merge_nodes(self, id1: str, id2: str) -> str:
        """Not implemented."""
        raise NotImplementedError

    def clear(self, user_name: str | None = None) -> None:
        """Clear all graph data for the given tenant (never the whole database)."""
        user_name = user_name or self.user_name
        with self._transaction() as cur:
            cur.execute(
                f"SELECT id FROM {self.nodes_table} WHERE user_name = %s",
                (user_name,),
            )
            ids = [row[0] for row in cur.fetchall()]
            if ids:
                ph = self._placeholders(ids)
                cur.execute(
                    f"DELETE FROM {self.edges_table} "
                    f"WHERE source_id IN ({ph}) OR target_id IN ({ph})",
                    (*ids, *ids),
                )
            cur.execute(
                f"DELETE FROM {self.nodes_table} WHERE user_name = %s",
                (user_name,),
            )
        logger.info("Cleared all graph data for user %s", user_name)

    def drop_database(self, user_name: str | None = None) -> None:
        """Scoped clear: remove the current tenant's graph data only.

        Redefined (vs. dropping a physical database) because the OceanBase /
        seekdb database is shared across MemOS modules.
        """
        self.clear(user_name=user_name)

    def export_graph(self, include_embedding: bool = False, **kwargs) -> dict[str, Any]:
        """Export all graph data for the given tenant."""
        user_name = kwargs.get("user_name") or self.user_name
        cols = "id, memory, properties, created_at, updated_at"
        if include_embedding:
            cols += ", embedding"
        node_rows = self._query(
            f"""
            SELECT {cols} FROM {self.nodes_table}
            WHERE user_name = %s
            ORDER BY created_at DESC
            """,
            (user_name,),
        )
        nodes = [self._parse_row(row, include_embedding) for row in node_rows]

        node_ids = [n["id"] for n in nodes]
        if node_ids:
            ph = self._placeholders(node_ids)
            edge_rows = self._query(
                f"""
                SELECT source_id, target_id, edge_type
                FROM {self.edges_table}
                WHERE source_id IN ({ph}) OR target_id IN ({ph})
                """,
                (*node_ids, *node_ids),
            )
            edges = [{"source": row[0], "target": row[1], "type": row[2]} for row in edge_rows]
        else:
            edges = []

        return {
            "nodes": nodes,
            "edges": edges,
            "total_nodes": len(nodes),
            "total_edges": len(edges),
        }

    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        """Import graph data."""
        user_name = user_name or self.user_name
        for node in data.get("nodes", []):
            self.add_node(
                id=node["id"],
                memory=node.get("memory", ""),
                metadata=node.get("metadata", {}),
                user_name=user_name,
            )
        for edge in data.get("edges", []):
            self.add_edge(
                source_id=edge["source"],
                target_id=edge["target"],
                type=edge["type"],
            )

    def close(self):
        """Close the connection pool; further queries are rejected afterwards."""
        if self._closed:
            return
        self._closed = True
        self._pool.close()
