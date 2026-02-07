"""
PostgreSQL + pgvector backend for MemOS.

Simple implementation using standard PostgreSQL with pgvector extension.
No Apache AGE or other graph extensions required.

Tables:
- {schema}.memories: Memory nodes with JSONB properties and vector embeddings
- {schema}.edges: Relationships between memory nodes
"""

import json
import time

from contextlib import suppress
from datetime import datetime
from typing import Any, Literal

from memos.configs.graph_db import PostgresGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


def _prepare_node_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Ensure metadata has proper datetime fields and normalized types."""
    now = datetime.utcnow().isoformat()
    metadata.setdefault("created_at", now)
    metadata.setdefault("updated_at", now)

    # Normalize embedding type
    embedding = metadata.get("embedding")
    if embedding and isinstance(embedding, list):
        metadata["embedding"] = [float(x) for x in embedding]

    return metadata


class PostgresGraphDB(BaseGraphDB):
    """PostgreSQL + pgvector implementation of a graph memory store."""

    @require_python_package(
        import_name="psycopg2",
        install_command="pip install psycopg2-binary",
        install_link="https://pypi.org/project/psycopg2-binary/",
    )
    def __init__(self, config: PostgresGraphDBConfig):
        """Initialize PostgreSQL connection pool."""
        import psycopg2
        import psycopg2.pool

        self.config = config
        self.schema = config.schema_name
        self.user_name = config.user_name
        self._pool_closed = False

        logger.info(f"Connecting to PostgreSQL: {config.host}:{config.port}/{config.db_name}")

        # Create connection pool
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=2,
            maxconn=config.maxconn,
            host=config.host,
            port=config.port,
            user=config.user,
            password=config.password,
            dbname=config.db_name,
            connect_timeout=30,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )

        # Initialize schema and tables
        self._init_schema()

    def _get_conn(self):
        """Get connection from pool with health check."""
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
                # Health check
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
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
        """Create schema and tables if they don't exist."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Create schema
                cur.execute(f"CREATE SCHEMA IF NOT EXISTS {self.schema}")

                # Enable pgvector
                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")

                # Create memories table
                dim = self.config.embedding_dimension
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self.schema}.memories (
                        id TEXT PRIMARY KEY,
                        memory TEXT NOT NULL DEFAULT '',
                        properties JSONB NOT NULL DEFAULT '{{}}',
                        embedding vector({dim}),
                        user_name TEXT,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    )
                """)

                # Create edges table
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self.schema}.edges (
                        id SERIAL PRIMARY KEY,
                        source_id TEXT NOT NULL,
                        target_id TEXT NOT NULL,
                        edge_type TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        UNIQUE(source_id, target_id, edge_type)
                    )
                """)

                # Create indexes
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memories_user
                    ON {self.schema}.memories(user_name)
                """)
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memories_props
                    ON {self.schema}.memories USING GIN(properties)
                """)
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memories_embedding
                    ON {self.schema}.memories USING ivfflat(embedding vector_cosine_ops)
                    WITH (lists = 100)
                """)
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_source
                    ON {self.schema}.edges(source_id)
                """)
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_target
                    ON {self.schema}.edges(target_id)
                """)

                logger.info(f"Schema {self.schema} initialized successfully")
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

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Find IDs to delete (older than the keep_latest entries)
                cur.execute(f"""
                    WITH ranked AS (
                        SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC) as rn
                        FROM {self.schema}.memories
                        WHERE user_name = %s
                        AND properties->>'memory_type' = %s
                    )
                    SELECT id FROM ranked WHERE rn > %s
                """, (user_name, memory_type, keep_latest))

                ids_to_delete = [row[0] for row in cur.fetchall()]

                if ids_to_delete:
                    # Delete edges first
                    cur.execute(f"""
                        DELETE FROM {self.schema}.edges
                        WHERE source_id = ANY(%s) OR target_id = ANY(%s)
                    """, (ids_to_delete, ids_to_delete))

                    # Delete nodes
                    cur.execute(f"""
                        DELETE FROM {self.schema}.memories
                        WHERE id = ANY(%s)
                    """, (ids_to_delete,))

                    logger.info(f"Removed {len(ids_to_delete)} oldest {memory_type} memories for user {user_name}")
        finally:
            self._put_conn(conn)

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Add a memory node."""
        user_name = user_name or self.user_name
        metadata = _prepare_node_metadata(metadata.copy())

        # Extract embedding
        embedding = metadata.pop("embedding", None)
        created_at = metadata.pop("created_at", datetime.utcnow().isoformat())
        updated_at = metadata.pop("updated_at", datetime.utcnow().isoformat())

        # Serialize sources if present
        if metadata.get("sources"):
            metadata["sources"] = [
                json.dumps(s) if not isinstance(s, str) else s
                for s in metadata["sources"]
            ]

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                if embedding:
                    cur.execute(f"""
                        INSERT INTO {self.schema}.memories
                        (id, memory, properties, embedding, user_name, created_at, updated_at)
                        VALUES (%s, %s, %s, %s::vector, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET
                            memory = EXCLUDED.memory,
                            properties = EXCLUDED.properties,
                            embedding = EXCLUDED.embedding,
                            updated_at = EXCLUDED.updated_at
                    """, (id, memory, json.dumps(metadata), embedding, user_name, created_at, updated_at))
                else:
                    cur.execute(f"""
                        INSERT INTO {self.schema}.memories
                        (id, memory, properties, user_name, created_at, updated_at)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET
                            memory = EXCLUDED.memory,
                            properties = EXCLUDED.properties,
                            updated_at = EXCLUDED.updated_at
                    """, (id, memory, json.dumps(metadata), user_name, created_at, updated_at))
        finally:
            self._put_conn(conn)

    def add_nodes_batch(
        self, nodes: list[dict[str, Any]], user_name: str | None = None
    ) -> None:
        """Batch add memory nodes."""
        for node in nodes:
            self.add_node(
                id=node["id"],
                memory=node["memory"],
                metadata=node.get("metadata", {}),
                user_name=user_name,
            )

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """Update node fields."""
        user_name = user_name or self.user_name
        if not fields:
            return

        # Get current node
        current = self.get_node(id, user_name=user_name)
        if not current:
            return

        # Merge properties
        props = current.get("metadata", {}).copy()
        embedding = fields.pop("embedding", None)
        memory = fields.pop("memory", current.get("memory", ""))
        props.update(fields)
        props["updated_at"] = datetime.utcnow().isoformat()

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                if embedding:
                    cur.execute(f"""
                        UPDATE {self.schema}.memories
                        SET memory = %s, properties = %s, embedding = %s::vector, updated_at = NOW()
                        WHERE id = %s AND user_name = %s
                    """, (memory, json.dumps(props), embedding, id, user_name))
                else:
                    cur.execute(f"""
                        UPDATE {self.schema}.memories
                        SET memory = %s, properties = %s, updated_at = NOW()
                        WHERE id = %s AND user_name = %s
                    """, (memory, json.dumps(props), id, user_name))
        finally:
            self._put_conn(conn)

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """Delete a node and its edges."""
        user_name = user_name or self.user_name
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Delete edges
                cur.execute(f"""
                    DELETE FROM {self.schema}.edges
                    WHERE source_id = %s OR target_id = %s
                """, (id, id))
                # Delete node
                cur.execute(f"""
                    DELETE FROM {self.schema}.memories
                    WHERE id = %s AND user_name = %s
                """, (id, user_name))
        finally:
            self._put_conn(conn)

    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        """Get a single node by ID."""
        user_name = kwargs.get("user_name") or self.user_name
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cur.execute(f"""
                    SELECT {cols} FROM {self.schema}.memories
                    WHERE id = %s AND user_name = %s
                """, (id, user_name))
                row = cur.fetchone()
                if not row:
                    return None
                return self._parse_row(row, include_embedding)
        finally:
            self._put_conn(conn)

    def get_nodes(
        self, ids: list, include_embedding: bool = False, **kwargs
    ) -> list[dict[str, Any]]:
        """Get multiple nodes by IDs."""
        if not ids:
            return []
        user_name = kwargs.get("user_name") or self.user_name
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cur.execute(f"""
                    SELECT {cols} FROM {self.schema}.memories
                    WHERE id = ANY(%s) AND user_name = %s
                """, (ids, user_name))
                return [self._parse_row(row, include_embedding) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def _parse_row(self, row, include_embedding: bool = False) -> dict[str, Any]:
        """Parse database row to node dict."""
        props = row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}")
        props["created_at"] = row[3].isoformat() if row[3] else None
        props["updated_at"] = row[4].isoformat() if row[4] else None
        result = {
            "id": row[0],
            "memory": row[1] or "",
            "metadata": props,
        }
        if include_embedding and len(row) > 5:
            result["metadata"]["embedding"] = row[5]
        return result

    # =========================================================================
    # Edge Management
    # =========================================================================

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Create an edge between nodes."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    INSERT INTO {self.schema}.edges (source_id, target_id, edge_type)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (source_id, target_id, edge_type) DO NOTHING
                """, (source_id, target_id, type))
        finally:
            self._put_conn(conn)

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Delete an edge."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    DELETE FROM {self.schema}.edges
                    WHERE source_id = %s AND target_id = %s AND edge_type = %s
                """, (source_id, target_id, type))
        finally:
            self._put_conn(conn)

    def edge_exists(self, source_id: str, target_id: str, type: str) -> bool:
        """Check if edge exists."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT 1 FROM {self.schema}.edges
                    WHERE source_id = %s AND target_id = %s AND edge_type = %s
                    LIMIT 1
                """, (source_id, target_id, type))
                return cur.fetchone() is not None
        finally:
            self._put_conn(conn)

    # =========================================================================
    # Graph Queries
    # =========================================================================

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """Get neighboring node IDs."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                if direction == "out":
                    cur.execute(f"""
                        SELECT target_id FROM {self.schema}.edges
                        WHERE source_id = %s AND edge_type = %s
                    """, (id, type))
                elif direction == "in":
                    cur.execute(f"""
                        SELECT source_id FROM {self.schema}.edges
                        WHERE target_id = %s AND edge_type = %s
                    """, (id, type))
                else:  # both
                    cur.execute(f"""
                        SELECT target_id FROM {self.schema}.edges WHERE source_id = %s AND edge_type = %s
                        UNION
                        SELECT source_id FROM {self.schema}.edges WHERE target_id = %s AND edge_type = %s
                    """, (id, type, id, type))
                return [row[0] for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """Get path between nodes using recursive CTE."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    WITH RECURSIVE path AS (
                        SELECT source_id, target_id, ARRAY[source_id] as nodes, 1 as depth
                        FROM {self.schema}.edges
                        WHERE source_id = %s
                        UNION ALL
                        SELECT e.source_id, e.target_id, p.nodes || e.source_id, p.depth + 1
                        FROM {self.schema}.edges e
                        JOIN path p ON e.source_id = p.target_id
                        WHERE p.depth < %s AND NOT e.source_id = ANY(p.nodes)
                    )
                    SELECT nodes || target_id as full_path
                    FROM path
                    WHERE target_id = %s
                    ORDER BY depth
                    LIMIT 1
                """, (source_id, max_depth, target_id))
                row = cur.fetchone()
                return row[0] if row else []
        finally:
            self._put_conn(conn)

    def get_subgraph(self, center_id: str, depth: int = 2) -> list[str]:
        """Get subgraph around center node."""
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    WITH RECURSIVE subgraph AS (
                        SELECT %s::text as node_id, 0 as level
                        UNION
                        SELECT CASE WHEN e.source_id = s.node_id THEN e.target_id ELSE e.source_id END,
                               s.level + 1
                        FROM {self.schema}.edges e
                        JOIN subgraph s ON (e.source_id = s.node_id OR e.target_id = s.node_id)
                        WHERE s.level < %s
                    )
                    SELECT DISTINCT node_id FROM subgraph
                """, (center_id, depth))
                return [row[0] for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """Get ordered chain following relationship type."""
        return self.get_neighbors(id, type, "out")

    # =========================================================================
    # Search Operations
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
        """Search nodes by vector similarity using pgvector."""
        user_name = user_name or self.user_name

        # Build WHERE clause
        conditions = ["embedding IS NOT NULL"]
        params = []

        if user_name:
            conditions.append("user_name = %s")
            params.append(user_name)

        if scope:
            conditions.append("properties->>'memory_type' = %s")
            params.append(scope)

        if status:
            conditions.append("properties->>'status' = %s")
            params.append(status)
        else:
            conditions.append("(properties->>'status' = 'activated' OR properties->>'status' IS NULL)")

        if search_filter:
            for k, v in search_filter.items():
                conditions.append(f"properties->>'{k}' = %s")
                params.append(str(v))

        where_clause = " AND ".join(conditions)

        # pgvector cosine distance: 1 - (a <=> b) gives similarity score
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT id, 1 - (embedding <=> %s::vector) as score
                    FROM {self.schema}.memories
                    WHERE {where_clause}
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """, (vector, *params, vector, top_k))

                results = []
                for row in cur.fetchall():
                    score = float(row[1])
                    if threshold is None or score >= threshold:
                        results.append({"id": row[0], "score": score})
                return results
        finally:
            self._put_conn(conn)

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

        conditions = []
        params = []

        if user_name_flag and user_name:
            conditions.append("user_name = %s")
            params.append(user_name)

        if status:
            conditions.append("properties->>'status' = %s")
            params.append(status)

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]

            if op == "=":
                conditions.append(f"properties->>'{field}' = %s")
                params.append(str(value))
            elif op == "in":
                placeholders = ",".join(["%s"] * len(value))
                conditions.append(f"properties->>'{field}' IN ({placeholders})")
                params.extend([str(v) for v in value])
            elif op in (">", ">=", "<", "<="):
                conditions.append(f"(properties->>'{field}')::numeric {op} %s")
                params.append(value)
            elif op == "contains":
                conditions.append(f"properties->'{field}' @> %s::jsonb")
                params.append(json.dumps([value]))

        where_clause = " AND ".join(conditions) if conditions else "TRUE"

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT id FROM {self.schema}.memories
                    WHERE {where_clause}
                """, params)
                return [row[0] for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        status: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Get all memory items of a specific type."""
        user_name = kwargs.get("user_name") or self.user_name

        conditions = ["properties->>'memory_type' = %s", "user_name = %s"]
        params = [scope, user_name]

        if status:
            conditions.append("properties->>'status' = %s")
            params.append(status)

        where_clause = " AND ".join(conditions)

        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cur.execute(f"""
                    SELECT {cols} FROM {self.schema}.memories
                    WHERE {where_clause}
                """, params)
                return [self._parse_row(row, include_embedding) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False
    ) -> list[dict]:
        """Find isolated nodes (no edges)."""
        user_name = self.user_name
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cols = "m.id, m.memory, m.properties, m.created_at, m.updated_at"
                cur.execute(f"""
                    SELECT {cols}
                    FROM {self.schema}.memories m
                    LEFT JOIN {self.schema}.edges e1 ON m.id = e1.source_id
                    LEFT JOIN {self.schema}.edges e2 ON m.id = e2.target_id
                    WHERE m.properties->>'memory_type' = %s
                      AND m.user_name = %s
                      AND m.properties->>'status' = 'activated'
                      AND e1.id IS NULL
                      AND e2.id IS NULL
                """, (scope, user_name))
                return [self._parse_row(row, False) for row in cur.fetchall()]
        finally:
            self._put_conn(conn)

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

        # Build SELECT and GROUP BY clauses
        # Fields come from JSONB properties column
        select_fields = ", ".join([
            f"properties->>'{field}' AS {field}" for field in group_fields
        ])
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

        query = f"""
            SELECT {select_fields}, COUNT(*) AS count
            FROM {self.schema}.memories
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
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Get all node IDs for user
                cur.execute(f"""
                    SELECT id FROM {self.schema}.memories WHERE user_name = %s
                """, (user_name,))
                ids = [row[0] for row in cur.fetchall()]

                if ids:
                    # Delete edges
                    cur.execute(f"""
                        DELETE FROM {self.schema}.edges
                        WHERE source_id = ANY(%s) OR target_id = ANY(%s)
                    """, (ids, ids))

                # Delete nodes
                cur.execute(f"""
                    DELETE FROM {self.schema}.memories WHERE user_name = %s
                """, (user_name,))
                logger.info(f"Cleared all data for user {user_name}")
        finally:
            self._put_conn(conn)

    def export_graph(self, include_embedding: bool = False, **kwargs) -> dict[str, Any]:
        """Export all data."""
        user_name = kwargs.get("user_name") or self.user_name
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                # Get nodes
                cols = "id, memory, properties, created_at, updated_at"
                if include_embedding:
                    cols += ", embedding"
                cur.execute(f"""
                    SELECT {cols} FROM {self.schema}.memories
                    WHERE user_name = %s
                    ORDER BY created_at DESC
                """, (user_name,))
                nodes = [self._parse_row(row, include_embedding) for row in cur.fetchall()]

                # Get edges
                node_ids = [n["id"] for n in nodes]
                if node_ids:
                    cur.execute(f"""
                        SELECT source_id, target_id, edge_type
                        FROM {self.schema}.edges
                        WHERE source_id = ANY(%s) OR target_id = ANY(%s)
                    """, (node_ids, node_ids))
                    edges = [
                        {"source": row[0], "target": row[1], "type": row[2]}
                        for row in cur.fetchall()
                    ]
                else:
                    edges = []

                return {
                    "nodes": nodes,
                    "edges": edges,
                    "total_nodes": len(nodes),
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
            )

    def close(self):
        """Close connection pool."""
        if not self._pool_closed:
            self._pool_closed = True
            self.pool.closeall()
