"""
PostgreSQL + pgvector backend for MemOS.

Simple implementation using standard PostgreSQL with pgvector extension.
No Apache AGE or other graph extensions required.

Tables:
- {schema}_graph_{n}."Memory": one tenant shard of memory nodes
- {schema}_graph_{n}."Edges": relationships for that same shard
"""

import hashlib
import json
import random
import re
import time

from contextlib import suppress
from datetime import datetime, timezone
from typing import Any, Literal

from memos.configs.graph_db import PostgresGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


def _prepare_node_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Ensure metadata has proper datetime fields and normalized types."""
    now = datetime.now(timezone.utc).isoformat()
    metadata.setdefault("created_at", now)
    metadata.setdefault("updated_at", now)

    # Normalize embedding type
    embedding = metadata.get("embedding")
    if embedding and isinstance(embedding, list):
        metadata["embedding"] = [float(x) for x in embedding]

    return metadata


class PostgresGraphDB(BaseGraphDB):
    """PostgreSQL + pgvector implementation of a graph memory store."""

    supports_lightweight_vector_search = True
    prefer_lightweight_vector_search = True

    @require_python_package(
        import_name="psycopg2",
        install_command="pip install psycopg2-binary",
        install_link="https://pypi.org/project/psycopg2-binary/",
    )
    def __init__(self, config: PostgresGraphDBConfig):
        """Initialize PostgreSQL connection pool."""
        import psycopg2.pool

        self.config = config
        if not self._is_safe_field_name(config.schema_name):
            raise ValueError(f"Invalid PostgreSQL schema name: {config.schema_name}")
        self.schema = config.schema_name
        self.db_name = config.db_name
        self.user_name = config.user_name
        self._pool_closed = False
        self._partition_remainders: dict[str, int] = {}

        logger.info(f"Connecting to PostgreSQL: {config.host}:{config.port}/{config.db_name}")

        # Create connection pool
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=config.minconn,
            maxconn=config.maxconn,
            host=config.host,
            port=config.port,
            user=config.user,
            password=config.password,
            dbname=config.db_name,
            connect_timeout=10,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )

        # Initialize schema and tables
        self._init_schema()

    def warm_up_search_connections_by_full(self, user_name: str | None = None) -> None:
        """Warm one pooled PostgreSQL connection; tenant routing needs no fan-out."""
        conn = self._get_conn()
        self._put_conn(conn)

    def get_memory_graph_table_name(self, user_name: str | None) -> str:
        """Return the one partition table for this tenant, matching PolarDB shard routing."""
        target = user_name or self.user_name
        return self._physical_table("memories", target)

    def create_extension(self) -> None:
        self._init_schema()

    def create_graph(self) -> None:
        self._init_schema()

    def create_edge(self) -> None:
        self._init_schema()

    def create_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 1024,
        index_name: str = "memory_vector_index",
    ) -> None:
        self._init_schema()

    def format_param_value(self, value: str | None) -> str:
        return "null" if value is None else json.dumps(value, ensure_ascii=False)

    def _get_conn(self):
        """Get a pooled connection without an extra round trip."""
        if self._pool_closed:
            raise RuntimeError("Connection pool is closed")

        for attempt in range(3):
            conn = None
            try:
                conn = self.pool.getconn()
                if conn.closed != 0:
                    self.pool.putconn(conn, close=True)
                    continue
                conn.autocommit = True
                return conn
            except Exception as e:
                if conn:
                    with suppress(Exception):
                        self.pool.putconn(conn, close=True)
                if attempt == 2:
                    raise RuntimeError(f"Failed to get connection: {e}") from e
                time.sleep(0.1)
        raise RuntimeError("Failed to get healthy connection")

    def _put_conn(self, conn):
        """Return connection to pool."""
        if conn and not self._pool_closed:
            try:
                self.pool.putconn(conn)
            except Exception:
                with suppress(Exception):
                    conn.close()

    def _init_schema(self):
        """Create PolarDB-style MD5 shards with a halfvec Memory table in each."""
        fulltext_config = getattr(self.config, "fulltext_config", "simple")
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", fulltext_config):
            raise ValueError(f"Invalid PostgreSQL text search config: {fulltext_config}")
        vector_index_type = getattr(self.config, "vector_index_type", "hnsw")
        shard_count = int(getattr(self.config, "shard_count", 400))
        if shard_count < 1 or shard_count > 4096:
            raise ValueError("PostgreSQL shard_count must be between 1 and 4096")

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"CREATE SCHEMA IF NOT EXISTS {self.schema}")
                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")

                cur.execute(
                    """
                    SELECT c.relname, c.relkind
                    FROM pg_class AS c
                    JOIN pg_namespace AS n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s
                      AND c.relname = ANY(%s)
                    """,
                    (
                        self.schema,
                        ["memories", "edges"],
                    ),
                )
                legacy_rows = cur.fetchall()
                if isinstance(legacy_rows, list) and legacy_rows:
                    raise RuntimeError(
                        f"{self.schema} still has the old memories layout; "
                        "configure a new MEMOS_SCHEMA for the MD5 shard layout "
                        "or migrate the existing data"
                    )

                dim = int(self.config.embedding_dimension)
                cur.execute(
                    """
                    SELECT COUNT(*)
                    FROM pg_class AS c
                    JOIN pg_namespace AS n ON n.oid = c.relnamespace
                    WHERE c.relname = 'Memory'
                      AND c.relkind = 'r'
                      AND n.nspname ~ %s
                    """,
                    (rf"^{re.escape(self.schema)}_graph_[0-9]+$",),
                )
                count_row = cur.fetchone()
                memory_tables = (
                    count_row[0] if count_row and isinstance(count_row[0], int) else -1
                )
                if memory_tables != shard_count:
                    hnsw_m = int(getattr(self.config, "hnsw_m", 16))
                    ef_construction = int(getattr(self.config, "hnsw_ef_construction", 64))
                    lists = int(getattr(self.config, "ivfflat_lists", 100))
                    statements: list[str] = []
                    for remainder in range(shard_count):
                        shard_schema = f"{self.schema}_graph_{remainder}"
                        memory = f'"{shard_schema}"."Memory"'
                        edges = f'"{shard_schema}"."Edges"'
                        if vector_index_type == "ivfflat":
                            vector_index = (
                                f"CREATE INDEX IF NOT EXISTS idx_memory_embedding_halfvec "
                                f"ON {memory} USING ivfflat (embedding halfvec_cosine_ops) "
                                f"WITH (lists = {lists})"
                            )
                        else:
                            vector_index = (
                                f"CREATE INDEX IF NOT EXISTS idx_memory_embedding_halfvec "
                                f"ON {memory} USING hnsw (embedding halfvec_cosine_ops) "
                                f"WITH (m = {hnsw_m}, ef_construction = {ef_construction})"
                            )
                        statements.extend(
                            [
                                f'CREATE SCHEMA IF NOT EXISTS "{shard_schema}"',
                                f"""
                                CREATE TABLE IF NOT EXISTS {memory} (
                                    id TEXT NOT NULL,
                                    memory TEXT NOT NULL DEFAULT '',
                                    properties JSONB NOT NULL DEFAULT '{{}}',
                                    embedding halfvec({dim}),
                                    user_name TEXT NOT NULL,
                                    search_vector tsvector GENERATED ALWAYS AS (
                                        to_tsvector(
                                            '{fulltext_config}',
                                            coalesce(memory, '') || ' ' || coalesce(properties::text, '')
                                        )
                                    ) STORED,
                                    deleted_at TIMESTAMPTZ,
                                    created_at TIMESTAMPTZ DEFAULT NOW(),
                                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                                    PRIMARY KEY (user_name, id)
                                )
                                """,
                                f"""
                                CREATE TABLE IF NOT EXISTS {edges} (
                                    id BIGSERIAL NOT NULL,
                                    user_name TEXT NOT NULL,
                                    source_id TEXT NOT NULL,
                                    target_id TEXT NOT NULL,
                                    edge_type TEXT NOT NULL,
                                    created_at TIMESTAMPTZ DEFAULT NOW(),
                                    PRIMARY KEY (user_name, id),
                                    UNIQUE(user_name, source_id, target_id, edge_type)
                                )
                                """,
                                (
                                    f"CREATE INDEX IF NOT EXISTS idx_memory_user "
                                    f"ON {memory}(user_name)"
                                ),
                                (
                                    f"CREATE INDEX IF NOT EXISTS idx_memory_props "
                                    f"ON {memory} USING GIN(properties)"
                                ),
                                (
                                    f"CREATE INDEX IF NOT EXISTS idx_memory_search_vector "
                                    f"ON {memory} USING GIN(search_vector)"
                                ),
                                vector_index,
                                (
                                    f"CREATE INDEX IF NOT EXISTS idx_edges_source "
                                    f"ON {edges}(user_name, source_id)"
                                ),
                                (
                                    f"CREATE INDEX IF NOT EXISTS idx_edges_target "
                                    f"ON {edges}(user_name, target_id)"
                                ),
                                (
                                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_tenant_unique "
                                    f"ON {edges}(user_name, source_id, target_id, edge_type)"
                                ),
                            ]
                        )
                    cur.execute(";\n".join(statements))

                logger.info(
                    "Schema %s initialized successfully with %d MD5 shards",
                    self.schema,
                    shard_count,
                )
        except Exception as e:
            logger.error(f"Failed to init schema: {e}")
            raise
        finally:
            self._put_conn(conn)

    # =========================================================================
    # Node Management
    # =========================================================================

    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """
        Remove all memories of a given type except the latest `keep_latest` entries.

        Args:
            memory_type: Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest: Number of latest entries to keep.
            user_name: User to filter by.
        """
        user_name = user_name or self.user_name
        keep_latest = int(keep_latest)
        memories = self._physical_table("memories", user_name)
        edges = self._physical_table("edges", user_name)

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Find IDs to delete (older than the keep_latest entries)
                cur.execute(
                    f"""
                    WITH ranked AS (
                        SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC) as rn
                        FROM {memories}
                        WHERE user_name = %s
                        AND properties->>'memory_type' = %s
                    )
                    SELECT id FROM ranked WHERE rn > %s
                """,
                    (user_name, memory_type, keep_latest),
                )

                ids_to_delete = [row[0] for row in cur.fetchall()]

                if ids_to_delete:
                    # Delete edges first
                    cur.execute(
                        f"""
                        DELETE FROM {edges}
                        WHERE user_name = %s
                          AND (source_id = ANY(%s) OR target_id = ANY(%s))
                    """,
                        (user_name, ids_to_delete, ids_to_delete),
                    )

                    # Delete nodes
                    cur.execute(
                        f"""
                        DELETE FROM {memories}
                        WHERE id = ANY(%s) AND user_name = %s
                    """,
                        (ids_to_delete, user_name),
                    )

                    logger.info(
                        "Removed %d oldest %s memories for user %s",
                        len(ids_to_delete),
                        memory_type,
                        user_name,
                    )
        finally:
            self._put_conn(conn)

    def _prepare_node_for_insert(
        self,
        node_id: str,
        memory: str,
        metadata: dict[str, Any] | None,
        user_name: str,
    ) -> tuple[Any, ...]:
        """Build one write row with the same property shape PolarDB stores."""
        fields = _prepare_node_metadata(dict(metadata or {}))
        fields["user_name"] = user_name
        fields.setdefault("delete_time", "")
        fields.setdefault("delete_record_id", "")
        now = datetime.now(timezone.utc).isoformat()
        created_at = fields.pop("created_at", now)
        updated_at = fields.pop("updated_at", now)
        for field_name in ("sources", "usage"):
            value = fields.get(field_name)
            if isinstance(value, list):
                fields[field_name] = [
                    item if isinstance(item, str) else json.dumps(item) for item in value
                ]
        embedding = fields.pop("embedding", None)
        if not isinstance(embedding, list) or not embedding:
            embedding = [
                round(random.uniform(-0.2, 0.2), 6) for _ in range(self._vector_dim())
            ]
        else:
            embedding = [float(item) for item in embedding]
        properties = {
            "id": node_id,
            "memory": memory,
            "created_at": created_at,
            "updated_at": updated_at,
            "delete_time": fields.get("delete_time", ""),
            "delete_record_id": fields.get("delete_record_id", ""),
            **fields,
        }
        return (
            node_id,
            memory,
            json.dumps(properties, ensure_ascii=False),
            embedding,
            user_name,
            created_at,
            updated_at,
        )

    def add_node(self, id: str, memory: str, metadata: dict[str, Any], user_name: str) -> None:
        """Add a memory node."""
        if not user_name:
            raise ValueError("add_node requires user_name")
        self.add_nodes_batch(
            [{"id": id, "memory": memory, "metadata": metadata}],
            user_name,
        )

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str) -> None:
        """Insert every node for one tenant in a single statement."""
        if not nodes:
            return
        if not user_name:
            raise ValueError("add_nodes_batch requires user_name")
        rows: list[tuple[Any, ...]] = []
        for node in nodes:
            try:
                rows.append(
                    self._prepare_node_for_insert(
                        node["id"],
                        node["memory"],
                        node.get("metadata", {}),
                        user_name,
                    )
                )
            except Exception:
                logger.error(
                    "add_nodes_batch failed to prepare node %s",
                    node.get("id", "unknown"),
                    exc_info=True,
                )
        if not rows:
            return
        memories = self._physical_table("memories", user_name)
        dim = self._vector_dim()
        values_sql = ",".join(
            [f"(%s, %s, %s, %s::halfvec({dim}), %s, %s, %s)"] * len(rows)
        )
        params: list[Any] = [value for row in rows for value in row]
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {memories}
                    (id, memory, properties, embedding, user_name, created_at, updated_at)
                    VALUES {values_sql}
                    ON CONFLICT (user_name, id) DO UPDATE SET
                        memory = EXCLUDED.memory,
                        properties = EXCLUDED.properties,
                        embedding = EXCLUDED.embedding,
                        updated_at = EXCLUDED.updated_at
                    WHERE "Memory".user_name = EXCLUDED.user_name
                    """,
                    params,
                )
        finally:
            self._put_conn(conn)

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """Update node fields."""
        user_name = user_name or self.user_name
        if not fields:
            return
        fields = fields.copy()

        # Get current node
        current = self.get_node(id, user_name=user_name)
        if not current:
            return

        # Merge properties
        props = current.get("metadata", {}).copy()
        embedding = fields.pop("embedding", None)
        memory = fields.pop("memory", current.get("memory", ""))
        props.update(fields)
        props["updated_at"] = datetime.now(timezone.utc).isoformat()
        memories = self._physical_table("memories", user_name)

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                if embedding:
                    cur.execute(
                        f"""
                        UPDATE {memories}
                        SET memory = %s, properties = %s, embedding = %s::halfvec({self._vector_dim()}), updated_at = NOW()
                        WHERE id = %s AND user_name = %s
                    """,
                        (memory, json.dumps(props), embedding, id, user_name),
                    )
                else:
                    cur.execute(
                        f"""
                        UPDATE {memories}
                        SET memory = %s, properties = %s, updated_at = NOW()
                        WHERE id = %s AND user_name = %s
                    """,
                        (memory, json.dumps(props), id, user_name),
                    )
        finally:
            self._put_conn(conn)

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """Delete a node and its edges."""
        user_name = user_name or self.user_name
        memories = self._physical_table("memories", user_name)
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Delete edges
                cur.execute(
                    f"""
                    DELETE FROM {edges}
                    WHERE user_name = %s AND (source_id = %s OR target_id = %s)
                """,
                    (user_name, id, id),
                )
                # Delete node
                cur.execute(
                    f"""
                    DELETE FROM {memories}
                    WHERE id = %s AND user_name = %s
                """,
                    (id, user_name),
                )
        finally:
            self._put_conn(conn)

    def get_node(
        self, id: str, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any] | None:
        """Get a single node by ID."""
        relation = self._tenant_relation("memories", [user_name] if user_name else [])
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cols += ", user_name"
                if user_name:
                    cur.execute(
                        f"""
                        SELECT {cols} FROM {relation}
                        WHERE id = %s AND user_name = %s
                    """,
                        (id, user_name),
                    )
                else:
                    cur.execute(
                        f"""
                        SELECT {cols} FROM {relation}
                        WHERE id = %s
                    """,
                        (id,),
                    )
                row = cur.fetchone()
                if not row:
                    return None
                return self._parse_row(row, include_embedding)
        finally:
            self._put_conn(conn)

    def get_nodes(
        self, ids: list[str], user_name: str | None = None, **kwargs
    ) -> list[dict[str, Any]]:
        """Get multiple nodes by IDs."""
        if not ids:
            return []
        include_embedding = bool(kwargs.get("include_embedding", False))
        relation = self._tenant_relation("memories", [user_name] if user_name else [])
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cols += ", user_name"
                if user_name:
                    cur.execute(
                        f"""
                        SELECT {cols} FROM {relation}
                        WHERE id = ANY(%s) AND user_name = %s
                          AND COALESCE(properties->>'status', 'activated') <> 'archived'
                    """,
                        (ids, user_name),
                    )
                else:
                    cur.execute(
                        f"""
                        SELECT {cols} FROM {relation}
                        WHERE id = ANY(%s)
                          AND COALESCE(properties->>'status', 'activated') <> 'archived'
                    """,
                        (ids,),
                    )
                return [self._parse_row(row, include_embedding) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    @staticmethod
    def _normalize_node_properties(
        raw_properties: dict[str, Any], user_name: str | None = None
    ) -> dict[str, Any]:
        """Restore the logical PolarDB metadata shape from relational storage."""
        properties = dict(raw_properties)
        if user_name:
            properties["user_name"] = user_name

        sources = properties.get("sources")
        if isinstance(sources, list):
            normalized_sources: list[Any] = []
            for source in sources:
                if isinstance(source, str):
                    try:
                        parsed_source = json.loads(source)
                    except (json.JSONDecodeError, TypeError):
                        parsed_source = {"type": "doc", "content": source}
                    normalized_sources.append(parsed_source)
                elif isinstance(source, dict):
                    normalized_sources.append(source)
                else:
                    normalized_sources.append({"type": "doc", "content": str(source)})
            properties["sources"] = normalized_sources

        return properties

    def _parse_row(self, row, include_embedding: bool = False) -> dict[str, Any]:
        """Parse database row to node dict."""
        raw_props = row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}")
        user_name_index = 6 if include_embedding else 5
        user_name = row[user_name_index] if len(row) > user_name_index else None
        props = self._normalize_node_properties(raw_props, user_name=user_name)
        props["id"] = row[0]
        props["memory"] = row[1] or ""
        props["created_at"] = row[3].isoformat() if row[3] else None
        props["updated_at"] = row[4].isoformat() if row[4] else None
        result = {
            "id": row[0],
            "memory": row[1] or "",
            "metadata": props,
        }
        if include_embedding and len(row) > 5:
            result["metadata"]["embedding"] = self._coerce_embedding(row[5])
        return result

    @staticmethod
    def _coerce_embedding(value: Any) -> list[float]:
        """Normalize pgvector values returned as lists, tuples, or text."""
        if value is None:
            return []
        if isinstance(value, str):
            value = value.strip().strip("[]")
            if not value:
                return []
            return [float(item) for item in value.split(",")]
        return [float(item) for item in value]

    @staticmethod
    def _is_safe_field_name(field: str) -> bool:
        """Validate field names used in dynamic SQL fragments."""
        return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", field))

    def _field_expr(self, key: str) -> tuple[str, str]:
        """
        Build text/json SQL expressions for a filter key.

        Returns:
            tuple[text_expr, json_expr]
        """
        direct_columns = {"id", "memory", "user_name", "created_at", "updated_at"}
        if key in direct_columns:
            return key, key

        if key.startswith("info."):
            sub_key = key[5:]
            if not self._is_safe_field_name(sub_key):
                raise ValueError(f"Invalid filter field: {key}")
            return f"properties->'info'->>'{sub_key}'", f"properties->'info'->'{sub_key}'"

        if not self._is_safe_field_name(key):
            raise ValueError(f"Invalid filter field: {key}")
        return f"properties->>'{key}'", f"properties->'{key}'"

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
                            parts.append(f"({text_expr})::timestamp {sql_op} %s::timestamp")
                            params.append(op_value)
                        else:
                            parts.append(f"NULLIF({text_expr}, '')::numeric {sql_op} %s")
                            params.append(op_value)
                    elif op == "contains":
                        values = op_value if isinstance(op_value, list) else [op_value]
                        or_parts = []
                        for item in values:
                            or_parts.append(f"{json_expr} @> %s::jsonb")
                            params.append(json.dumps([item], ensure_ascii=False))
                        parts.append("(" + " OR ".join(or_parts) + ")")
                    elif op == "in":
                        if not isinstance(op_value, list):
                            raise ValueError(
                                f"in operator expects list for '{key}', "
                                f"got {type(op_value).__name__}"
                            )
                        if len(op_value) == 0:
                            parts.append("FALSE")
                        elif raw_key in array_fields or raw_key == "related_id":
                            or_parts = []
                            for item in op_value:
                                or_parts.append(f"{json_expr} @> %s::jsonb")
                                params.append(json.dumps([str(item)], ensure_ascii=False))
                            parts.append("(" + " OR ".join(or_parts) + ")")
                        else:
                            parts.append(f"{text_expr} = ANY(%s)")
                            params.append([str(v) for v in op_value])
                    elif op == "like":
                        parts.append(f"{text_expr} LIKE %s")
                        params.append(f"%{op_value}%")
                    elif op == "nolike":
                        parts.append(f"{text_expr} NOT LIKE %s")
                        params.append(f"%{op_value}%")
                    else:
                        raise ValueError(f"Unsupported filter operator: {op}")
            else:
                if raw_key in array_fields:
                    if isinstance(value, list):
                        parts.append(f"{json_expr} @> %s::jsonb")
                        params.append(json.dumps(value))
                    else:
                        parts.append(f"{json_expr} @> %s::jsonb")
                        params.append(json.dumps([value]))
                else:
                    parts.append(f"{text_expr} = %s")
                    params.append(str(value))

        if not parts:
            return None
        return " AND ".join(parts)

    def _build_filter_where_clause(self, filter_dict: dict[str, Any], params: list[Any]) -> str:
        """Build SQL WHERE fragment from filter dict."""
        filter_dict = self.parse_filter(filter_dict)
        if not filter_dict:
            return ""

        if "and" in filter_dict:
            and_conditions = filter_dict.get("and")
            if not isinstance(and_conditions, list):
                raise ValueError("Invalid filter format: 'and' must be a list")
            parts: list[str] = []
            for cond in and_conditions:
                if isinstance(cond, dict):
                    cond_sql = self._build_filter_where_clause(cond, params)
                    if cond_sql:
                        parts.append(f"({cond_sql})")
            return " AND ".join(parts)

        if "or" in filter_dict:
            or_conditions = filter_dict.get("or")
            if not isinstance(or_conditions, list):
                raise ValueError("Invalid filter format: 'or' must be a list")
            parts: list[str] = []
            for cond in or_conditions:
                if isinstance(cond, dict):
                    cond_sql = self._build_filter_where_clause(cond, params)
                    if cond_sql:
                        parts.append(f"({cond_sql})")
            return f"({' OR '.join(parts)})" if parts else ""

        cond_sql = self._build_single_filter_condition(filter_dict, params)
        return cond_sql or ""

    def parse_filter(self, filter_dict: dict | None = None):
        """Apply the same implicit info.* field routing as the PolarDB backend."""
        if filter_dict is None:
            return None
        full_fields = {
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

        def normalize(condition: Any) -> Any:
            if not isinstance(condition, dict):
                return condition
            normalized: dict[str, Any] = {}
            for key, value in condition.items():
                if key.lower() in {"and", "or"} and isinstance(value, list):
                    normalized[key] = [normalize(item) for item in value]
                    continue
                normalized_key = (
                    key if key in full_fields or key.startswith("info.") else f"info.{key}"
                )
                normalized[normalized_key] = value
            return normalized

        return normalize(filter_dict)

    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """Delete nodes by memory_ids, file_ids, or filter."""
        logger.info(
            "[delete_node_by_prams] memory_ids: %s, file_ids: %s, "
            "filter: %s, writable_cube_ids: %s",
            memory_ids,
            file_ids,
            filter,
            writable_cube_ids,
        )

        where_conditions: list[str] = []
        params: list[Any] = []

        if memory_ids:
            where_conditions.append("id = ANY(%s)")
            params.append(memory_ids)

        if file_ids:
            file_conditions: list[str] = []
            for file_id in file_ids:
                file_conditions.append("properties->'file_ids' @> %s::jsonb")
                params.append(json.dumps([file_id]))
            if file_conditions:
                where_conditions.append(f"({' OR '.join(file_conditions)})")

        if filter:
            filter_where = self._build_filter_where_clause(filter, params)
            if filter_where:
                where_conditions.append(f"({filter_where})")

        if not where_conditions:
            logger.warning(
                "[delete_node_by_prams] No nodes to delete "
                "(no memory_ids, file_ids, or filter provided)"
            )
            return 0

        if writable_cube_ids:
            where_conditions.append("user_name = ANY(%s)")
            params.append(writable_cube_ids)

        where_clause = " AND ".join(where_conditions)
        memory_tables = self._physical_tables("memories", writable_cube_ids)
        edge_tables = self._physical_tables("edges", writable_cube_ids)

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                deleted_count = 0
                for memories, edges in zip(memory_tables, edge_tables, strict=True):
                    query = f"""
                        WITH to_delete AS (
                            SELECT id, user_name
                            FROM {memories}
                            WHERE {where_clause}
                        ),
                        deleted_edges AS (
                            DELETE FROM {edges} e
                            USING to_delete d
                            WHERE e.user_name = d.user_name
                              AND (e.source_id = d.id OR e.target_id = d.id)
                        )
                        DELETE FROM {memories} m
                        USING to_delete d
                        WHERE m.id = d.id
                    """
                    cur.execute(query, params)
                    deleted_count += cur.rowcount if cur.rowcount is not None else 0
                logger.info("[delete_node_by_prams] Deleted %s nodes", deleted_count)
                return deleted_count
        finally:
            self._put_conn(conn)

    @staticmethod
    def _normalize_cube_memory_groups(
        cube_memory_groups: list[dict[str, Any]],
    ) -> list[tuple[str, str]]:
        """Normalize and de-duplicate (tenant, memory-id) requests."""
        pairs: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for group in cube_memory_groups:
            cube_id = str(group.get("cube_id") or "").strip()
            if not cube_id:
                continue
            for raw_memory_id in group.get("memory_ids") or []:
                memory_id = str(raw_memory_id).strip()
                pair = (cube_id, memory_id)
                if memory_id and pair not in seen:
                    seen.add(pair)
                    pairs.append(pair)
        return pairs

    def delete_node_by_cube_memory_groups(self, cube_memory_groups: list[dict[str, Any]]) -> int:
        """Delete exactly the requested (cube, memory-id) pairs.

        PolarDB locates these pairs in one of 400 schemas. PostgreSQL keeps the
        same isolation rule in a shared table by joining both user_name and id.
        """
        pairs = self._normalize_cube_memory_groups(cube_memory_groups)
        if not pairs:
            return 0
        user_names = [pair[0] for pair in pairs]
        memory_ids = [pair[1] for pair in pairs]
        tenant_names = list(dict.fromkeys(user_names))
        memory_tables = self._physical_tables("memories", tenant_names)
        edge_tables = self._physical_tables("edges", tenant_names)

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                deleted_count = 0
                for memories, edges in zip(memory_tables, edge_tables, strict=True):
                    cur.execute(
                        f"""
                        WITH requested(user_name, memory_id) AS (
                            SELECT * FROM unnest(%s::text[], %s::text[])
                        ), to_delete AS (
                            SELECT m.id, m.user_name
                            FROM {memories} m
                            JOIN requested
                              ON requested.user_name = m.user_name
                             AND requested.memory_id = m.id
                        ), deleted_edges AS (
                            DELETE FROM {edges} e
                            USING to_delete d
                            WHERE e.user_name = d.user_name
                              AND (e.source_id = d.id OR e.target_id = d.id)
                        ), deleted AS (
                            DELETE FROM {memories} m
                            USING to_delete d
                            WHERE m.id = d.id AND m.user_name = d.user_name
                            RETURNING 1
                        )
                        SELECT COUNT(*) FROM deleted
                        """,
                        (user_names, memory_ids),
                    )
                    row = cur.fetchone()
                    deleted_count += int(row[0]) if row and row[0] is not None else 0
                return deleted_count
        finally:
            self._put_conn(conn)

    def get_user_names_by_cube_memory_groups(
        self, cube_memory_groups: list[dict[str, Any]]
    ) -> dict[str, str | None]:
        """Resolve memory ownership without scanning unrelated tenants."""
        raw_ids = [
            str(memory_id).strip()
            for group in cube_memory_groups
            for memory_id in (group.get("memory_ids") or [])
            if str(memory_id).strip()
        ]
        result: dict[str, str | None] = dict.fromkeys(raw_ids)
        pairs = self._normalize_cube_memory_groups(cube_memory_groups)
        if not pairs:
            return result

        user_names = [pair[0] for pair in pairs]
        memory_ids = [pair[1] for pair in pairs]
        memories = self._tenant_relation("memories", list(dict.fromkeys(user_names)), alias="m")
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    WITH requested(user_name, memory_id) AS (
                        SELECT * FROM unnest(%s::text[], %s::text[])
                    )
                    SELECT requested.memory_id, m.user_name
                    FROM requested
                    LEFT JOIN {memories}
                      ON m.id = requested.memory_id
                     AND m.user_name = requested.user_name
                    """,
                    (user_names, memory_ids),
                )
                for memory_id, owner in cur.fetchall():
                    if owner:
                        result[str(memory_id)] = str(owner)
                return result
        finally:
            self._put_conn(conn)

    # =========================================================================
    # Edge Management
    # =========================================================================

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Create an edge between nodes."""
        user_name = user_name or self.user_name
        memories = self._physical_table("memories", user_name)
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {edges}
                        (user_name, source_id, target_id, edge_type)
                    SELECT %s, %s, %s, %s
                    WHERE EXISTS (
                        SELECT 1 FROM {memories}
                        WHERE id = %s AND user_name = %s
                    ) AND EXISTS (
                        SELECT 1 FROM {memories}
                        WHERE id = %s AND user_name = %s
                    )
                    ON CONFLICT (user_name, source_id, target_id, edge_type) DO NOTHING
                """,
                    (
                        user_name,
                        source_id,
                        target_id,
                        type,
                        source_id,
                        user_name,
                        target_id,
                        user_name,
                    ),
                )
        finally:
            self._put_conn(conn)

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Delete an edge."""
        user_name = user_name or self.user_name
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    DELETE FROM {edges}
                    WHERE user_name = %s
                      AND source_id = %s AND target_id = %s AND edge_type = %s
                """,
                    (user_name, source_id, target_id, type),
                )
        finally:
            self._put_conn(conn)

    def edge_exists(
        self,
        source_id: str,
        target_id: str,
        type: str = "ANY",
        direction: str = "OUTGOING",
        user_name: str | None = None,
    ) -> bool:
        """Check if edge exists."""
        user_name = user_name or self.user_name
        direction = direction.upper()
        if direction not in {"OUTGOING", "INCOMING", "ANY"}:
            raise ValueError("direction must be OUTGOING, INCOMING, or ANY")
        if direction == "INCOMING":
            source_id, target_id = target_id, source_id

        direction_sql = "source_id = %s AND target_id = %s"
        params: list[Any] = [user_name, source_id, target_id]
        if direction == "ANY":
            direction_sql = (
                "((source_id = %s AND target_id = %s) OR (source_id = %s AND target_id = %s))"
            )
            params = [user_name, source_id, target_id, target_id, source_id]

        type_sql = ""
        if type != "ANY":
            type_sql = " AND edge_type = %s"
            params.append(type)

        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT 1 FROM {edges}
                    WHERE user_name = %s AND {direction_sql}{type_sql}
                    LIMIT 1
                """,
                    params,
                )
                return cur.fetchone() is not None
        finally:
            self._put_conn(conn)

    # =========================================================================
    # Graph Queries
    # =========================================================================

    def get_neighbors(
        self,
        id: str,
        type: str,
        direction: Literal["in", "out", "both"] = "out",
    ) -> list[str]:
        """Get neighboring node IDs."""
        user_name = self.user_name
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                if direction == "out":
                    cur.execute(
                        f"""
                        SELECT target_id FROM {edges}
                        WHERE user_name = %s AND source_id = %s AND edge_type = %s
                    """,
                        (user_name, id, type),
                    )
                elif direction == "in":
                    cur.execute(
                        f"""
                        SELECT source_id FROM {edges}
                        WHERE user_name = %s AND target_id = %s AND edge_type = %s
                    """,
                        (user_name, id, type),
                    )
                else:  # both
                    cur.execute(
                        f"""
                        SELECT target_id FROM {edges}
                        WHERE user_name = %s AND source_id = %s AND edge_type = %s
                        UNION
                        SELECT source_id FROM {edges}
                        WHERE user_name = %s AND target_id = %s AND edge_type = %s
                    """,
                        (user_name, id, type, user_name, id, type),
                    )
                return [row[0] for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_children_with_embeddings(
        self, id: str, user_name: str | None = None
    ) -> list[dict[str, Any]]:
        """Return PARENT-edge children with vectors for structure optimization."""
        user_name = user_name or self.user_name
        memories = self._physical_table("memories", user_name)
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT child.id, child.embedding, child.memory
                    FROM {edges} e
                    JOIN {memories} child
                      ON child.id = e.target_id AND child.user_name = e.user_name
                    WHERE e.user_name = %s
                      AND e.source_id = %s
                      AND e.edge_type = 'PARENT'
                      AND child.deleted_at IS NULL
                    ORDER BY e.id
                    """,
                    (user_name, id),
                )
                return [
                    {
                        "id": row[0],
                        "embedding": self._coerce_embedding(row[1]),
                        "memory": row[2] or "",
                    }
                    for row in cur.fetchall()
                ]
        finally:
            self._put_conn(conn)

    def get_edges(
        self,
        id: str,
        type: str = "ANY",
        direction: str = "ANY",
        user_name: str | None = None,
    ) -> list[dict[str, str]]:
        """Return tenant-scoped edges connected to a node."""
        user_name = user_name or self.user_name
        direction = direction.upper()
        if direction not in {"OUTGOING", "INCOMING", "ANY"}:
            raise ValueError("direction must be OUTGOING, INCOMING, or ANY")

        conditions = ["user_name = %s"]
        params: list[Any] = [user_name]
        if direction == "OUTGOING":
            conditions.append("source_id = %s")
            params.append(id)
        elif direction == "INCOMING":
            conditions.append("target_id = %s")
            params.append(id)
        else:
            conditions.append("(source_id = %s OR target_id = %s)")
            params.extend([id, id])
        if type != "ANY":
            conditions.append("edge_type = %s")
            params.append(type)

        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT source_id, target_id, edge_type
                    FROM {edges}
                    WHERE {" AND ".join(conditions)}
                    ORDER BY id
                    """,
                    params,
                )
                return [{"from": row[0], "to": row[1], "type": row[2]} for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """Get path between nodes using recursive CTE."""
        user_name = self.user_name
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    WITH RECURSIVE path AS (
                        SELECT source_id, target_id, ARRAY[source_id] as nodes, 1 as depth
                        FROM {edges}
                        WHERE user_name = %s AND source_id = %s
                        UNION ALL
                        SELECT e.source_id, e.target_id, p.nodes || e.source_id, p.depth + 1
                        FROM {edges} e
                        JOIN path p ON e.source_id = p.target_id
                        WHERE e.user_name = %s
                          AND p.depth < %s AND NOT e.source_id = ANY(p.nodes)
                    )
                    SELECT nodes || target_id as full_path
                    FROM path
                    WHERE target_id = %s
                    ORDER BY depth
                    LIMIT 1
                """,
                    (user_name, source_id, user_name, max_depth, target_id),
                )
                row = cur.fetchone()
                return row[0] if row else []
        finally:
            self._put_conn(conn)

    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str = "activated",
        user_name: str | None = None,
    ) -> dict[str, Any]:
        """Return the PolarDB-compatible local subgraph structure."""
        if not 1 <= depth <= 5:
            raise ValueError("depth must be 1-5")
        center_id = center_id.strip('"')
        user_name = user_name or self.user_name
        core_node = self.get_node(center_id, user_name=user_name)
        if core_node is None:
            return {"core_node": None, "neighbors": [], "edges": []}
        actual_status = core_node.get("metadata", {}).get("status", "activated")
        if center_status and actual_status != center_status:
            return {"core_node": None, "neighbors": [], "edges": []}

        edges_table = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    WITH RECURSIVE subgraph(node_id, level, path) AS (
                        SELECT %s::text, 0, ARRAY[%s::text]
                        UNION ALL
                        SELECT
                            CASE
                                WHEN e.source_id = s.node_id THEN e.target_id
                                ELSE e.source_id
                            END,
                            s.level + 1,
                            s.path || CASE
                                WHEN e.source_id = s.node_id THEN e.target_id
                                ELSE e.source_id
                            END
                        FROM {edges_table} e
                        JOIN subgraph s ON (e.source_id = s.node_id OR e.target_id = s.node_id)
                        WHERE e.user_name = %s
                          AND s.level < %s
                          AND NOT (
                              CASE
                                  WHEN e.source_id = s.node_id THEN e.target_id
                                  ELSE e.source_id
                              END
                          ) = ANY(s.path)
                    )
                    SELECT DISTINCT node_id FROM subgraph ORDER BY node_id
                    """,
                    (center_id, center_id, user_name, depth),
                )
                node_ids = [str(row[0]) for row in cur.fetchall()]
                neighbor_ids = [node_id for node_id in node_ids if node_id != center_id]
                neighbors = (
                    self.get_nodes(neighbor_ids, user_name=user_name) if neighbor_ids else []
                )

                if node_ids:
                    cur.execute(
                        f"""
                        SELECT source_id, target_id, edge_type
                        FROM {edges_table}
                        WHERE user_name = %s
                          AND source_id = ANY(%s)
                          AND target_id = ANY(%s)
                        ORDER BY id
                        """,
                        (user_name, node_ids, node_ids),
                    )
                    edges = [
                        {"source": row[0], "target": row[1], "type": row[2]}
                        for row in cur.fetchall()
                    ]
                else:
                    edges = []
                return {
                    "core_node": core_node,
                    "neighbors": neighbors,
                    "edges": edges,
                }
        finally:
            self._put_conn(conn)

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """Get ordered chain following relationship type."""
        return self.get_neighbors(id, type, "out")

    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Find active tenant memories ranked by tag overlap."""
        if not tags or top_k <= 0:
            return []
        user_name = user_name or self.user_name
        params: list[Any] = [user_name]
        exclude_sql = ""
        if exclude_ids:
            exclude_sql = "AND id <> ALL(%s)"
            params.append(exclude_ids)

        cols = "id, memory, properties, created_at, updated_at"
        if include_embedding:
            cols += ", embedding"
        cols += ", user_name"
        memories = self._physical_table("memories", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT {cols}
                    FROM {memories}
                    WHERE user_name = %s
                      AND COALESCE(properties->>'status', 'activated') = 'activated'
                      AND COALESCE(properties->>'node_type', '') <> 'reasoning'
                      AND COALESCE(properties->>'memory_type', '') <> 'WorkingMemory'
                      {exclude_sql}
                    """,
                    params,
                )
                ranked: list[tuple[int, dict[str, Any]]] = []
                requested_tags = set(tags)
                for row in cur.fetchall():
                    node = self._parse_row(row, include_embedding)
                    node_tags = node.get("metadata", {}).get("tags", [])
                    if isinstance(node_tags, str):
                        try:
                            node_tags = json.loads(node_tags)
                        except (TypeError, json.JSONDecodeError):
                            node_tags = []
                    overlap = len(requested_tags.intersection(node_tags or []))
                    if overlap >= min_overlap:
                        ranked.append((overlap, node))
                ranked.sort(key=lambda item: item[0], reverse=True)
                return [node for _, node in ranked[:top_k]]
        finally:
            self._put_conn(conn)

    # =========================================================================
    # Search Operations
    # =========================================================================

    def _effective_user_names(
        self,
        user_name: str | None = None,
        knowledgebase_ids: list[str] | None = None,
    ) -> list[str]:
        """Resolve the memory cubes that a query is allowed to read."""
        names: list[str] = []
        primary = user_name or self.user_name
        if primary:
            names.append(primary)
        for knowledgebase_id in knowledgebase_ids or []:
            if knowledgebase_id and knowledgebase_id not in names:
                names.append(knowledgebase_id)
        return names

    def _shard_count(self) -> int:
        return int(getattr(self.config, "shard_count", 400))

    def _remainder_cache(self) -> dict[str, int]:
        cache = getattr(self, "_partition_remainders", None)
        if cache is None:
            cache = {}
            self._partition_remainders = cache
        return cache

    def _partition_remainder(self, user_name: str, conn=None) -> int:
        """Return the PolarDB MD5 shard number for one tenant."""
        del conn
        cache = self._remainder_cache()
        cached = cache.get(user_name)
        if cached is not None:
            return cached
        remainder = (
            int(hashlib.md5(user_name.encode("utf-8")).hexdigest(), 16) % self._shard_count()
        )
        cache[user_name] = remainder
        return remainder

    def _qualified_partition(self, table: str, remainder: int) -> str:
        physical_names = {
            "memories": "Memory",
            "edges": "Edges",
        }
        physical = physical_names.get(table)
        if physical is None:
            raise ValueError(f"Invalid partitioned table: {table}")
        schema = f"{self.schema}_graph_{remainder}"
        if not self._is_safe_field_name(schema):
            raise ValueError(f"Invalid partition schema: {schema}")
        return f'"{schema}"."{physical}"'

    def _all_partitions_relation(self, table: str, alias: str | None = None) -> str:
        """Read every hash partition explicitly, as PolarDB unions every shard."""
        branches = " UNION ALL ".join(
            f"SELECT * FROM {self._qualified_partition(table, remainder)}"
            for remainder in range(self._shard_count())
        )
        return f"({branches}) {alias or table}"

    def _tenant_relation(
        self,
        table: str,
        user_names: list[str] | None,
        alias: str | None = None,
        conn=None,
    ) -> str:
        """Return one child table, or a union of only the touched partitions."""
        names = [name for name in (user_names or []) if name]
        if not names:
            return self._all_partitions_relation(table, alias)
        remainders = sorted({self._partition_remainder(name, conn) for name in names})
        if len(remainders) == 1:
            relation = self._qualified_partition(table, remainders[0])
        else:
            branches = " UNION ALL ".join(
                f"SELECT * FROM {self._qualified_partition(table, remainder)}"
                for remainder in remainders
            )
            relation = f"({branches})"
            if alias is None:
                alias = table
        return f"{relation} {alias}" if alias else relation

    def _physical_tables(
        self, table: str, user_names: list[str] | None, conn=None
    ) -> list[str]:
        """Real tables a write can target. A union subquery cannot be updated."""
        names = [name for name in (user_names or []) if name]
        if not names:
            return [
                self._qualified_partition(table, remainder)
                for remainder in range(self._shard_count())
            ]
        remainders = sorted({self._partition_remainder(name, conn) for name in names})
        return [self._qualified_partition(table, remainder) for remainder in remainders]

    def _physical_table(self, table: str, user_name: str | None, conn=None) -> str:
        """Return the one partition table PolarDB would address for this tenant."""
        if not user_name:
            return f"{self.schema}.{table}"
        return self._qualified_partition(table, self._partition_remainder(user_name, conn))

    def _vector_dim(self) -> int:
        dim = int(getattr(self.config, "embedding_dimension", 1024))
        if dim < 1 or dim > 4096:
            raise ValueError(f"Invalid embedding dimension: {dim}")
        return dim

    def _ensure_hnsw_search_settings(self, conn) -> None:
        """Match PolarDB's HNSW session settings once for each pooled connection."""
        ready = getattr(self, "_hnsw_ready_ids", None)
        if ready is None:
            ready = set()
            self._hnsw_ready_ids = ready
        marker = id(conn)
        if marker in ready:
            return
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT set_config('hnsw.ef_search', '100', false),
                       set_config('hnsw.iterative_scan', 'relaxed_order', false)
                """
            )
        ready.add(marker)

    def _projected_field_exprs(self, return_fields: list[str] | None) -> list[tuple[str, str]]:
        projected: list[tuple[str, str]] = []
        for field in self._validate_return_fields(return_fields):
            if field in {"id", "memory", "score", "user_name", "created_at", "updated_at"}:
                continue
            if field == "embedding":
                projected.append((field, "embedding"))
            else:
                projected.append((field, f"properties->'{field}'"))
        return projected

    @staticmethod
    def _decode_projected_value(value: Any) -> Any:
        if isinstance(value, str):
            try:
                return json.loads(value)
            except (json.JSONDecodeError, TypeError):
                return value
        return value

    def _build_projected_search_result(
        self, row: tuple[Any, ...], extra_fields: list[str]
    ) -> dict[str, Any]:
        created_at, updated_at = row[3], row[4]
        result: dict[str, Any] = {
            "id": row[0],
            "score": float(row[1]),
            "memory": row[2] or "",
            "user_name": row[5],
        }
        if created_at is not None:
            result["created_at"] = (
                created_at.isoformat() if hasattr(created_at, "isoformat") else created_at
            )
        if updated_at is not None:
            result["updated_at"] = (
                updated_at.isoformat() if hasattr(updated_at, "isoformat") else updated_at
            )
        for offset, field in enumerate(extra_fields):
            result[field] = self._decode_projected_value(row[6 + offset])
        return result

    def _append_user_name_condition(
        self, conditions: list[str], params: list[Any], user_names: list[str]
    ) -> None:
        if len(user_names) == 1:
            conditions.append("user_name = %s")
            params.append(user_names[0])
        elif user_names:
            conditions.append("user_name = ANY(%s)")
            params.append(user_names)

    def _build_search_conditions(
        self,
        params: list[Any],
        *,
        user_name: str | None = None,
        knowledgebase_ids: list[str] | None = None,
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        filter: dict | None = None,
        default_activated: bool = True,
    ) -> list[str]:
        conditions: list[str] = []
        user_names = self._effective_user_names(user_name, knowledgebase_ids)
        self._append_user_name_condition(conditions, params, user_names)
        if scope:
            conditions.append("properties->>'memory_type' = %s")
            params.append(scope)
        if status:
            conditions.append("properties->>'status' = %s")
            params.append(status)
        elif default_activated:
            conditions.append("properties->>'status' = 'activated'")

        for filter_dict in (search_filter, filter):
            if filter_dict:
                filter_sql = self._build_filter_where_clause(filter_dict, params)
                if filter_sql:
                    conditions.append(f"({filter_sql})")
        return conditions

    def _build_search_result(
        self, row: tuple[Any, ...], return_fields: list[str] | None
    ) -> dict[str, Any]:
        result: dict[str, Any] = {"id": row[0], "score": float(row[1])}
        fields = self._validate_return_fields(return_fields)
        if not fields:
            return result

        memory = row[2] or ""
        created_at, updated_at, user_name = row[4], row[5], row[6]
        raw_properties = row[3] if isinstance(row[3], dict) else json.loads(row[3] or "{}")
        properties = dict(raw_properties)
        properties["user_name"] = user_name
        properties.update(
            {
                "id": row[0],
                "memory": memory,
                "created_at": created_at.isoformat() if created_at else None,
                "updated_at": updated_at.isoformat() if updated_at else None,
                "user_name": user_name,
            }
        )
        for field in fields:
            if field != "id" and field in properties:
                result[field] = properties[field]
        return result

    def _build_keyword_result(
        self, row: tuple[Any, ...], return_fields: list[str] | None
    ) -> dict[str, Any]:
        result: dict[str, Any] = {"id": row[0]}
        fields = self._validate_return_fields(return_fields)
        if not fields:
            return result

        raw_properties = row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}")
        properties = dict(raw_properties)
        properties["user_name"] = row[5]
        properties.update(
            {
                "id": row[0],
                "memory": row[1] or "",
                "created_at": row[3].isoformat() if row[3] else None,
                "updated_at": row[4].isoformat() if row[4] else None,
                "user_name": row[5],
            }
        )
        for field in fields:
            if field != "id" and field in properties:
                result[field] = properties[field]
        return result

    def search_by_embedding(
        self,
        vector: list[float],
        user_name: str,
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        return_fields: list[str] | None = None,
        light_weight_mode: bool = False,
        **kwargs,
    ) -> list[dict]:
        """Search nodes by vector similarity using pgvector."""
        if light_weight_mode and not return_fields:
            return_fields = [
                "memory",
                "memory_type",
                "user_name",
                "status",
                "key",
                "tags",
                "confidence",
                "source",
            ]
        params: list[Any] = []
        conditions = ["embedding IS NOT NULL"]
        conditions.extend(
            self._build_search_conditions(
                params,
                user_name=user_name,
                knowledgebase_ids=knowledgebase_ids,
                scope=scope,
                status=status,
                search_filter=search_filter,
                filter=filter,
            )
        )
        where_clause = " AND ".join(conditions)
        relation = self._tenant_relation(
            "memories",
            self._effective_user_names(user_name, knowledgebase_ids),
        )

        # Match PolarDB: one distance, index-ordered LIMIT, then drop rows at or past 0.9.
        dim = self._vector_dim()
        distance_sql = "embedding <=> (SELECT query_vector FROM q)"
        conn = self._get_conn()
        try:
            self._ensure_hnsw_search_settings(conn)
            with conn.cursor() as cur:
                projected = (
                    self._projected_field_exprs(return_fields) if light_weight_mode else []
                )
                if light_weight_mode:
                    inner_columns = "memory, created_at, updated_at, user_name"
                    extra_inner = "".join(
                        f', {expression} AS "{field}"' for field, expression in projected
                    )
                    extra_outer = "".join(f', "{field}"' for field, _ in projected)
                else:
                    inner_columns = "memory, properties, created_at, updated_at, user_name"
                    extra_inner = ""
                    extra_outer = ""
                cur.execute(
                    f"""
                    WITH q AS (
                        SELECT %s::halfvec({dim}) AS query_vector
                    ),
                    t AS MATERIALIZED (
                        SELECT COALESCE(properties->>'id', id) AS id,
                               ({distance_sql}) AS scope_distance,
                               {inner_columns}
                               {extra_inner}
                        FROM {relation}
                        WHERE {where_clause}
                        ORDER BY {distance_sql}
                        LIMIT %s
                    )
                    SELECT id,
                           ((1 - scope_distance) + 1) / 2.0 AS score,
                           {inner_columns}
                           {extra_outer}
                    FROM t
                    WHERE scope_distance < 0.9
                    """,
                    (vector, *params, top_k),
                )

                results = []
                for row in cur.fetchall():
                    score = float(row[1])
                    if threshold is None or score >= threshold:
                        if light_weight_mode:
                            results.append(
                                self._build_projected_search_result(
                                    row, [field for field, _ in projected]
                                )
                            )
                        else:
                            results.append(self._build_search_result(row, return_fields))
                return results
        finally:
            self._put_conn(conn)

    def search_by_fulltext(
        self,
        query_words: list[str],
        top_k: int = 10,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        tsvector_field: str = "properties_tsvector_zh",
        tsquery_config: str = "jiebacfg",
        return_fields: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Search with PolarDB's AND tsquery on one tenant partition."""
        terms = [str(word).strip() for word in query_words if str(word).strip()]
        if not terms:
            return []

        query_config = tsquery_config or getattr(self.config, "fulltext_config", "simple")
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", query_config):
            raise ValueError(f"Invalid PostgreSQL text search config: {query_config}")
        quoted_terms = []
        for term in terms:
            if len(term) >= 2 and term[0] == term[-1] and term[0] in {"'", '"'}:
                term = term[1:-1]
            quoted_terms.append("'" + term.replace("'", "''") + "'")
        params: list[Any] = [" & ".join(quoted_terms)]
        conditions = self._build_search_conditions(
            params,
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            scope=scope,
            status=status,
            search_filter=search_filter,
            filter=filter,
        )
        where_clause = " AND ".join(conditions) if conditions else "TRUE"
        relation = self._tenant_relation(
            "memories",
            self._effective_user_names(user_name, knowledgebase_ids),
        )

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    WITH q AS (
                        SELECT to_tsquery('{query_config}', %s) AS query
                    )
                    SELECT COALESCE(properties->>'id', id) AS id,
                           ts_rank(search_vector, q.query) AS score,
                           memory, properties, created_at, updated_at, user_name
                    FROM {relation}
                    CROSS JOIN q
                    WHERE {where_clause}
                      AND search_vector @@ q.query
                    ORDER BY score DESC, updated_at DESC
                    LIMIT %s
                    """,
                    (*params, top_k),
                )
                output = []
                for row in cur.fetchall():
                    result = self._build_search_result(row, return_fields)
                    if threshold is None or result["score"] >= threshold:
                        output.append(result)
                return output
        finally:
            self._put_conn(conn)

    def search_by_keywords_tfidf(
        self,
        query_words: list[str],
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        tsvector_field: str = "properties_tsvector_zh",
        tsquery_config: str = "jiebaqry",
        return_fields: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Return keyword matches with PolarDB's OR tsquery and no score."""
        if not user_name:
            return []
        terms = [str(word).strip() for word in query_words if str(word).strip()]
        if not terms:
            return []

        query_config = tsquery_config or getattr(self.config, "fulltext_config", "simple")
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", query_config):
            raise ValueError(f"Invalid PostgreSQL text search config: {query_config}")
        quoted_terms = []
        for term in terms:
            if len(term) >= 2 and term[0] == term[-1] and term[0] in {"'", '"'}:
                term = term[1:-1]
            quoted_terms.append("'" + term.replace("'", "''") + "'")
        params: list[Any] = [" | ".join(quoted_terms)]
        conditions = self._build_search_conditions(
            params,
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            scope=scope,
            status=status,
            search_filter=search_filter,
            filter=filter,
        )
        where_clause = " AND ".join(conditions) if conditions else "TRUE"
        relation = self._tenant_relation(
            "memories",
            self._effective_user_names(user_name, knowledgebase_ids),
        )

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    WITH q AS (
                        SELECT to_tsquery('{query_config}', %s) AS query
                    )
                    SELECT COALESCE(properties->>'id', id) AS id, memory, properties, created_at, updated_at, user_name
                    FROM {relation}
                    CROSS JOIN q
                    WHERE {where_clause}
                      AND search_vector @@ q.query
                    """,
                    (*params,),
                )
                return [self._build_keyword_result(row, return_fields) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def search_by_keywords_like(
        self,
        query_word: str,
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        return_fields: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Fallback substring search compatible with the PolarDB adapter."""
        if not user_name:
            return []
        pattern = f"%{query_word}%"
        params: list[Any] = []
        conditions = self._build_search_conditions(
            params,
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            search_filter=search_filter,
            filter=filter,
            status=status,
            scope=scope,
        )
        conditions.append("COALESCE(properties->>'memory', '') LIKE %s")
        params.append(pattern)
        relation = self._tenant_relation(
            "memories",
            self._effective_user_names(user_name, knowledgebase_ids),
        )

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT COALESCE(properties->>'id', id) AS id, memory, properties, created_at, updated_at, user_name
                    FROM {relation}
                    WHERE {" AND ".join(conditions)}
                    """,
                    params,
                )
                return [self._build_keyword_result(row, return_fields) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
        user_name_flag: bool = True,
        status: str | None = None,
        **kwargs,
    ) -> list[str]:
        """Get node IDs matching metadata filters."""
        if not user_name:
            raise ValueError("get_by_metadata requires user_name")
        conditions: list[str] = []
        params: list[Any] = []
        user_names: list[str] = []

        if user_name_flag:
            user_names = self._effective_user_names(user_name, knowledgebase_ids)
            self._append_user_name_condition(conditions, params, user_names)

        if status:
            conditions.append("properties->>'status' = %s")
            params.append(status)

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]
            text_expr, json_expr = self._field_expr(field)

            if op == "=":
                conditions.append(f"{text_expr} = %s")
                params.append(str(value))
            elif op == "in":
                if not isinstance(value, list):
                    raise ValueError("in operator expects a list")
                conditions.append(f"{text_expr} = ANY(%s)")
                params.append([str(item) for item in value])
            elif op in (">", ">=", "<", "<="):
                conditions.append(f"NULLIF({text_expr}, '')::numeric {op} %s")
                params.append(value)
            elif op == "contains":
                values = value if isinstance(value, list) else [value]
                or_parts = []
                for item in values:
                    or_parts.append(f"{json_expr} @> %s::jsonb")
                    params.append(json.dumps([item], ensure_ascii=False))
                conditions.append("(" + " OR ".join(or_parts) + ")")
            elif op == "like":
                conditions.append(f"{text_expr} LIKE %s")
                params.append(f"%{value}%")
            elif op == "starts_with":
                conditions.append(f"{text_expr} LIKE %s")
                params.append(f"{value}%")
            elif op == "ends_with":
                conditions.append(f"{text_expr} LIKE %s")
                params.append(f"%{value}")
            else:
                raise ValueError(f"Unsupported operator: {op}")

        if filter:
            filter_sql = self._build_filter_where_clause(filter, params)
            if filter_sql:
                conditions.append(f"({filter_sql})")

        where_clause = " AND ".join(conditions) if conditions else "TRUE"
        relation = self._tenant_relation("memories", user_names)

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id FROM {relation}
                    WHERE {where_clause}
                """,
                    params,
                )
                return [row[0] for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_all_memory_items(
        self,
        scope: str,
        user_name: str | None = None,
        include_embedding: bool = False,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
        status: str | None = None,
    ) -> list[dict]:
        """Get all memory items of a specific type."""
        if not user_name:
            return []
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        params: list[Any] = []
        conditions = self._build_search_conditions(
            params,
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            scope=scope,
            status=status,
            filter=filter,
            default_activated=False,
        )

        where_clause = " AND ".join(conditions) if conditions else "TRUE"
        relation = self._tenant_relation(
            "memories",
            self._effective_user_names(user_name, knowledgebase_ids),
        )

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cols += ", user_name"
                cur.execute(
                    f"""
                    SELECT {cols} FROM {relation}
                    WHERE {where_clause}
                    LIMIT 100
                """,
                    params,
                )
                return [self._parse_row(row, include_embedding) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_structure_optimization_candidates(
        self,
        scope: str,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict]:
        """Find isolated nodes (no edges)."""
        if not user_name:
            raise ValueError("get_structure_optimization_candidates requires user_name")
        memories = self._tenant_relation("memories", [user_name])
        edges = self._tenant_relation("edges", [user_name])
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "m.id, m.memory, m.properties, m.created_at, m.updated_at"
                if include_embedding:
                    cols += ", m.embedding"
                cols += ", m.user_name"
                cur.execute(
                    f"""
                    SELECT {cols}
                    FROM {memories} m
                    LEFT JOIN {edges} e1
                      ON m.id = e1.source_id
                     AND e1.user_name = m.user_name
                     AND e1.edge_type = 'PARENT'
                    LEFT JOIN {edges} e2
                      ON m.id = e2.target_id
                     AND e2.user_name = m.user_name
                     AND e2.edge_type = 'PARENT'
                    WHERE m.properties->>'memory_type' = %s
                      AND m.user_name = %s
                      AND m.properties->>'status' = 'activated'
                      AND e1.id IS NULL
                      AND e2.id IS NULL
                    """,
                    (scope, user_name),
                )
                return [self._parse_row(row, include_embedding) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    # =========================================================================
    # Maintenance
    # =========================================================================

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        """Count active memories of one type for a tenant."""
        user_name = user_name or self.user_name
        relation = self._tenant_relation("memories", [user_name] if user_name else [])
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM {relation}
                    WHERE user_name = %s
                      AND properties->>'memory_type' = %s
                      AND COALESCE(properties->>'status', 'activated') = 'activated'
                    """,
                    (user_name, memory_type),
                )
                row = cur.fetchone()
                return int(row[0]) if row else 0
        finally:
            self._put_conn(conn)

    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        """Return 1 when no active node exists for the requested scope."""
        return int(self.get_memory_count(scope, user_name=user_name) == 0)

    def count_nodes(self, scope: str, user_name: str | None = None) -> int:
        """Compatibility alias for memory counts."""
        return self.get_memory_count(scope, user_name=user_name)

    def get_user_names_by_memory_ids(self, memory_ids: list[str]) -> dict[str, str | None]:
        normalized_ids = list(
            dict.fromkeys(
                str(memory_id).strip() for memory_id in memory_ids if str(memory_id).strip()
            )
        )
        if not normalized_ids:
            return {}
        result: dict[str, str | None] = dict.fromkeys(normalized_ids)
        memories = self._all_partitions_relation("memories")
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, user_name
                    FROM {memories}
                    WHERE id = ANY(%s)
                    """,
                    (normalized_ids,),
                )
                result.update({str(row[0]): row[1] for row in cur.fetchall()})
                return result
        finally:
            self._put_conn(conn)

    def exist_user_name(self, user_name: str) -> dict[str, bool]:
        memories = self._physical_table("memories", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT EXISTS(SELECT 1 FROM {memories} WHERE user_name = %s)",
                    (user_name,),
                )
                row = cur.fetchone()
                return {user_name: bool(row and row[0])}
        finally:
            self._put_conn(conn)

    def delete_node_by_mem_cube_id(
        self,
        mem_cube_id: str,
        delete_record_id: str,
        hard_delete: bool = False,
    ) -> int:
        """Soft-delete a tenant's memories, or purge a previously deleted batch."""
        if not mem_cube_id:
            raise ValueError("delete_node_by_mem_cube_id mem_cube_id is required")
        if not delete_record_id:
            raise ValueError("delete_node_by_mem_cube_id delete_record_id is required")

        memories = self._physical_table("memories", mem_cube_id)
        edges = self._physical_table("edges", mem_cube_id)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                if hard_delete:
                    cur.execute(
                        f"""
                        WITH deleted AS (
                            DELETE FROM {memories}
                            WHERE user_name = %s
                              AND properties->>'delete_record_id' = %s
                            RETURNING id
                        ), deleted_edges AS (
                            DELETE FROM {edges} e
                            USING deleted d
                            WHERE e.user_name = %s
                              AND (e.source_id = d.id OR e.target_id = d.id)
                            RETURNING e.id
                        )
                        SELECT COUNT(*) FROM deleted
                        """,
                        (mem_cube_id, delete_record_id, mem_cube_id),
                    )
                    row = cur.fetchone()
                    return int(row[0]) if row else 0
                else:
                    deleted_at = datetime.now(timezone.utc).isoformat()
                    cur.execute(
                        f"""
                        UPDATE {memories}
                        SET properties = properties || %s::jsonb,
                            deleted_at = %s::timestamptz,
                            updated_at = NOW()
                        WHERE user_name = %s
                          AND COALESCE(properties->>'status', 'activated') <> 'deleted'
                        """,
                        (
                            json.dumps(
                                {
                                    "status": "deleted",
                                    "delete_time": deleted_at,
                                    "delete_record_id": delete_record_id,
                                }
                            ),
                            deleted_at,
                            mem_cube_id,
                        ),
                    )
                return max(int(cur.rowcount or 0), 0)
        finally:
            self._put_conn(conn)

    def recover_memory_by_mem_cube_id(
        self,
        mem_cube_id: str,
        delete_record_id: str,
    ) -> int:
        """Recover one tenant soft-delete batch."""
        if not mem_cube_id:
            raise ValueError("recover_memory_by_mem_cube_id mem_cube_id is required")
        if not delete_record_id:
            raise ValueError("recover_memory_by_mem_cube_id delete_record_id is required")

        memories = self._physical_table("memories", mem_cube_id)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {memories}
                    SET properties = properties || %s::jsonb,
                        deleted_at = NULL,
                        updated_at = NOW()
                    WHERE user_name = %s
                      AND properties->>'delete_record_id' = %s
                      AND properties->>'status' = 'deleted'
                    """,
                    (
                        json.dumps(
                            {
                                "status": "activated",
                                "delete_time": "",
                                "delete_record_id": "",
                            }
                        ),
                        mem_cube_id,
                        delete_record_id,
                    ),
                )
                return max(int(cur.rowcount or 0), 0)
        finally:
            self._put_conn(conn)

    def drop_database(self) -> None:
        """Compatibility operation: clear only the configured tenant.

        The standard PostgreSQL backend is shared, so dropping the physical
        database or schema would delete other tenants.
        """
        self.clear(user_name=self.user_name)

    def deduplicate_nodes(self) -> None:
        """Not implemented - handled at application level."""

    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Count nodes grouped by specified fields.

        Args:
            group_fields: Fields to group by, e.g., ["memory_type", "status"]
            where_clause: Extra WHERE condition
            params: Parameters for WHERE clause
            user_name: User to filter by

        Returns:
            list[dict]: e.g., [{'memory_type': 'WorkingMemory', 'count': 10}, ...]
        """
        user_name = user_name or self.user_name
        if not group_fields:
            raise ValueError("group_fields cannot be empty")
        if any(not self._is_safe_field_name(field) for field in group_fields):
            raise ValueError("group_fields contains an invalid field name")

        # Build SELECT and GROUP BY clauses
        # Fields come from JSONB properties column
        select_fields = ", ".join([f"properties->>'{field}' AS {field}" for field in group_fields])
        group_by = ", ".join([f"properties->>'{field}'" for field in group_fields])

        # Build WHERE clause
        conditions = ["user_name = %s"]
        query_params = [user_name]

        if where_clause:
            # Parse simple where clause format
            where_clause = where_clause.strip()
            if where_clause.upper().startswith("WHERE"):
                where_clause = where_clause[5:].strip()
            if where_clause:
                conditions.append(where_clause)
                if params:
                    query_params.extend(params.values())

        where_sql = " AND ".join(conditions)
        memories = self._physical_table("memories", user_name)

        query = f"""
            SELECT {select_fields}, COUNT(*) AS count
            FROM {memories}
            WHERE {where_sql}
            GROUP BY {group_by}
        """

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(query, query_params)
                results = []
                for row in cur.fetchall():
                    result = {}
                    for i, field in enumerate(group_fields):
                        result[field] = row[i]
                    result["count"] = row[len(group_fields)]
                    results.append(result)
                return results
        finally:
            self._put_conn(conn)

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """Not implemented."""
        return []

    def merge_nodes(self, id1: str, id2: str) -> str:
        """Not implemented."""
        raise NotImplementedError

    def clear(self, user_name: str | None = None) -> None:
        """Clear all data for user."""
        user_name = user_name or self.user_name
        memories = self._physical_table("memories", user_name)
        edges = self._physical_table("edges", user_name)
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Get all node IDs for user
                cur.execute(
                    f"""
                    SELECT id FROM {memories} WHERE user_name = %s
                """,
                    (user_name,),
                )
                ids = [row[0] for row in cur.fetchall()]

                if ids:
                    # Delete edges
                    cur.execute(
                        f"""
                        DELETE FROM {edges}
                        WHERE user_name = %s
                          AND (source_id = ANY(%s) OR target_id = ANY(%s))
                    """,
                        (user_name, ids, ids),
                    )

                # Delete nodes
                cur.execute(
                    f"""
                    DELETE FROM {memories} WHERE user_name = %s
                """,
                    (user_name,),
                )
                logger.info(f"Cleared all data for user {user_name}")
        finally:
            self._put_conn(conn)

    def export_graph(
        self,
        user_name: str | None = None,
        include_embedding: bool = False,
        user_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        filter: dict | None = None,
        memory_type: list[str] | None = None,
        status: list[str] | None = None,
        **kwargs,
    ) -> dict[str, Any]:
        """Export memories with the same filters and pagination as PolarDB."""

        extracted_object_type: str | None = None
        extracted_mem_cube_id: str | None = None

        def extract_special_values(value: Any) -> Any:
            nonlocal extracted_object_type, extracted_mem_cube_id
            if not isinstance(value, dict):
                return value
            cleaned: dict[str, Any] = {}
            for key, item in value.items():
                if key in {"and", "or"} and isinstance(item, list):
                    children = [extract_special_values(child) for child in item]
                    children = [child for child in children if child not in (None, {}, [])]
                    if children:
                        cleaned[key] = children
                elif key == "object_type" and isinstance(item, str):
                    extracted_object_type = extracted_object_type or item
                elif key == "mem_cube_id" and isinstance(item, str):
                    extracted_mem_cube_id = extracted_mem_cube_id or item
                else:
                    cleaned[key] = item
            return cleaned or None

        filter_for_sql = extract_special_values(filter)
        conditions: list[str] = []
        params: list[Any] = []
        has_object_filter = bool(extracted_object_type and extracted_mem_cube_id)
        object_type = (extracted_object_type or "").strip().lower()

        if has_object_filter:
            if object_type == "user":
                conditions.append("user_name <> %s")
                params.append(extracted_mem_cube_id)
            elif object_type == "public":
                conditions.append("user_name = %s")
                params.append(extracted_mem_cube_id)
        elif user_name:
            conditions.append("user_name = %s")
            params.append(user_name)

        effective_user_id = user_id or getattr(self.config, "user_id", None)
        if effective_user_id:
            conditions.append("properties->>'user_id' = %s")
            params.append(effective_user_id)
        if memory_type:
            conditions.append("properties->>'memory_type' = ANY(%s)")
            params.append([str(item) for item in memory_type])
        if status:
            conditions.append("properties->>'status' = ANY(%s)")
            params.append([str(item) for item in status])
        else:
            conditions.append("COALESCE(properties->>'status', 'activated') <> 'deleted'")
            conditions.append("deleted_at IS NULL")
        if filter_for_sql:
            filter_sql = self._build_filter_where_clause(filter_for_sql, params)
            if filter_sql:
                conditions.append(f"({filter_sql})")

        where_clause = " AND ".join(conditions) if conditions else "TRUE"
        target_user = user_name
        if has_object_filter and object_type == "public":
            target_user = extracted_mem_cube_id
        elif has_object_filter and object_type == "user":
            target_user = None
        memories = self._physical_table("memories", target_user)
        use_pagination = page is not None and page_size is not None
        if use_pagination:
            page = max(int(page), 1)
            page_size = max(int(page_size), 1)
            offset = (page - 1) * page_size

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT COUNT(*) FROM {memories} WHERE {where_clause}",
                    params,
                )
                count_row = cur.fetchone()
                total_nodes = int(count_row[0]) if count_row else 0

                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cols += ", user_name"
                pagination_sql = ""
                data_params = list(params)
                if use_pagination:
                    pagination_sql = "LIMIT %s OFFSET %s"
                    data_params.extend([page_size, offset])
                cur.execute(
                    f"""
                    SELECT {cols}
                    FROM {memories}
                    WHERE {where_clause}
                    ORDER BY created_at DESC NULLS LAST, id DESC
                    {pagination_sql}
                    """,
                    data_params,
                )
                nodes = [self._parse_row(row, include_embedding) for row in cur.fetchall()]

                node_ids = [n["id"] for n in nodes]
                node_user_names = [
                    n.get("metadata", {}).get("user_name") or user_name for n in nodes
                ]
                if node_ids and all(node_user_names):
                    edges_table = self._tenant_relation(
                        "edges",
                        list(dict.fromkeys(str(name) for name in node_user_names if name)),
                        alias="e",
                        conn=conn,
                    )
                    cur.execute(
                        f"""
                        WITH selected_nodes(user_name, node_id) AS (
                            SELECT * FROM unnest(%s::text[], %s::text[])
                        )
                        SELECT e.source_id, e.target_id, e.edge_type
                        FROM {edges_table}
                        JOIN selected_nodes AS source_node
                          ON source_node.user_name = e.user_name
                         AND source_node.node_id = e.source_id
                        JOIN selected_nodes AS target_node
                          ON target_node.user_name = e.user_name
                         AND target_node.node_id = e.target_id
                        ORDER BY e.id
                        """,
                        (node_user_names, node_ids),
                    )
                    edges = [
                        {"source": row[0], "target": row[1], "type": row[2]}
                        for row in cur.fetchall()
                    ]
                else:
                    edges = []

                return {
                    "nodes": nodes,
                    "edges": edges,
                    "total_nodes": total_nodes,
                    "total_edges": len(edges),
                }
        finally:
            self._put_conn(conn)

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
                user_name=user_name,
            )


    def close(self):
        """Close connection pool."""
        if not self._pool_closed:
            self._pool_closed = True
            self.pool.closeall()

