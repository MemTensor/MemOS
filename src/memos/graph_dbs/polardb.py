import json
import random
import textwrap
import time

from contextlib import suppress
from datetime import datetime
from typing import Any, Literal

import numpy as np

from memos.configs.graph_db import PolarDBGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger
from memos.utils import timed


logger = get_logger(__name__)


def _compose_node(item: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    node_id = item["id"]
    memory = item["memory"]
    metadata = item.get("metadata", {})
    return node_id, memory, metadata


def _prepare_node_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """
    Ensure metadata has proper datetime fields and normalized types.

    - Fill `created_at` and `updated_at` if missing (in ISO 8601 format).
    - Convert embedding to list of float if present.
    """
    now = datetime.utcnow().isoformat()

    # Fill timestamps if missing
    metadata.setdefault("created_at", now)
    metadata.setdefault("updated_at", now)

    # Normalize embedding type
    embedding = metadata.get("embedding")
    if embedding and isinstance(embedding, list):
        metadata["embedding"] = [float(x) for x in embedding]

    return metadata


def generate_vector(dim=1024, low=-0.2, high=0.2):
    """Generate a random vector for testing purposes."""
    return [round(random.uniform(low, high), 6) for _ in range(dim)]


def find_embedding(metadata):
    def find_embedding(item):
        """Find an embedding vector within nested structures"""
        for key in ["embedding", "embedding_1024", "embedding_3072", "embedding_768"]:
            if key in item and isinstance(item[key], list):
                return item[key]
            if "metadata" in item and key in item["metadata"]:
                return item["metadata"][key]
            if "properties" in item and key in item["properties"]:
                return item["properties"][key]
        return None


def detect_embedding_field(embedding_list):
    if not embedding_list:
        return None
    dim = len(embedding_list)
    if dim == 1024:
        return "embedding"
    else:
        logger.warning(f"Unknown embedding dimension {dim}, skipping this vector")
        return None


def convert_to_vector(embedding_list):
    if not embedding_list:
        return None
    if isinstance(embedding_list, np.ndarray):
        embedding_list = embedding_list.tolist()
    return "[" + ",".join(str(float(x)) for x in embedding_list) + "]"


def clean_properties(props):
    """Remove vector fields"""
    vector_keys = {"embedding", "embedding_1024", "embedding_3072", "embedding_768"}
    if not isinstance(props, dict):
        return {}
    return {k: v for k, v in props.items() if k not in vector_keys}


def escape_sql_string(value: str) -> str:
    """Escape single quotes in SQL string."""
    return value.replace("'", "''")


class PolarDBGraphDB(BaseGraphDB):
    """PolarDB-based implementation using Apache AGE graph database extension."""

    @require_python_package(
        import_name="psycopg2",
        install_command="pip install psycopg2-binary",
        install_link="https://pypi.org/project/psycopg2-binary/",
    )
    def __init__(self, config: PolarDBGraphDBConfig):
        """PolarDB-based implementation using Apache AGE.

        Tenant Modes:
        - use_multi_db = True:
            Dedicated Database Mode (Multi-Database Multi-Tenant).
            Each tenant or logical scope uses a separate PolarDB database.
            `db_name` is the specific tenant database.
            `user_name` can be None (optional).

        - use_multi_db = False:
            Shared Database Multi-Tenant Mode.
            All tenants share a single PolarDB database.
            `db_name` is the shared database.
            `user_name` is required to isolate each tenant's data at the node level.
            All node queries will enforce `user_name` in WHERE conditions and store it in metadata,
            but it will be removed automatically before returning to external consumers.
        """
        import psycopg2
        import psycopg2.pool

        self.config = config

        # Handle both dict and object config
        if isinstance(config, dict):
            self.db_name = config.get("db_name")
            self.user_name = config.get("user_name")
            host = config.get("host")
            port = config.get("port")
            user = config.get("user")
            password = config.get("password")
            maxconn = config.get("maxconn", 100)  # De
        else:
            self.db_name = config.db_name
            self.user_name = config.user_name
            host = config.host
            port = config.port
            user = config.user
            password = config.password
            maxconn = config.maxconn if hasattr(config, "maxconn") else 100
        """
        # Create connection
        self.connection = psycopg2.connect(
            host=host, port=port, user=user, password=password, dbname=self.db_name,minconn=10, maxconn=2000
        )
        """
        logger.info(f" db_name: {self.db_name} current maxconn is:'{maxconn}'")

        # Create connection pool
        self.connection_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=5,
            maxconn=maxconn,
            host=host,
            port=port,
            user=user,
            password=password,
            dbname=self.db_name,
            connect_timeout=60,  # Connection timeout in seconds
            keepalives_idle=40,  # Seconds of inactivity before sending keepalive (should be < server idle timeout)
            keepalives_interval=15,  # Seconds between keepalive retries
            keepalives_count=5,  # Number of keepalive retries before considering connection dead
        )

        # Keep a reference to the pool for cleanup
        self._pool_closed = False

        """
        # Handle auto_create
        # auto_create = config.get("auto_create", False) if isinstance(config, dict) else config.auto_create
        # if auto_create:
        #     self._ensure_database_exists()

        # Create graph and tables
        # self.create_graph()
        # self.create_edge()
        # self._create_graph()

        # Handle embedding_dimension
        # embedding_dim = config.get("embedding_dimension", 1024) if isinstance(config,dict) else config.embedding_dimension
        # self.create_index(dimensions=embedding_dim)
        """

    def _get_config_value(self, key: str, default=None):
        """Safely get config value from either dict or object."""
        if isinstance(self.config, dict):
            return self.config.get(key, default)
        else:
            return getattr(self.config, key, default)

    def _get_connection_old(self):
        """Get a connection from the pool."""
        if self._pool_closed:
            raise RuntimeError("Connection pool has been closed")
        conn = self.connection_pool.getconn()
        # Set autocommit for PolarDB compatibility
        conn.autocommit = True
        return conn

    def _get_connection(self):
        """
        Get a connection from the pool.

        This function:
        1. Gets a connection from ThreadedConnectionPool
        2. Checks if connection is closed or unhealthy
        3. Returns healthy connection or retries (max 3 times)
        4. Handles connection pool exhaustion gracefully

        Returns:
            psycopg2 connection object

        Raises:
            RuntimeError: If connection pool is closed or exhausted after retries
        """
        logger.info(f" db_name: {self.db_name} pool maxconn is:'{self.connection_pool.maxconn}'")
        if self._pool_closed:
            raise RuntimeError("Connection pool has been closed")

        max_retries = 500
        import psycopg2.pool

        for attempt in range(max_retries):
            conn = None
            try:
                # Try to get connection from pool
                # This may raise PoolError if pool is exhausted
                conn = self.connection_pool.getconn()

                # Check if connection is closed
                if conn.closed != 0:
                    # Connection is closed, return it to pool with close flag and try again
                    logger.warning(
                        f"[_get_connection] Got closed connection, attempt {attempt + 1}/{max_retries}"
                    )
                    try:
                        self.connection_pool.putconn(conn, close=True)
                    except Exception as e:
                        logger.warning(
                            f"[_get_connection] Failed to return closed connection to pool: {e}"
                        )
                        with suppress(Exception):
                            conn.close()

                    conn = None
                    if attempt < max_retries - 1:
                        # Exponential backoff: 0.1s, 0.2s, 0.4s
                        """time.sleep(0.1 * (2**attempt))"""
                        time.sleep(0.003)
                        continue
                    else:
                        raise RuntimeError("Pool returned a closed connection after all retries")

                # Set autocommit for PolarDB compatibility
                conn.autocommit = True

                # Test connection health with SELECT 1
                try:
                    cursor = conn.cursor()
                    cursor.execute("SELECT 1")
                    cursor.fetchone()
                    cursor.close()
                except Exception as health_check_error:
                    # Connection is not usable, return it to pool with close flag and try again
                    logger.warning(
                        f"[_get_connection] Connection health check failed (attempt {attempt + 1}/{max_retries}): {health_check_error}"
                    )
                    try:
                        self.connection_pool.putconn(conn, close=True)
                    except Exception as putconn_error:
                        logger.warning(
                            f"[_get_connection] Failed to return unhealthy connection to pool: {putconn_error}"
                        )
                        with suppress(Exception):
                            conn.close()

                    conn = None
                    if attempt < max_retries - 1:
                        # Exponential backoff: 0.1s, 0.2s, 0.4s
                        """time.sleep(0.1 * (2**attempt))"""
                        time.sleep(0.003)
                        continue
                    else:
                        raise RuntimeError(
                            f"Failed to get a healthy connection from pool after {max_retries} attempts: {health_check_error}"
                        ) from health_check_error

                # Connection is healthy, return it
                return conn

            except psycopg2.pool.PoolError as pool_error:
                # Pool exhausted or other pool-related error
                # Don't retry immediately for pool exhaustion - it's unlikely to resolve quickly
                error_msg = str(pool_error).lower()
                if "exhausted" in error_msg or "pool" in error_msg:
                    # Log pool status for debugging
                    try:
                        # Try to get pool stats if available
                        pool_info = f"Pool config: minconn={self.connection_pool.minconn}, maxconn={self.connection_pool.maxconn}"
                        logger.error(
                            f"[_get_connection] Connection pool exhausted (attempt {attempt + 1}/{max_retries}). {pool_info}"
                        )
                    except Exception:
                        logger.error(
                            f"[_get_connection] Connection pool exhausted (attempt {attempt + 1}/{max_retries})"
                        )

                    # For pool exhaustion, wait longer before retry (connections may be returned)
                    if attempt < max_retries - 1:
                        # Longer backoff for pool exhaustion: 0.5s, 1.0s, 2.0s
                        wait_time = 0.5 * (2**attempt)
                        logger.info(f"[_get_connection] Waiting {wait_time}s before retry...")
                        """time.sleep(wait_time)"""
                        time.sleep(0.003)
                        continue
                    else:
                        raise RuntimeError(
                            f"Connection pool exhausted after {max_retries} attempts. "
                            f"This usually means connections are not being returned to the pool. "
                            f"Check for connection leaks in your code."
                        ) from pool_error
                else:
                    # Other pool errors - retry with normal backoff
                    if attempt < max_retries - 1:
                        """time.sleep(0.1 * (2**attempt))"""
                        time.sleep(0.003)
                        continue
                    else:
                        raise RuntimeError(
                            f"Failed to get connection from pool: {pool_error}"
                        ) from pool_error

            except Exception as e:
                # Other exceptions (not pool-related)
                # Only try to return connection if we actually got one
                # If getconn() failed (e.g., pool exhausted), conn will be None
                if conn is not None:
                    try:
                        # Return connection to pool if it's valid
                        self.connection_pool.putconn(conn, close=True)
                    except Exception as putconn_error:
                        logger.warning(
                            f"[_get_connection] Failed to return connection after error: {putconn_error}"
                        )
                        with suppress(Exception):
                            conn.close()

                if attempt >= max_retries - 1:
                    raise RuntimeError(f"Failed to get a valid connection from pool: {e}") from e
                else:
                    # Exponential backoff: 0.1s, 0.2s, 0.4s
                    """time.sleep(0.1 * (2**attempt))"""
                    time.sleep(0.003)
                continue

        # Should never reach here, but just in case
        raise RuntimeError("Failed to get connection after all retries")

    def _return_connection(self, connection):
        """
        Return a connection to the pool.

        This function safely returns a connection to the pool, handling:
        - Closed connections (close them instead of returning)
        - Pool closed state (close connection directly)
        - None connections (no-op)
        - putconn() failures (close connection as fallback)

        Args:
            connection: psycopg2 connection object or None
        """
        if self._pool_closed:
            # Pool is closed, just close the connection if it exists
            if connection:
                try:
                    connection.close()
                    logger.debug("[_return_connection] Closed connection (pool is closed)")
                except Exception as e:
                    logger.warning(
                        f"[_return_connection] Failed to close connection after pool closed: {e}"
                    )
            return

        if not connection:
            # No connection to return - this is normal if _get_connection() failed
            return

        try:
            # Check if connection is closed
            if hasattr(connection, "closed") and connection.closed != 0:
                # Connection is closed, just close it explicitly and don't return to pool
                logger.debug(
                    "[_return_connection] Connection is closed, closing it instead of returning to pool"
                )
                try:
                    connection.close()
                except Exception as e:
                    logger.warning(f"[_return_connection] Failed to close closed connection: {e}")
                return

            # Connection is valid, return to pool
            self.connection_pool.putconn(connection)
            logger.debug("[_return_connection] Successfully returned connection to pool")
        except Exception as e:
            # If putconn fails, try to close the connection
            # This prevents connection leaks if putconn() fails
            logger.error(
                f"[_return_connection] Failed to return connection to pool: {e}", exc_info=True
            )
            try:
                connection.close()
                logger.debug(
                    "[_return_connection] Closed connection as fallback after putconn failure"
                )
            except Exception as close_error:
                logger.warning(
                    f"[_return_connection] Failed to close connection after putconn error: {close_error}"
                )

    def _return_connection_old(self, connection):
        """Return a connection to the pool."""
        if not self._pool_closed and connection:
            self.connection_pool.putconn(connection)

    def _ensure_database_exists(self):
        """Create database if it doesn't exist."""
        try:
            # For PostgreSQL/PolarDB, we need to connect to a default database first
            # This is a simplified implementation - in production you might want to handle this differently
            logger.info(f"Using database '{self.db_name}'")
        except Exception as e:
            logger.error(f"Failed to access database '{self.db_name}': {e}")
            raise

    @timed
    def _create_graph(self):
        """Create PostgreSQL schema and table for graph storage."""
        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Create schema if it doesn't exist
                cursor.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.db_name}_graph";')
                logger.info(f"Schema '{self.db_name}_graph' ensured.")

                # Create Memory table if it doesn't exist
                cursor.execute(f"""
                    CREATE TABLE IF NOT EXISTS "{self.db_name}_graph"."Memory" (
                        id TEXT PRIMARY KEY,
                        properties JSONB NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                logger.info(f"Memory table created in schema '{self.db_name}_graph'.")

                # Add embedding column if it doesn't exist (using JSONB for compatibility)
                try:
                    cursor.execute(f"""
                        ALTER TABLE "{self.db_name}_graph"."Memory"
                        ADD COLUMN IF NOT EXISTS embedding JSONB;
                    """)
                    logger.info("Embedding column added to Memory table.")
                except Exception as e:
                    logger.warning(f"Failed to add embedding column: {e}")

                # Create indexes
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_properties
                    ON "{self.db_name}_graph"."Memory" USING GIN (properties);
                """)

                # Create vector index for embedding field
                try:
                    cursor.execute(f"""
                        CREATE INDEX IF NOT EXISTS idx_memory_embedding
                        ON "{self.db_name}_graph"."Memory" USING ivfflat (embedding vector_cosine_ops)
                        WITH (lists = 100);
                    """)
                    logger.info("Vector index created for Memory table.")
                except Exception as e:
                    logger.warning(f"Vector index creation failed (might not be supported): {e}")

                logger.info("Indexes created for Memory table.")

        except Exception as e:
            logger.error(f"Failed to create graph schema: {e}")
            raise e
        finally:
            self._return_connection(conn)

    def create_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 1024,
        index_name: str = "memory_vector_index",
    ) -> None:
        """
        Create indexes for embedding and other fields.
        Note: This creates PostgreSQL indexes on the underlying tables.
        """
        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Create indexes on the underlying PostgreSQL tables
                # Apache AGE stores data in regular PostgreSQL tables
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_properties
                    ON "{self.db_name}_graph"."Memory" USING GIN (properties);
                """)

                # Try to create vector index, but don't fail if it doesn't work
                try:
                    cursor.execute(f"""
                        CREATE INDEX IF NOT EXISTS idx_memory_embedding
                        ON "{self.db_name}_graph"."Memory" USING ivfflat (embedding vector_cosine_ops);
                    """)
                except Exception as ve:
                    logger.warning(f"Vector index creation failed (might not be supported): {ve}")

                logger.debug("Indexes created successfully.")
        except Exception as e:
            logger.warning(f"Failed to create indexes: {e}")
        finally:
            self._return_connection(conn)

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        """Get count of memory nodes by type."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        query = f"""
            SELECT COUNT(*)
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = %s::agtype
        """
        query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        params = [self.format_param_value(memory_type), self.format_param_value(user_name)]

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            logger.error(f"[get_memory_count] Failed: {e}")
            return -1
        finally:
            self._return_connection(conn)

    @timed
    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        """Check if a node with given scope exists."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        query = f"""
            SELECT id
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = %s::agtype
        """
        query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        query += "\nLIMIT 1"
        params = [self.format_param_value(scope), self.format_param_value(user_name)]

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                return 1 if result else 0
        except Exception as e:
            logger.error(f"[node_not_exist] Query failed: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    @timed
    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """
        Remove all WorkingMemory nodes except the latest `keep_latest` entries.

        Args:
            memory_type (str): Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest (int): Number of latest WorkingMemory entries to keep.
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Use actual OFFSET logic, consistent with nebular.py
        # First find IDs to delete, then delete them
        select_query = f"""
            SELECT id FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = %s::agtype
            AND ag_catalog.agtype_access_operator(properties, '"user_name"'::agtype) = %s::agtype
            ORDER BY ag_catalog.agtype_access_operator(properties, '"updated_at"'::agtype) DESC
            OFFSET %s
        """
        select_params = [
            self.format_param_value(memory_type),
            self.format_param_value(user_name),
            keep_latest,
        ]
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Execute query to get IDs to delete
                cursor.execute(select_query, select_params)
                ids_to_delete = [row[0] for row in cursor.fetchall()]

                if not ids_to_delete:
                    logger.info(f"No {memory_type} memories to remove for user {user_name}")
                    return

                # Build delete query
                placeholders = ",".join(["%s"] * len(ids_to_delete))
                delete_query = f"""
                    DELETE FROM "{self.db_name}_graph"."Memory"
                    WHERE id IN ({placeholders})
                """
                delete_params = ids_to_delete

                # Execute deletion
                cursor.execute(delete_query, delete_params)
                deleted_count = cursor.rowcount
                logger.info(
                    f"Removed {deleted_count} oldest {memory_type} memories, "
                    f"keeping {keep_latest} latest for user {user_name}, "
                    f"removed ids: {ids_to_delete}"
                )
        except Exception as e:
            logger.error(f"[remove_oldest_memory] Failed: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    @timed
    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """
        Update node fields in PolarDB, auto-converting `created_at` and `updated_at` to datetime type if present.
        """
        if not fields:
            return

        user_name = user_name if user_name else self.config.user_name

        # Get the current node
        current_node = self.get_node(id, user_name=user_name)
        if not current_node:
            return

        # Update properties but keep original id and memory fields
        properties = current_node["metadata"].copy()
        original_id = properties.get("id", id)  # Preserve original ID
        original_memory = current_node.get("memory", "")  # Preserve original memory

        # If fields include memory, use it; otherwise keep original memory
        if "memory" in fields:
            original_memory = fields.pop("memory")

        properties.update(fields)
        properties["id"] = original_id  # Ensure ID is not overwritten
        properties["memory"] = original_memory  # Ensure memory is not overwritten

        # Handle embedding field
        embedding_vector = None
        if "embedding" in fields:
            embedding_vector = fields.pop("embedding")
            if not isinstance(embedding_vector, list):
                embedding_vector = None

        # Build update query
        if embedding_vector is not None:
            query = f"""
                UPDATE "{self.db_name}_graph"."Memory"
                SET properties = %s, embedding = %s
                WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
            """
            params = [
                json.dumps(properties),
                json.dumps(embedding_vector),
                self.format_param_value(id),
            ]
        else:
            query = f"""
                UPDATE "{self.db_name}_graph"."Memory"
                SET properties = %s
                WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
            """
            params = [json.dumps(properties), self.format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
        except Exception as e:
            logger.error(f"[update_node] Failed to update node '{id}': {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    @timed
    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """
        Delete a node from the graph.
        Args:
            id: Node identifier to delete.
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        query = f"""
            DELETE FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
        """
        params = [self.format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
        except Exception as e:
            logger.error(f"[delete_node] Failed to delete node '{id}': {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    @timed
    def create_extension(self):
        extensions = [("polar_age", "Graph engine"), ("vector", "Vector engine")]
        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Ensure in the correct database context
                cursor.execute("SELECT current_database();")
                current_db = cursor.fetchone()[0]
                logger.info(f"Current database context: {current_db}")

                for ext_name, ext_desc in extensions:
                    try:
                        cursor.execute(f"create extension if not exists {ext_name};")
                        logger.info(f"Extension '{ext_name}' ({ext_desc}) ensured.")
                    except Exception as e:
                        if "already exists" in str(e):
                            logger.info(f"Extension '{ext_name}' ({ext_desc}) already exists.")
                        else:
                            logger.warning(
                                f"Failed to create extension '{ext_name}' ({ext_desc}): {e}"
                            )
                            logger.error(
                                f"Failed to create extension '{ext_name}': {e}", exc_info=True
                            )
        except Exception as e:
            logger.warning(f"Failed to access database context: {e}")
            logger.error(f"Failed to access database context: {e}", exc_info=True)
        finally:
            self._return_connection(conn)

    @timed
    def create_graph(self):
        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(f"""
                    SELECT COUNT(*) FROM ag_catalog.ag_graph
                    WHERE name = '{self.db_name}_graph';
                """)
                graph_exists = cursor.fetchone()[0] > 0

                if graph_exists:
                    logger.info(f"Graph '{self.db_name}_graph' already exists.")
                else:
                    cursor.execute(f"select create_graph('{self.db_name}_graph');")
                    logger.info(f"Graph database '{self.db_name}_graph' created.")
        except Exception as e:
            logger.warning(f"Failed to create graph '{self.db_name}_graph': {e}")
            logger.error(f"Failed to create graph '{self.db_name}_graph': {e}", exc_info=True)
        finally:
            self._return_connection(conn)

    @timed
    def create_edge(self):
        """Create all valid edge types if they do not exist"""

        valid_rel_types = {"AGGREGATE_TO", "FOLLOWS", "INFERS", "MERGED_TO", "RELATE_TO", "PARENT"}

        for label_name in valid_rel_types:
            conn = None
            logger.info(f"Creating elabel: {label_name}")
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(f"select create_elabel('{self.db_name}_graph', '{label_name}');")
                    logger.info(f"Successfully created elabel: {label_name}")
            except Exception as e:
                if "already exists" in str(e):
                    logger.info(f"Label '{label_name}' already exists, skipping.")
                else:
                    logger.warning(f"Failed to create label {label_name}: {e}")
                    logger.error(f"Failed to create elabel '{label_name}': {e}", exc_info=True)
            finally:
                self._return_connection(conn)

    @timed
    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        if not source_id or not target_id:
            logger.warning(f"Edge '{source_id}' and '{target_id}' are both None")
            raise ValueError("[add_edge] source_id and target_id must be provided")

        source_exists = self.get_node(source_id) is not None
        target_exists = self.get_node(target_id) is not None

        if not source_exists or not target_exists:
            logger.warning(
                "[add_edge] Source %s or target %s does not exist.", source_exists, target_exists
            )
            raise ValueError("[add_edge] source_id and target_id must be provided")

        properties = {}
        if user_name is not None:
            properties["user_name"] = user_name
        query = f"""
            INSERT INTO {self.db_name}_graph."{type}"(id, start_id, end_id, properties)
            SELECT
                ag_catalog._next_graph_id('{self.db_name}_graph'::name, '{type}'),
                ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{source_id}'::text::cstring),
                ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{target_id}'::text::cstring),
                jsonb_build_object('user_name', '{user_name}')::text::agtype
            WHERE NOT EXISTS (
                SELECT 1 FROM {self.db_name}_graph."{type}"
                WHERE start_id = ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{source_id}'::text::cstring)
                  AND end_id   = ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{target_id}'::text::cstring)
            );
        """

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, (source_id, target_id, type, json.dumps(properties)))
                logger.info(f"Edge created: {source_id} -[{type}]-> {target_id}")
        except Exception as e:
            logger.error(f"Failed to insert edge: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    @timed
    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Delete a specific edge between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type to remove.
        """
        query = f"""
            DELETE FROM "{self.db_name}_graph"."Edges"
            WHERE source_id = %s AND target_id = %s AND edge_type = %s
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, (source_id, target_id, type))
                logger.info(f"Edge deleted: {source_id} -[{type}]-> {target_id}")
        finally:
            self._return_connection(conn)

    @timed
    def edge_exists_old(
        self, source_id: str, target_id: str, type: str = "ANY", direction: str = "OUTGOING"
    ) -> bool:
        """
        Check if an edge exists between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type. Use "ANY" to match any relationship type.
            direction: Direction of the edge.
                       Use "OUTGOING" (default), "INCOMING", or "ANY".
        Returns:
            True if the edge exists, otherwise False.
        """
        where_clauses = []
        params = []
        # SELECT * FROM
        # cypher('memtensor_memos_graph', $$
        # MATCH(a: Memory
        # {id: "13bb9df6-0609-4442-8bed-bba77dadac92"})-[r] - (b:Memory {id: "2dd03a5b-5d5f-49c9-9e0a-9a2a2899b98d"})
        # RETURN
        # r
        # $$) AS(r
        # agtype);

        if direction == "OUTGOING":
            where_clauses.append("source_id = %s AND target_id = %s")
            params.extend([source_id, target_id])
        elif direction == "INCOMING":
            where_clauses.append("source_id = %s AND target_id = %s")
            params.extend([target_id, source_id])
        elif direction == "ANY":
            where_clauses.append(
                "((source_id = %s AND target_id = %s) OR (source_id = %s AND target_id = %s))"
            )
            params.extend([source_id, target_id, target_id, source_id])
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )

        if type != "ANY":
            where_clauses.append("edge_type = %s")
            params.append(type)

        where_clause = " AND ".join(where_clauses)

        query = f"""
            SELECT 1 FROM "{self.db_name}_graph"."Edges"
            WHERE {where_clause}
            LIMIT 1
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                return result is not None
        finally:
            self._return_connection(conn)

    @timed
    def edge_exists(
        self,
        source_id: str,
        target_id: str,
        type: str = "ANY",
        direction: str = "OUTGOING",
        user_name: str | None = None,
    ) -> bool:
        """
        Check if an edge exists between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type. Use "ANY" to match any relationship type.
            direction: Direction of the edge.
                       Use "OUTGOING" (default), "INCOMING", or "ANY".
            user_name (str, optional): User name for filtering in non-multi-db mode
        Returns:
            True if the edge exists, otherwise False.
        """

        # Prepare the relationship pattern
        user_name = user_name if user_name else self.config.user_name

        # Prepare the match pattern with direction
        if direction == "OUTGOING":
            pattern = "(a:Memory)-[r]->(b:Memory)"
        elif direction == "INCOMING":
            pattern = "(a:Memory)<-[r]-(b:Memory)"
        elif direction == "ANY":
            pattern = "(a:Memory)-[r]-(b:Memory)"
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )
        query = f"SELECT * FROM cypher('{self.db_name}_graph', $$"
        query += f"\nMATCH {pattern}"
        query += f"\nWHERE a.user_name = '{user_name}' AND b.user_name = '{user_name}'"
        query += f"\nAND a.id = '{source_id}' AND b.id = '{target_id}'"
        if type != "ANY":
            query += f"\n AND type(r) = '{type}'"

        query += "\nRETURN r"
        query += "\n$$) AS (r agtype)"

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                result = cursor.fetchone()
                return result is not None and result[0] is not None
        finally:
            self._return_connection(conn)

    @timed
    def get_node(
        self, id: str, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any] | None:
        """
        Retrieve a Memory node by its unique ID.

        Args:
            id (str): Node ID (Memory.id)
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            dict: Node properties as key-value pairs, or None if not found.
        """

        select_fields = "id, properties, embedding" if include_embedding else "id, properties"

        query = f"""
            SELECT {select_fields}
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
        """
        params = [self.format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()

                if result:
                    if include_embedding:
                        _, properties_json, embedding_json = result
                    else:
                        _, properties_json = result
                        embedding_json = None

                    # Parse properties from JSONB if it's a string
                    if isinstance(properties_json, str):
                        try:
                            properties = json.loads(properties_json)
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse properties for node {id}")
                            properties = {}
                    else:
                        properties = properties_json if properties_json else {}

                    # Parse embedding from JSONB if it exists and include_embedding is True
                    if include_embedding and embedding_json is not None:
                        try:
                            embedding = (
                                json.loads(embedding_json)
                                if isinstance(embedding_json, str)
                                else embedding_json
                            )
                            properties["embedding"] = embedding
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse embedding for node {id}")

                    return self._parse_node(
                        {
                            "id": id,
                            "memory": properties.get("memory", ""),
                            **properties,
                        }
                    )
                return None

        except Exception as e:
            logger.error(f"[get_node] Failed to retrieve node '{id}': {e}", exc_info=True)
            return None
        finally:
            self._return_connection(conn)

    @timed
    def get_nodes(
        self, ids: list[str], user_name: str | None = None, **kwargs
    ) -> list[dict[str, Any]]:
        """
        Retrieve the metadata and memory of a list of nodes.
        Args:
            ids: List of Node identifier.
        Returns:
        list[dict]: Parsed node records containing 'id', 'memory', and 'metadata'.

        Notes:
            - Assumes all provided IDs are valid and exist.
            - Returns empty list if input is empty.
        """
        if not ids:
            return []

        # Build WHERE clause using agtype_access_operator like get_node method
        where_conditions = []
        params = []

        for id_val in ids:
            where_conditions.append(
                "ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) = %s::agtype"
            )
            params.append(self.format_param_value(id_val))

        where_clause = " OR ".join(where_conditions)

        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory"
            WHERE ({where_clause})
        """

        user_name = user_name if user_name else self.config.user_name
        query += " AND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        params.append(self.format_param_value(user_name))

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()

                nodes = []
                for row in results:
                    node_id, properties_json, embedding_json = row
                    # Parse properties from JSONB if it's a string
                    if isinstance(properties_json, str):
                        try:
                            properties = json.loads(properties_json)
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse properties for node {node_id}")
                            properties = {}
                    else:
                        properties = properties_json if properties_json else {}

                    # Parse embedding from JSONB if it exists
                    if embedding_json is not None and kwargs.get("include_embedding"):
                        try:
                            # remove embedding
                            embedding = (
                                json.loads(embedding_json)
                                if isinstance(embedding_json, str)
                                else embedding_json
                            )
                            properties["embedding"] = embedding
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse embedding for node {node_id}")
                    nodes.append(
                        self._parse_node(
                            {
                                "id": properties.get("id", node_id),
                                "memory": properties.get("memory", ""),
                                "metadata": properties,
                            }
                        )
                    )
                return nodes
        finally:
            self._return_connection(conn)

    @timed
    def get_edges_old(
        self, id: str, type: str = "ANY", direction: str = "ANY"
    ) -> list[dict[str, str]]:
        """
        Get edges connected to a node, with optional type and direction filter.

        Args:
            id: Node ID to retrieve edges for.
            type: Relationship type to match, or 'ANY' to match all.
            direction: 'OUTGOING', 'INCOMING', or 'ANY'.

        Returns:
            List of edges:
            [
              {"from": "source_id", "to": "target_id", "type": "RELATE"},
              ...
            ]
        """

        # Create a simple edge table to store relationships (if not exists)
        try:
            with self.connection.cursor() as cursor:
                # Create edge table
                cursor.execute(f"""
                    CREATE TABLE IF NOT EXISTS "{self.db_name}_graph"."Edges" (
                        id SERIAL PRIMARY KEY,
                        source_id TEXT NOT NULL,
                        target_id TEXT NOT NULL,
                        edge_type TEXT NOT NULL,
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (source_id) REFERENCES "{self.db_name}_graph"."Memory"(id),
                        FOREIGN KEY (target_id) REFERENCES "{self.db_name}_graph"."Memory"(id)
                    );
                """)

                # Create indexes
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_source
                    ON "{self.db_name}_graph"."Edges" (source_id);
                """)
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_target
                    ON "{self.db_name}_graph"."Edges" (target_id);
                """)
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_type
                    ON "{self.db_name}_graph"."Edges" (edge_type);
                """)
        except Exception as e:
            logger.warning(f"Failed to create edges table: {e}")

        # Query edges
        where_clauses = []
        params = [id]

        if type != "ANY":
            where_clauses.append("edge_type = %s")
            params.append(type)

        if direction == "OUTGOING":
            where_clauses.append("source_id = %s")
        elif direction == "INCOMING":
            where_clauses.append("target_id = %s")
        else:  # ANY
            where_clauses.append("(source_id = %s OR target_id = %s)")
            params.append(id)  # Add second parameter for ANY direction

        where_clause = " AND ".join(where_clauses)

        query = f"""
            SELECT source_id, target_id, edge_type
            FROM "{self.db_name}_graph"."Edges"
            WHERE {where_clause}
        """

        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            results = cursor.fetchall()

            edges = []
            for row in results:
                source_id, target_id, edge_type = row
                edges.append({"from": source_id, "to": target_id, "type": edge_type})
            return edges

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """Get connected node IDs in a specific direction and relationship type."""
        raise NotImplementedError

    @timed
    def get_neighbors_by_tag_old(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.

        Returns:
            List of dicts with node details and overlap count.
        """
        # Build query conditions
        where_clauses = []
        params = []

        # Exclude specified IDs
        if exclude_ids:
            placeholders = ",".join(["%s"] * len(exclude_ids))
            where_clauses.append(f"id NOT IN ({placeholders})")
            params.extend(exclude_ids)

        # Status filter
        where_clauses.append("properties->>'status' = %s")
        params.append("activated")

        # Type filter
        where_clauses.append("properties->>'type' != %s")
        params.append("reasoning")

        where_clauses.append("properties->>'memory_type' != %s")
        params.append("WorkingMemory")

        # User filter
        if not self._get_config_value("use_multi_db", True) and self._get_config_value("user_name"):
            where_clauses.append("properties->>'user_name' = %s")
            params.append(self._get_config_value("user_name"))

        where_clause = " AND ".join(where_clauses)

        # Get all candidate nodes
        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory"
            WHERE {where_clause}
        """

        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            results = cursor.fetchall()

            nodes_with_overlap = []
            for row in results:
                node_id, properties_json, embedding_json = row
                properties = properties_json if properties_json else {}

                # Parse embedding
                if embedding_json is not None:
                    try:
                        embedding = (
                            json.loads(embedding_json)
                            if isinstance(embedding_json, str)
                            else embedding_json
                        )
                        properties["embedding"] = embedding
                    except (json.JSONDecodeError, TypeError):
                        logger.warning(f"Failed to parse embedding for node {node_id}")

                # Compute tag overlap
                node_tags = properties.get("tags", [])
                if isinstance(node_tags, str):
                    try:
                        node_tags = json.loads(node_tags)
                    except (json.JSONDecodeError, TypeError):
                        node_tags = []

                overlap_tags = [tag for tag in tags if tag in node_tags]
                overlap_count = len(overlap_tags)

                if overlap_count >= min_overlap:
                    node_data = self._parse_node(
                        {
                            "id": properties.get("id", node_id),
                            "memory": properties.get("memory", ""),
                            "metadata": properties,
                        }
                    )
                    nodes_with_overlap.append((node_data, overlap_count))

            # Sort by overlap count and return top_k
            nodes_with_overlap.sort(key=lambda x: x[1], reverse=True)
            return [node for node, _ in nodes_with_overlap[:top_k]]

    @timed
    def get_children_with_embeddings(
        self, id: str, user_name: str | None = None
    ) -> list[dict[str, Any]]:
        """Get children nodes with their embeddings."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        where_user = f"AND p.user_name = '{user_name}' AND c.user_name = '{user_name}'"

        query = f"""
            WITH t as (
                SELECT *
                FROM cypher('{self.db_name}_graph', $$
                MATCH (p:Memory)-[r:PARENT]->(c:Memory)
                WHERE p.id = '{id}' {where_user}
                RETURN id(c) as cid, c.id AS id, c.memory AS memory
                $$) as (cid agtype, id agtype, memory agtype)
                )
                SELECT t.id, m.embedding, t.memory FROM t,
                "{self.db_name}_graph"."Memory" m
            WHERE t.cid::graphid = m.id;
        """

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                children = []
                for row in results:
                    # Handle child_id - remove possible quotes
                    child_id_raw = row[0].value if hasattr(row[0], "value") else str(row[0])
                    if isinstance(child_id_raw, str):
                        # If string starts and ends with quotes, remove quotes
                        if child_id_raw.startswith('"') and child_id_raw.endswith('"'):
                            child_id = child_id_raw[1:-1]
                        else:
                            child_id = child_id_raw
                    else:
                        child_id = str(child_id_raw)

                    # Handle embedding - get from database embedding column
                    embedding_raw = row[1]
                    embedding = []
                    if embedding_raw is not None:
                        try:
                            if isinstance(embedding_raw, str):
                                # If it is a JSON string, parse it
                                embedding = json.loads(embedding_raw)
                            elif isinstance(embedding_raw, list):
                                # If already a list, use directly
                                embedding = embedding_raw
                            else:
                                # Try converting to list
                                embedding = list(embedding_raw)
                        except (json.JSONDecodeError, TypeError, ValueError) as e:
                            logger.warning(
                                f"Failed to parse embedding for child node {child_id}: {e}"
                            )
                            embedding = []

                    # Handle memory - remove possible quotes
                    memory_raw = row[2].value if hasattr(row[2], "value") else str(row[2])
                    if isinstance(memory_raw, str):
                        # If string starts and ends with quotes, remove quotes
                        if memory_raw.startswith('"') and memory_raw.endswith('"'):
                            memory = memory_raw[1:-1]
                        else:
                            memory = memory_raw
                    else:
                        memory = str(memory_raw)

                    children.append({"id": child_id, "embedding": embedding, "memory": memory})

                return children

        except Exception as e:
            logger.error(f"[get_children_with_embeddings] Failed: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """Get the path of nodes from source to target within a limited depth."""
        raise NotImplementedError

    @timed
    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str = "activated",
        user_name: str | None = None,
    ) -> dict[str, Any]:
        """
        Retrieve a local subgraph centered at a given node.
        Args:
            center_id: The ID of the center node.
            depth: The hop distance for neighbors.
            center_status: Required status for center node.
            user_name (str, optional): User name for filtering in non-multi-db mode
        Returns:
            {
                "core_node": {...},
                "neighbors": [...],
                "edges": [...]
            }
        """
        logger.info(f"[get_subgraph] center_id: {center_id}")
        if not 1 <= depth <= 5:
            raise ValueError("depth must be 1-5")

        user_name = user_name if user_name else self._get_config_value("user_name")

        if center_id.startswith('"') and center_id.endswith('"'):
            center_id = center_id[1:-1]
        # Use a simplified query to get the subgraph (temporarily only direct neighbors)
        """
            SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH(center: Memory)-[r * 1..{depth}]->(neighbor:Memory)
                    WHERE
                    center.id = '{center_id}'
                    AND center.status = '{center_status}'
                    AND center.user_name = '{user_name}'
                    RETURN
                    collect(DISTINCT
                    center), collect(DISTINCT
                    neighbor), collect(DISTINCT
                    r)
                $$ ) as (centers agtype, neighbors agtype, rels agtype);
            """
        # Use UNION ALL for better performance: separate queries for depth 1 and depth 2
        if depth == 1:
            query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                        MATCH(center: Memory)-[r]->(neighbor:Memory)
                        WHERE
                        center.id = '{center_id}'
                        AND center.status = '{center_status}'
                        AND center.user_name = '{user_name}'
                        RETURN collect(DISTINCT center), collect(DISTINCT neighbor), collect(DISTINCT r)
                    $$ ) as (centers agtype, neighbors agtype, rels agtype);
                """
        else:
            # For depth >= 2, use UNION ALL to combine depth 1 and depth 2 queries
            query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                        MATCH(center: Memory)-[r]->(neighbor:Memory)
                        WHERE
                        center.id = '{center_id}'
                        AND center.status = '{center_status}'
                        AND center.user_name = '{user_name}'
                        RETURN collect(DISTINCT center), collect(DISTINCT neighbor), collect(DISTINCT r)
                UNION ALL
                        MATCH(center: Memory)-[r]->(n:Memory)-[r1]->(neighbor:Memory)
                        WHERE
                       center.id = '{center_id}'
                        AND center.status = '{center_status}'
                        AND center.user_name = '{user_name}'
                        RETURN collect(DISTINCT center), collect(DISTINCT neighbor), collect(DISTINCT r1)
                    $$ ) as (centers agtype, neighbors agtype, rels agtype);
                """
        conn = None
        logger.info(f"[get_subgraph] Query: {query}")
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                if not results:
                    return {"core_node": None, "neighbors": [], "edges": []}

                # Merge results from all UNION ALL rows
                all_centers_list = []
                all_neighbors_list = []
                all_edges_list = []

                for result in results:
                    if not result or not result[0]:
                        continue

                    centers_data = result[0] if result[0] else "[]"
                    neighbors_data = result[1] if result[1] else "[]"
                    edges_data = result[2] if result[2] else "[]"

                    # Parse JSON data
                    try:
                        # Clean ::vertex and ::edge suffixes in data
                        if isinstance(centers_data, str):
                            centers_data = centers_data.replace("::vertex", "")
                        if isinstance(neighbors_data, str):
                            neighbors_data = neighbors_data.replace("::vertex", "")
                        if isinstance(edges_data, str):
                            edges_data = edges_data.replace("::edge", "")

                        centers_list = (
                            json.loads(centers_data)
                            if isinstance(centers_data, str)
                            else centers_data
                        )
                        neighbors_list = (
                            json.loads(neighbors_data)
                            if isinstance(neighbors_data, str)
                            else neighbors_data
                        )
                        edges_list = (
                            json.loads(edges_data) if isinstance(edges_data, str) else edges_data
                        )

                        # Collect data from this row
                        if isinstance(centers_list, list):
                            all_centers_list.extend(centers_list)
                        if isinstance(neighbors_list, list):
                            all_neighbors_list.extend(neighbors_list)
                        if isinstance(edges_list, list):
                            all_edges_list.extend(edges_list)
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to parse JSON data: {e}")
                        continue

                # Deduplicate centers by ID
                centers_dict = {}
                for center_data in all_centers_list:
                    if isinstance(center_data, dict) and "properties" in center_data:
                        center_id_key = center_data["properties"].get("id")
                        if center_id_key and center_id_key not in centers_dict:
                            centers_dict[center_id_key] = center_data

                # Parse center node (use first center)
                core_node = None
                if centers_dict:
                    center_data = next(iter(centers_dict.values()))
                    if isinstance(center_data, dict) and "properties" in center_data:
                        core_node = self._parse_node(center_data["properties"])

                # Deduplicate neighbors by ID
                neighbors_dict = {}
                for neighbor_data in all_neighbors_list:
                    if isinstance(neighbor_data, dict) and "properties" in neighbor_data:
                        neighbor_id = neighbor_data["properties"].get("id")
                        if neighbor_id and neighbor_id not in neighbors_dict:
                            neighbors_dict[neighbor_id] = neighbor_data

                # Parse neighbor nodes
                neighbors = []
                for neighbor_data in neighbors_dict.values():
                    if isinstance(neighbor_data, dict) and "properties" in neighbor_data:
                        neighbor_parsed = self._parse_node(neighbor_data["properties"])
                        neighbors.append(neighbor_parsed)

                # Deduplicate edges by (source, target, type)
                edges_dict = {}
                for edge_group in all_edges_list:
                    if isinstance(edge_group, list):
                        for edge_data in edge_group:
                            if isinstance(edge_data, dict):
                                edge_key = (
                                    edge_data.get("start_id", ""),
                                    edge_data.get("end_id", ""),
                                    edge_data.get("label", ""),
                                )
                                if edge_key not in edges_dict:
                                    edges_dict[edge_key] = {
                                        "type": edge_data.get("label", ""),
                                        "source": edge_data.get("start_id", ""),
                                        "target": edge_data.get("end_id", ""),
                                    }
                    elif isinstance(edge_group, dict):
                        # Handle single edge (not in a list)
                        edge_key = (
                            edge_group.get("start_id", ""),
                            edge_group.get("end_id", ""),
                            edge_group.get("label", ""),
                        )
                        if edge_key not in edges_dict:
                            edges_dict[edge_key] = {
                                "type": edge_group.get("label", ""),
                                "source": edge_group.get("start_id", ""),
                                "target": edge_group.get("end_id", ""),
                            }

                edges = list(edges_dict.values())

                return self._convert_graph_edges(
                    {"core_node": core_node, "neighbors": neighbors, "edges": edges}
                )

        except Exception as e:
            logger.error(f"Failed to get subgraph: {e}", exc_info=True)
            return {"core_node": None, "neighbors": [], "edges": []}
        finally:
            self._return_connection(conn)

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """Get the ordered context chain starting from a node."""
        raise NotImplementedError

    @timed
    def seach_by_keywords_like(
        self,
        query_word: str,
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        where_clauses = []

        if scope:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) = '\"{scope}\"'::agtype"
            )
        if status:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"{status}\"'::agtype"
            )
        else:
            where_clauses.append(
                "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
            )

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_sql(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
        )

        # Add OR condition if we have any user_name conditions
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add search_filter conditions
        if search_filter:
            for key, value in search_filter.items():
                if isinstance(value, str):
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{value}\"'::agtype"
                    )
                else:
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {value}::agtype"
                    )

        # Build filter conditions using common method
        filter_conditions = self._build_filter_conditions_sql(filter)
        where_clauses.extend(filter_conditions)

        # Build key
        where_clauses.append("""(properties -> '"memory"')::text LIKE %s""")
        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties, '"id"'::agtype) AS old_id,
                agtype_object_field_text(properties, 'memory') as memory_text
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            """

        params = (query_word,)
        logger.info(
            f"[seach_by_keywords_LIKE start:]  user_name: {user_name}, query: {query}, params: {params}"
        )
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()
                output = []
                for row in results:
                    oldid = row[0]
                    id_val = str(oldid)
                    output.append({"id": id_val})
                logger.info(
                    f"[seach_by_keywords_LIKE end:] user_name: {user_name}, query: {query}, params: {params} recalled: {output}"
                )
                return output
        finally:
            self._return_connection(conn)

    @timed
    def seach_by_keywords_tfidf(
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
        **kwargs,
    ) -> list[dict]:
        where_clauses = []

        if scope:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) = '\"{scope}\"'::agtype"
            )
        if status:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"{status}\"'::agtype"
            )
        else:
            where_clauses.append(
                "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
            )

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_sql(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
        )

        # Add OR condition if we have any user_name conditions
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add search_filter conditions
        if search_filter:
            for key, value in search_filter.items():
                if isinstance(value, str):
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{value}\"'::agtype"
                    )
                else:
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {value}::agtype"
                    )

        # Build filter conditions using common method
        filter_conditions = self._build_filter_conditions_sql(filter)
        where_clauses.extend(filter_conditions)
        # Add fulltext search condition
        # Convert query_text to OR query format: "word1 | word2 | word3"
        tsquery_string = " | ".join(query_words)

        where_clauses.append(f"{tsvector_field} @@ to_tsquery('{tsquery_config}', %s)")

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Build fulltext search query
        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties, '"id"'::agtype) AS old_id,
                agtype_object_field_text(properties, 'memory') as memory_text
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
        """

        params = (tsquery_string,)
        logger.info(
            f"[seach_by_keywords_TFIDF start:] user_name: {user_name}, query: {query}, params: {params}"
        )
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()
                output = []
                for row in results:
                    oldid = row[0]
                    id_val = str(oldid)
                    output.append({"id": id_val})

                logger.info(
                    f"[seach_by_keywords_TFIDF end:] user_name: {user_name}, query: {query}, params: {params} recalled: {output}"
                )
                return output
        finally:
            self._return_connection(conn)

    @timed
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
        tsquery_config: str = "jiebaqry",
        **kwargs,
    ) -> list[dict]:
        """
        Full-text search functionality using PostgreSQL's full-text search capabilities.

        Args:
            query_text: query text
            top_k: maximum number of results to return
            scope: memory type filter (memory_type)
            status: status filter, defaults to "activated"
            threshold: similarity threshold filter
            search_filter: additional property filter conditions
            user_name: username filter
            knowledgebase_ids: knowledgebase ids filter
            filter: filter conditions with 'and' or 'or' logic for search results.
            tsvector_field: full-text index field name, defaults to properties_tsvector_zh_1
            tsquery_config: full-text search configuration, defaults to jiebaqry (Chinese word segmentation)
            **kwargs: other parameters (e.g. cube_name)

        Returns:
            list[dict]: result list containing id and score
        """
        # Build WHERE clause dynamically, same as search_by_embedding
        where_clauses = []

        if scope:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) = '\"{scope}\"'::agtype"
            )
        if status:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"{status}\"'::agtype"
            )
        else:
            where_clauses.append(
                "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
            )

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_sql(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
        )

        # Add OR condition if we have any user_name conditions
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add search_filter conditions
        if search_filter:
            for key, value in search_filter.items():
                if isinstance(value, str):
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{value}\"'::agtype"
                    )
                else:
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {value}::agtype"
                    )

        # Build filter conditions using common method
        filter_conditions = self._build_filter_conditions_sql(filter)
        where_clauses.extend(filter_conditions)
        # Add fulltext search condition
        # Convert query_text to OR query format: "word1 | word2 | word3"
        tsquery_string = " | ".join(query_words)

        where_clauses.append(f"{tsvector_field} @@ to_tsquery('{tsquery_config}', %s)")

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Build fulltext search query
        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties, '"id"'::agtype) AS old_id,
                agtype_object_field_text(properties, 'memory') as memory_text,
                ts_rank({tsvector_field}, to_tsquery('{tsquery_config}', %s)) as rank
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            ORDER BY rank DESC
            LIMIT {top_k};
        """

        params = [tsquery_string, tsquery_string]
        logger.info(f"[search_by_fulltext] query: {query}, params: {params}")
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()
                output = []
                for row in results:
                    oldid = row[0]  # old_id
                    rank = row[2]  # rank score

                    id_val = str(oldid)
                    score_val = float(rank)

                    # Apply threshold filter if specified
                    if threshold is None or score_val >= threshold:
                        output.append({"id": id_val, "score": score_val})

                return output[:top_k]
        finally:
            self._return_connection(conn)

    @timed
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
        """
        Retrieve node IDs based on vector similarity using PostgreSQL vector operations.
        """
        # Build WHERE clause dynamically like nebular.py
        logger.info(
            f"[search_by_embedding] filter: {filter}, knowledgebase_ids: {knowledgebase_ids}"
        )
        where_clauses = []
        if scope:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) = '\"{scope}\"'::agtype"
            )
        if status:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"{status}\"'::agtype"
            )
        else:
            where_clauses.append(
                "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
            )
        where_clauses.append("embedding is not null")
        # Add user_name filter like nebular.py

        """
        # user_name = self._get_config_value("user_name")
        # if not self.config.use_multi_db and user_name:
        #     if kwargs.get("cube_name"):
        #         where_clauses.append(f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{kwargs['cube_name']}\"'::agtype")
        #     else:
        #         where_clauses.append(f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype")
        """
        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_sql(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
        )

        # Add OR condition if we have any user_name conditions
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add search_filter conditions like nebular.py
        if search_filter:
            for key, value in search_filter.items():
                if isinstance(value, str):
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{value}\"'::agtype"
                    )
                else:
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {value}::agtype"
                    )

        # Build filter conditions using common method
        filter_conditions = self._build_filter_conditions_sql(filter)
        logger.info(f"[search_by_embedding] filter_conditions: {filter_conditions}")
        where_clauses.extend(filter_conditions)

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Keep original simple query structure but add dynamic WHERE clause
        query = f"""
                    WITH t AS (
                        SELECT id,
                               properties,
                               timeline,
                               ag_catalog.agtype_access_operator(properties, '"id"'::agtype) AS old_id,
                               (1 - (embedding <=> %s::vector(1024))) AS scope
                        FROM "{self.db_name}_graph"."Memory"
                        {where_clause}
                        ORDER BY scope DESC
                        LIMIT {top_k}
                    )
                    SELECT *
                    FROM t
                    WHERE scope > 0.1;
                """
        # Convert vector to string format for PostgreSQL vector type
        # PostgreSQL vector type expects a string format like '[1,2,3]'
        vector_str = convert_to_vector(vector)
        # Use string format directly in query instead of parameterized query
        # Replace %s with the vector string, but need to quote it properly
        # PostgreSQL vector type needs the string to be quoted
        query = query.replace("%s::vector(1024)", f"'{vector_str}'::vector(1024)")
        params = []

        # Split query by lines and wrap long lines to prevent terminal truncation
        query_lines = query.strip().split("\n")
        for line in query_lines:
            # Wrap lines longer than 200 characters to prevent terminal truncation
            if len(line) > 200:
                wrapped_lines = textwrap.wrap(
                    line, width=200, break_long_words=False, break_on_hyphens=False
                )
                for _wrapped_line in wrapped_lines:
                    pass
            else:
                pass

        logger.info(f"[search_by_embedding] query: {query}, params: {params}")

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                try:
                    # If params is empty, execute query directly without parameters
                    if params:
                        cursor.execute(query, params)
                    else:
                        cursor.execute(query)
                except Exception as e:
                    logger.error(f"[search_by_embedding] Error executing query: {e}")
                    logger.error(f"[search_by_embedding] Query length: {len(query)}")
                    logger.error(
                        f"[search_by_embedding] Params type: {type(params)}, length: {len(params)}"
                    )
                    logger.error(f"[search_by_embedding] Query contains %s: {'%s' in query}")
                    raise
                results = cursor.fetchall()
                output = []
                for row in results:
                    """
                    polarId = row[0]  # id
                    properties = row[1]  # properties
                    # embedding = row[3]  # embedding
                    """
                    if len(row) < 5:
                        logger.warning(f"Row has {len(row)} columns, expected 5. Row: {row}")
                        continue
                    oldid = row[3]  # old_id
                    score = row[4]  # scope
                    id_val = str(oldid)
                    score_val = float(score)
                    score_val = (score_val + 1) / 2  # align to neo4j, Normalized Cosine Score
                    if threshold is None or score_val >= threshold:
                        output.append({"id": id_val, "score": score_val})
                return output[:top_k]
        finally:
            self._return_connection(conn)

    @timed
    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
        user_name_flag: bool = True,
    ) -> list[str]:
        """
        Retrieve node IDs that match given metadata filters.
        Supports exact match.

        Args:
        filters: List of filter dicts like:
            [
                {"field": "key", "op": "in", "value": ["A", "B"]},
                {"field": "confidence", "op": ">=", "value": 80},
                {"field": "tags", "op": "contains", "value": "AI"},
                ...
            ]
        user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[str]: Node IDs whose metadata match the filter conditions. (AND logic).
        """
        logger.info(f"[get_by_metadata] filter: {filter}, knowledgebase_ids: {knowledgebase_ids}")

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build WHERE conditions for cypher query
        where_conditions = []

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]

            # Format value
            if isinstance(value, str):
                # Escape single quotes using backslash when inside $$ dollar-quoted strings
                # In $$ delimiters, Cypher string literals can use \' to escape single quotes
                escaped_str = value.replace("'", "\\'")
                escaped_value = f"'{escaped_str}'"
            elif isinstance(value, list):
                # Handle list values - use double quotes for Cypher arrays
                list_items = []
                for v in value:
                    if isinstance(v, str):
                        # Escape double quotes in string values for Cypher
                        escaped_str = v.replace('"', '\\"')
                        list_items.append(f'"{escaped_str}"')
                    else:
                        list_items.append(str(v))
                escaped_value = f"[{', '.join(list_items)}]"
            else:
                escaped_value = f"'{value}'" if isinstance(value, str) else str(value)
            # Build WHERE conditions
            if op == "=":
                where_conditions.append(f"n.{field} = {escaped_value}")
            elif op == "in":
                where_conditions.append(f"n.{field} IN {escaped_value}")
                """
                # where_conditions.append(f"{escaped_value} IN n.{field}")
                """
            elif op == "contains":
                where_conditions.append(f"{escaped_value} IN n.{field}")
                """
                # where_conditions.append(f"size(filter(n.{field}, t -> t IN {escaped_value})) > 0")
                """
            elif op == "starts_with":
                where_conditions.append(f"n.{field} STARTS WITH {escaped_value}")
            elif op == "ends_with":
                where_conditions.append(f"n.{field} ENDS WITH {escaped_value}")
            elif op == "like":
                where_conditions.append(f"n.{field} CONTAINS {escaped_value}")
            elif op in [">", ">=", "<", "<="]:
                where_conditions.append(f"n.{field} {op} {escaped_value}")
            else:
                raise ValueError(f"Unsupported operator: {op}")

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_cypher(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self._get_config_value("user_name"),
        )
        logger.info(f"[get_by_metadata] user_name_conditions: {user_name_conditions}")

        # Add user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_conditions.append(user_name_conditions[0])
            else:
                where_conditions.append(f"({' OR '.join(user_name_conditions)})")

        # Build filter conditions using common method
        filter_where_clause = self._build_filter_conditions_cypher(filter)
        logger.info(f"[get_by_metadata] filter_where_clause: {filter_where_clause}")

        where_str = " AND ".join(where_conditions) + filter_where_clause

        # Use cypher query
        cypher_query = f"""
               SELECT * FROM cypher('{self.db_name}_graph', $$
               MATCH (n:Memory)
               WHERE {where_str}
               RETURN n.id AS id
               $$) AS (id agtype)
           """

        ids = []
        conn = None
        logger.info(f"[get_by_metadata] cypher_query: {cypher_query}")
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(cypher_query)
                results = cursor.fetchall()
                ids = [str(item[0]).strip('"') for item in results]
        except Exception as e:
            logger.error(f"Failed to get metadata: {e}, query is {cypher_query}")
        finally:
            self._return_connection(conn)

        return ids

    @timed
    def get_grouped_counts1(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Count nodes grouped by any fields.

        Args:
            group_fields (list[str]): Fields to group by, e.g., ["memory_type", "status"]
            where_clause (str, optional): Extra WHERE condition. E.g.,
            "WHERE n.status = 'activated'"
            params (dict, optional): Parameters for WHERE clause.

        Returns:
            list[dict]: e.g., [{ 'memory_type': 'WorkingMemory', 'status': 'active', 'count': 10 }, ...]
        """
        user_name = user_name if user_name else self.config.user_name
        if not group_fields:
            raise ValueError("group_fields cannot be empty")

        final_params = params.copy() if params else {}
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            user_clause = "n.user_name = $user_name"
            final_params["user_name"] = user_name
            if where_clause:
                where_clause = where_clause.strip()
                if where_clause.upper().startswith("WHERE"):
                    where_clause += f" AND {user_clause}"
                else:
                    where_clause = f"WHERE {where_clause} AND {user_clause}"
            else:
                where_clause = f"WHERE {user_clause}"
        # Force RETURN field AS field to guarantee key match
        group_fields_cypher = ", ".join([f"n.{field} AS {field}" for field in group_fields])
        """
        # group_fields_cypher_polardb = "agtype, ".join([f"{field}" for field in group_fields])
        """
        group_fields_cypher_polardb = ", ".join([f"{field} agtype" for field in group_fields])
        query = f"""
               SELECT * FROM cypher('{self.db_name}_graph', $$
                   MATCH (n:Memory)
                   {where_clause}
                   RETURN {group_fields_cypher}, COUNT(n) AS count1
               $$ ) as ({group_fields_cypher_polardb}, count1 agtype);
               """
        try:
            with self.connection.cursor() as cursor:
                # Handle parameterized query
                if params and isinstance(params, list):
                    cursor.execute(query, final_params)
                else:
                    cursor.execute(query)
                results = cursor.fetchall()

                output = []
                for row in results:
                    group_values = {}
                    for i, field in enumerate(group_fields):
                        value = row[i]
                        if hasattr(value, "value"):
                            group_values[field] = value.value
                        else:
                            group_values[field] = str(value)
                    count_value = row[-1]  # Last column is count
                    output.append({**group_values, "count": count_value})

                return output

        except Exception as e:
            logger.error(f"Failed to get grouped counts: {e}", exc_info=True)
            return []

    @timed
    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Count nodes grouped by any fields.

        Args:
            group_fields (list[str]): Fields to group by, e.g., ["memory_type", "status"]
            where_clause (str, optional): Extra WHERE condition. E.g.,
            "WHERE n.status = 'activated'"
            params (dict, optional): Parameters for WHERE clause.
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[dict]: e.g., [{ 'memory_type': 'WorkingMemory', 'status': 'active', 'count': 10 }, ...]
        """
        if not group_fields:
            raise ValueError("group_fields cannot be empty")

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build user clause
        user_clause = f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype"
        if where_clause:
            where_clause = where_clause.strip()
            if where_clause.upper().startswith("WHERE"):
                where_clause += f" AND {user_clause}"
            else:
                where_clause = f"WHERE {where_clause} AND {user_clause}"
        else:
            where_clause = f"WHERE {user_clause}"

        # Inline parameters if provided
        if params and isinstance(params, dict):
            for key, value in params.items():
                # Handle different value types appropriately
                if isinstance(value, str):
                    value = f"'{value}'"
                where_clause = where_clause.replace(f"${key}", str(value))

        # Handle user_name parameter in where_clause
        if "user_name = %s" in where_clause:
            where_clause = where_clause.replace(
                "user_name = %s",
                f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype",
            )

        # Build return fields and group by fields
        return_fields = []
        group_by_fields = []

        for field in group_fields:
            alias = field.replace(".", "_")
            return_fields.append(
                f"ag_catalog.agtype_access_operator(properties, '\"{field}\"'::agtype)::text AS {alias}"
            )
            group_by_fields.append(
                f"ag_catalog.agtype_access_operator(properties, '\"{field}\"'::agtype)::text"
            )

        # Full SQL query construction
        query = f"""
            SELECT {", ".join(return_fields)}, COUNT(*) AS count
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            GROUP BY {", ".join(group_by_fields)}
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Handle parameterized query
                if params and isinstance(params, list):
                    cursor.execute(query, params)
                else:
                    cursor.execute(query)
                results = cursor.fetchall()

                output = []
                for row in results:
                    group_values = {}
                    for i, field in enumerate(group_fields):
                        value = row[i]
                        if hasattr(value, "value"):
                            group_values[field] = value.value
                        else:
                            group_values[field] = str(value)
                    count_value = row[-1]  # Last column is count
                    output.append({**group_values, "count": int(count_value)})

                return output

        except Exception as e:
            logger.error(f"Failed to get grouped counts: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)

    def deduplicate_nodes(self) -> None:
        """Deduplicate redundant or semantically similar nodes."""
        raise NotImplementedError

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """Detect conflicting nodes based on logical or semantic inconsistency."""
        raise NotImplementedError

    def merge_nodes(self, id1: str, id2: str) -> str:
        """Merge two similar or duplicate nodes into one."""
        raise NotImplementedError

    @timed
    def clear(self, user_name: str | None = None) -> None:
        """
        Clear the entire graph if the target database exists.

        Args:
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        try:
            query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (n:Memory)
                WHERE n.user_name = '{user_name}'
                DETACH DELETE n
                $$) AS (result agtype)
            """
            conn = None
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(query)
                    logger.info("Cleared all nodes from database.")
            finally:
                self._return_connection(conn)

        except Exception as e:
            logger.error(f"[ERROR] Failed to clear database: {e}")

    @timed
    def export_graph(
        self, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any]:
        """
        Export all graph nodes and edges in a structured form.
        Args:
        include_embedding (bool): Whether to include the large embedding field.
        user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            {
                "nodes": [ { "id": ..., "memory": ..., "metadata": {...} }, ... ],
                "edges": [ { "source": ..., "target": ..., "type": ... }, ... ]
            }
        """
        user_name = user_name if user_name else self._get_config_value("user_name")
        conn = None
        try:
            conn = self._get_connection()
            # Export nodes
            if include_embedding:
                node_query = f"""
                    SELECT id, properties, embedding
                    FROM "{self.db_name}_graph"."Memory"
                    WHERE ag_catalog.agtype_access_operator(properties, '"user_name"'::agtype) = '\"{user_name}\"'::agtype
                """
            else:
                node_query = f"""
                    SELECT id, properties
                    FROM "{self.db_name}_graph"."Memory"
                    WHERE ag_catalog.agtype_access_operator(properties, '"user_name"'::agtype) = '\"{user_name}\"'::agtype
                """

            with conn.cursor() as cursor:
                cursor.execute(node_query)
                node_results = cursor.fetchall()
                nodes = []

                for row in node_results:
                    if include_embedding:
                        properties_json, embedding_json = row
                    else:
                        properties_json = row
                        embedding_json = None

                    # Parse properties from JSONB if it's a string
                    if isinstance(properties_json, str):
                        try:
                            properties = json.loads(properties_json)
                        except json.JSONDecodeError:
                            properties = {}
                    else:
                        properties = properties_json if properties_json else {}

                    # # Build node data

                    """
                    # node_data = {
                    #     "id": properties.get("id", node_id),
                    #     "memory": properties.get("memory", ""),
                    #     "metadata": properties
                    # }
                    """

                    if include_embedding and embedding_json is not None:
                        properties["embedding"] = embedding_json

                    nodes.append(self._parse_node(json.loads(properties[1])))

        except Exception as e:
            logger.error(f"[EXPORT GRAPH - NODES] Exception: {e}", exc_info=True)
            raise RuntimeError(f"[EXPORT GRAPH - NODES] Exception: {e}") from e
        finally:
            self._return_connection(conn)

        conn = None
        try:
            conn = self._get_connection()
            # Export edges using cypher query
            edge_query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (a:Memory)-[r]->(b:Memory)
                WHERE a.user_name = '{user_name}' AND b.user_name = '{user_name}'
                RETURN a.id AS source, b.id AS target, type(r) as edge
                $$) AS (source agtype, target agtype, edge agtype)
            """

            with conn.cursor() as cursor:
                cursor.execute(edge_query)
                edge_results = cursor.fetchall()
                edges = []

                for row in edge_results:
                    source_agtype, target_agtype, edge_agtype = row

                    # Extract and clean source
                    source_raw = (
                        source_agtype.value
                        if hasattr(source_agtype, "value")
                        else str(source_agtype)
                    )
                    if (
                        isinstance(source_raw, str)
                        and source_raw.startswith('"')
                        and source_raw.endswith('"')
                    ):
                        source = source_raw[1:-1]
                    else:
                        source = str(source_raw)

                    # Extract and clean target
                    target_raw = (
                        target_agtype.value
                        if hasattr(target_agtype, "value")
                        else str(target_agtype)
                    )
                    if (
                        isinstance(target_raw, str)
                        and target_raw.startswith('"')
                        and target_raw.endswith('"')
                    ):
                        target = target_raw[1:-1]
                    else:
                        target = str(target_raw)

                    # Extract and clean edge type
                    type_raw = (
                        edge_agtype.value if hasattr(edge_agtype, "value") else str(edge_agtype)
                    )
                    if (
                        isinstance(type_raw, str)
                        and type_raw.startswith('"')
                        and type_raw.endswith('"')
                    ):
                        edge_type = type_raw[1:-1]
                    else:
                        edge_type = str(type_raw)

                    edges.append(
                        {
                            "source": source,
                            "target": target,
                            "type": edge_type,
                        }
                    )

        except Exception as e:
            logger.error(f"[EXPORT GRAPH - EDGES] Exception: {e}", exc_info=True)
            raise RuntimeError(f"[EXPORT GRAPH - EDGES] Exception: {e}") from e
        finally:
            self._return_connection(conn)

        return {"nodes": nodes, "edges": edges}

    @timed
    def count_nodes(self, scope: str, user_name: str | None = None) -> int:
        user_name = user_name if user_name else self.config.user_name

        query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (n:Memory)
                WHERE n.memory_type = '{scope}'
                AND n.user_name = '{user_name}'
                RETURN count(n)
            $$) AS (count agtype)
        """
        conn = None
        try:
            conn = self._get_connection()
            result = self.execute_query(query, conn)
            return int(result.one_or_none()["count"].value)
        finally:
            self._return_connection(conn)

    @timed
    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        logger.info(
            f"[get_all_memory_items] filter: {filter}, knowledgebase_ids: {knowledgebase_ids}"
        )

        user_name = user_name if user_name else self._get_config_value("user_name")
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_cypher(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self._get_config_value("user_name"),
        )

        # Build user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                user_name_where = user_name_conditions[0]
            else:
                user_name_where = f"({' OR '.join(user_name_conditions)})"
        else:
            user_name_where = ""

        # Build filter conditions using common method
        filter_where_clause = self._build_filter_conditions_cypher(filter)
        logger.info(f"[get_all_memory_items] filter_where_clause: {filter_where_clause}")

        # Use cypher query to retrieve memory items
        if include_embedding:
            # Build WHERE clause with user_name/knowledgebase_ids and filter
            where_parts = [f"n.memory_type = '{scope}'"]
            if user_name_where:
                # user_name_where already contains parentheses if it's an OR condition
                where_parts.append(user_name_where)
            if filter_where_clause:
                # filter_where_clause already contains " AND " prefix, so we just append it
                where_clause = " AND ".join(where_parts) + filter_where_clause
            else:
                where_clause = " AND ".join(where_parts)

            cypher_query = f"""
                   WITH t as (
                       SELECT * FROM cypher('{self.db_name}_graph', $$
                       MATCH (n:Memory)
                       WHERE {where_clause}
                       RETURN id(n) as id1,n
                       LIMIT 100
                       $$) AS (id1 agtype,n agtype)
                   )
                   SELECT
                       m.embedding,
                       t.n
                   FROM t,
                        {self.db_name}_graph."Memory" m
                   WHERE t.id1 = m.id;
                   """
            nodes = []
            node_ids = set()
            conn = None
            logger.info(f"[get_all_memory_items] cypher_query: {cypher_query}")
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
                        """
                        if isinstance(row, (list, tuple)) and len(row) >= 2:
                        """
                        if isinstance(row, list | tuple) and len(row) >= 2:
                            embedding_val, node_val = row[0], row[1]
                        else:
                            embedding_val, node_val = None, row[0]

                        node = self._build_node_from_agtype(node_val, embedding_val)
                        if node:
                            node_id = node["id"]
                            if node_id not in node_ids:
                                nodes.append(node)
                                node_ids.add(node_id)

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)
            finally:
                self._return_connection(conn)

            return nodes
        else:
            # Build WHERE clause with user_name/knowledgebase_ids and filter
            where_parts = [f"n.memory_type = '{scope}'"]
            if user_name_where:
                # user_name_where already contains parentheses if it's an OR condition
                where_parts.append(user_name_where)
            if filter_where_clause:
                # filter_where_clause already contains " AND " prefix, so we just append it
                where_clause = " AND ".join(where_parts) + filter_where_clause
            else:
                where_clause = " AND ".join(where_parts)

            cypher_query = f"""
                   SELECT * FROM cypher('{self.db_name}_graph', $$
                   MATCH (n:Memory)
                   WHERE {where_clause}
                   RETURN properties(n) as props
                   LIMIT 100
                   $$) AS (nprops agtype)
               """

            nodes = []
            conn = None
            logger.info(f"[get_all_memory_items] cypher_query: {cypher_query}")
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
                        """
                        if isinstance(row[0], str):
                            memory_data = json.loads(row[0])
                        else:
                            memory_data = row[0]  # 如果已经是字典，直接使用
                        nodes.append(self._parse_node(memory_data))
                        """
                        memory_data = json.loads(row[0]) if isinstance(row[0], str) else row[0]
                        nodes.append(self._parse_node(memory_data))

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)
            finally:
                self._return_connection(conn)

            return nodes

    def get_all_memory_items_old(
        self, scope: str, include_embedding: bool = False, user_name: str | None = None
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        user_name = user_name if user_name else self._get_config_value("user_name")
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        # Use cypher query to retrieve memory items
        if include_embedding:
            cypher_query = f"""
                WITH t as (
                    SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH (n:Memory)
                    WHERE n.memory_type = '{scope}' AND n.user_name = '{user_name}'
                    RETURN id(n) as id1,n
                    LIMIT 100
                    $$) AS (id1 agtype,n agtype)
                )
                SELECT
                    m.embedding,
                    t.n
                FROM t,
                     {self.db_name}_graph."Memory" m
                WHERE t.id1 = m.id;
                """
        else:
            cypher_query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (n:Memory)
                WHERE n.memory_type = '{scope}' AND n.user_name = '{user_name}'
                RETURN properties(n) as props
                LIMIT 100
                $$) AS (nprops agtype)
            """

            nodes = []
            try:
                with self.connection.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
                        node_agtype = row[0]

                        # Handle string-formatted data
                        if isinstance(node_agtype, str):
                            try:
                                # Remove ::vertex suffix
                                json_str = node_agtype.replace("::vertex", "")
                                node_data = json.loads(json_str)

                                if isinstance(node_data, dict) and "properties" in node_data:
                                    properties = node_data["properties"]
                                    # Build node data
                                    parsed_node_data = {
                                        "id": properties.get("id", ""),
                                        "memory": properties.get("memory", ""),
                                        "metadata": properties,
                                    }

                                    if include_embedding and "embedding" in properties:
                                        parsed_node_data["embedding"] = properties["embedding"]

                                    nodes.append(self._parse_node(parsed_node_data))
                                    logger.debug(
                                        f"[get_all_memory_items] Parsed node successfully: {properties.get('id', '')}"
                                    )
                                else:
                                    logger.warning(f"Invalid node data format: {node_data}")

                            except (json.JSONDecodeError, TypeError) as e:
                                logger.error(f"JSON parsing failed: {e}")
                        elif node_agtype and hasattr(node_agtype, "value"):
                            # Handle agtype object
                            node_props = node_agtype.value
                            if isinstance(node_props, dict):
                                # Parse node properties
                                node_data = {
                                    "id": node_props.get("id", ""),
                                    "memory": node_props.get("memory", ""),
                                    "metadata": node_props,
                                }

                                if include_embedding and "embedding" in node_props:
                                    node_data["embedding"] = node_props["embedding"]

                                nodes.append(self._parse_node(node_data))
                        else:
                            logger.warning(f"Unknown data format: {type(node_agtype)}")

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)

            return nodes

    @timed
    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False, user_name: str | None = None
    ) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build return fields based on include_embedding flag
        if include_embedding:
            return_fields = "id(n) as id1,n"
            return_fields_agtype = " id1 agtype,n agtype"
        else:
            # Build field list without embedding
            return_fields = ",".join(
                [
                    "n.id AS id",
                    "n.memory AS memory",
                    "n.user_name AS user_name",
                    "n.user_id AS user_id",
                    "n.session_id AS session_id",
                    "n.status AS status",
                    "n.key AS key",
                    "n.confidence AS confidence",
                    "n.tags AS tags",
                    "n.created_at AS created_at",
                    "n.updated_at AS updated_at",
                    "n.memory_type AS memory_type",
                    "n.sources AS sources",
                    "n.source AS source",
                    "n.node_type AS node_type",
                    "n.visibility AS visibility",
                    "n.usage AS usage",
                    "n.background AS background",
                    "n.graph_id as graph_id",
                ]
            )
            fields = [
                "id",
                "memory",
                "user_name",
                "user_id",
                "session_id",
                "status",
                "key",
                "confidence",
                "tags",
                "created_at",
                "updated_at",
                "memory_type",
                "sources",
                "source",
                "node_type",
                "visibility",
                "usage",
                "background",
                "graph_id",
            ]
            return_fields_agtype = ", ".join([f"{field} agtype" for field in fields])

        # Use OPTIONAL MATCH to find isolated nodes (no parents or children)
        cypher_query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
            MATCH (n:Memory)
            WHERE n.memory_type = '{scope}'
              AND n.status = 'activated'
              AND n.user_name = '{user_name}'
            OPTIONAL MATCH (n)-[:PARENT]->(c:Memory)
            OPTIONAL MATCH (p:Memory)-[:PARENT]->(n)
            WITH n, c, p
            WHERE c IS NULL AND p IS NULL
            RETURN {return_fields}
            $$) AS ({return_fields_agtype})
        """
        if include_embedding:
            cypher_query = f"""
                    WITH t as (
                        {cypher_query}
                    )
                        SELECT
                        m.embedding,
                        t.n
                        FROM t,
                             {self.db_name}_graph."Memory" m
                        WHERE t.id1 = m.id
                    """
        logger.info(f"[get_structure_optimization_candidates] query: {cypher_query}")

        candidates = []
        node_ids = set()
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(cypher_query)
                results = cursor.fetchall()
                logger.info(f"Found {len(results)} structure optimization candidates")
                for row in results:
                    if include_embedding:
                        # When include_embedding=True, return full node object
                        """
                        if isinstance(row, (list, tuple)) and len(row) >= 2:
                        """
                        if isinstance(row, list | tuple) and len(row) >= 2:
                            embedding_val, node_val = row[0], row[1]
                        else:
                            embedding_val, node_val = None, row[0]

                        node = self._build_node_from_agtype(node_val, embedding_val)
                        if node:
                            node_id = node["id"]
                            if node_id not in node_ids:
                                candidates.append(node)
                                node_ids.add(node_id)
                    else:
                        # When include_embedding=False, return field dictionary
                        # Define field names matching the RETURN clause
                        field_names = [
                            "id",
                            "memory",
                            "user_name",
                            "user_id",
                            "session_id",
                            "status",
                            "key",
                            "confidence",
                            "tags",
                            "created_at",
                            "updated_at",
                            "memory_type",
                            "sources",
                            "source",
                            "node_type",
                            "visibility",
                            "usage",
                            "background",
                            "graph_id",
                        ]

                        # Convert row to dictionary
                        node_data = {}
                        for i, field_name in enumerate(field_names):
                            if i < len(row):
                                value = row[i]
                                # Handle special fields
                                if field_name in ["tags", "sources", "usage"] and isinstance(
                                    value, str
                                ):
                                    try:
                                        # Try parsing JSON string
                                        node_data[field_name] = json.loads(value)
                                    except (json.JSONDecodeError, TypeError):
                                        node_data[field_name] = value
                                else:
                                    node_data[field_name] = value

                        # Parse node using _parse_node_new
                        try:
                            node = self._parse_node_new(node_data)
                            node_id = node["id"]

                            if node_id not in node_ids:
                                candidates.append(node)
                                node_ids.add(node_id)
                                logger.debug(f"Parsed node successfully: {node_id}")
                        except Exception as e:
                            logger.error(f"Failed to parse node: {e}")

        except Exception as e:
            logger.error(f"Failed to get structure optimization candidates: {e}", exc_info=True)
        finally:
            self._return_connection(conn)

        return candidates

    def drop_database(self) -> None:
        """Permanently delete the entire graph this instance is using."""
        return
        if self._get_config_value("use_multi_db", True):
            with self.connection.cursor() as cursor:
                cursor.execute(f"SELECT drop_graph('{self.db_name}_graph', true)")
                logger.info(f"Graph '{self.db_name}_graph' has been dropped.")
        else:
            raise ValueError(
                f"Refusing to drop graph '{self.db_name}_graph' in "
                f"Shared Database Multi-Tenant mode"
            )

    def _parse_node(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """Parse node data from database format to standard format."""
        node = node_data.copy()

        # Convert datetime to string
        for time_field in ("created_at", "updated_at"):
            if time_field in node and hasattr(node[time_field], "isoformat"):
                node[time_field] = node[time_field].isoformat()

        # Deserialize sources from JSON strings back to dict objects
        if "sources" in node and node.get("sources"):
            sources = node["sources"]
            if isinstance(sources, list):
                deserialized_sources = []
                for source_item in sources:
                    if isinstance(source_item, str):
                        # Try to parse JSON string
                        try:
                            parsed = json.loads(source_item)
                            deserialized_sources.append(parsed)
                        except (json.JSONDecodeError, TypeError):
                            # If parsing fails, keep as string or create a simple dict
                            deserialized_sources.append({"type": "doc", "content": source_item})
                    elif isinstance(source_item, dict):
                        # Already a dict, keep as is
                        deserialized_sources.append(source_item)
                    else:
                        # Unknown type, create a simple dict
                        deserialized_sources.append({"type": "doc", "content": str(source_item)})
                node["sources"] = deserialized_sources

        return {"id": node.get("id"), "memory": node.get("memory", ""), "metadata": node}

    def _parse_node_new(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """Parse node data from database format to standard format."""
        node = node_data.copy()

        # Normalize string values that may arrive as quoted literals (e.g., '"abc"')
        def _strip_wrapping_quotes(value: Any) -> Any:
            """
            if isinstance(value, str) and len(value) >= 2:
                if value[0] == value[-1] and value[0] in ("'", '"'):
                    return value[1:-1]
            return value
            """
            if (
                isinstance(value, str)
                and len(value) >= 2
                and value[0] == value[-1]
                and value[0] in ("'", '"')
            ):
                return value[1:-1]
            return value

        for k, v in list(node.items()):
            if isinstance(v, str):
                node[k] = _strip_wrapping_quotes(v)

        # Convert datetime to string
        for time_field in ("created_at", "updated_at"):
            if time_field in node and hasattr(node[time_field], "isoformat"):
                node[time_field] = node[time_field].isoformat()

        # Deserialize sources from JSON strings back to dict objects
        if "sources" in node and node.get("sources"):
            sources = node["sources"]
            if isinstance(sources, list):
                deserialized_sources = []
                for source_item in sources:
                    if isinstance(source_item, str):
                        # Try to parse JSON string
                        try:
                            parsed = json.loads(source_item)
                            deserialized_sources.append(parsed)
                        except (json.JSONDecodeError, TypeError):
                            # If parsing fails, keep as string or create a simple dict
                            deserialized_sources.append({"type": "doc", "content": source_item})
                    elif isinstance(source_item, dict):
                        # Already a dict, keep as is
                        deserialized_sources.append(source_item)
                    else:
                        # Unknown type, create a simple dict
                        deserialized_sources.append({"type": "doc", "content": str(source_item)})
                node["sources"] = deserialized_sources

        # Do not remove user_name; keep all fields

        return {"id": node.pop("id"), "memory": node.pop("memory", ""), "metadata": node}

    def __del__(self):
        """Close database connection when object is destroyed."""
        if hasattr(self, "connection") and self.connection:
            self.connection.close()

    @timed
    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Add a memory node to the graph."""
        logger.info(f"[add_node] id: {id}, memory: {memory}, metadata: {metadata}")

        # user_name comes from metadata; fallback to config if missing
        metadata["user_name"] = user_name if user_name else self.config.user_name

        metadata = _prepare_node_metadata(metadata)

        # Merge node and set metadata
        created_at = metadata.pop("created_at", datetime.utcnow().isoformat())
        updated_at = metadata.pop("updated_at", datetime.utcnow().isoformat())

        # Prepare properties
        properties = {
            "id": id,
            "memory": memory,
            "created_at": created_at,
            "updated_at": updated_at,
            **metadata,
        }

        # Generate embedding if not provided
        if "embedding" not in properties or not properties["embedding"]:
            properties["embedding"] = generate_vector(
                self._get_config_value("embedding_dimension", 1024)
            )

        # serialization - JSON-serialize sources and usage fields
        for field_name in ["sources", "usage"]:
            if properties.get(field_name):
                if isinstance(properties[field_name], list):
                    for idx in range(len(properties[field_name])):
                        # Serialize only when element is not a string
                        if not isinstance(properties[field_name][idx], str):
                            properties[field_name][idx] = json.dumps(properties[field_name][idx])
                elif isinstance(properties[field_name], str):
                    # If already a string, leave as-is
                    pass

        # Extract embedding for separate column
        embedding_vector = properties.pop("embedding", [])
        if not isinstance(embedding_vector, list):
            embedding_vector = []

        # Select column name based on embedding dimension
        embedding_column = "embedding"  # default column
        if len(embedding_vector) == 3072:
            embedding_column = "embedding_3072"
        elif len(embedding_vector) == 1024:
            embedding_column = "embedding"
        elif len(embedding_vector) == 768:
            embedding_column = "embedding_768"

        conn = None
        insert_query = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Delete existing record first (if any)
                delete_query = f"""
                    DELETE FROM {self.db_name}_graph."Memory"
                    WHERE id = ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring)
                """
                cursor.execute(delete_query, (id,))
                #
                get_graph_id_query = f"""
                                  SELECT ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring)
                              """
                cursor.execute(get_graph_id_query, (id,))
                graph_id = cursor.fetchone()[0]
                properties["graph_id"] = str(graph_id)

                # Then insert new record
                if embedding_vector:
                    insert_query = f"""
                        INSERT INTO {self.db_name}_graph."Memory"(id, properties, {embedding_column})
                        VALUES (
                            ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring),
                            %s,
                            %s
                        )
                    """
                    cursor.execute(
                        insert_query, (id, json.dumps(properties), json.dumps(embedding_vector))
                    )
                    logger.info(
                        f"[add_node] [embedding_vector-true] insert_query: {insert_query}, properties: {json.dumps(properties)}"
                    )
                else:
                    insert_query = f"""
                        INSERT INTO {self.db_name}_graph."Memory"(id, properties)
                        VALUES (
                            ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring),
                            %s
                        )
                    """
                    cursor.execute(insert_query, (id, json.dumps(properties)))
                    logger.info(
                        f"[add_node] [embedding_vector-false] insert_query: {insert_query}, properties: {json.dumps(properties)}"
                    )
        except Exception as e:
            logger.error(f"[add_node] Failed to add node: {e}", exc_info=True)
            raise
        finally:
            if insert_query:
                logger.info(f"In add node polardb: id-{id} memory-{memory} query-{insert_query}")
            self._return_connection(conn)

    @timed
    def add_nodes_batch(
        self,
        nodes: list[dict[str, Any]],
        user_name: str | None = None,
    ) -> None:
        """
        Batch add multiple memory nodes to the graph.

        Args:
            nodes: List of node dictionaries, each containing:
                - id: str - Node ID
                - memory: str - Memory content
                - metadata: dict[str, Any] - Node metadata
            user_name: Optional user name (will use config default if not provided)
        """
        batch_start_time = time.time()
        if not nodes:
            logger.warning("[add_nodes_batch] Empty nodes list, skipping")
            return

        logger.info(f"[add_nodes_batch] Adding {len(nodes)} nodes")

        # user_name comes from parameter; fallback to config if missing
        effective_user_name = user_name if user_name else self.config.user_name

        # Prepare all nodes
        prepared_nodes = []
        for node_data in nodes:
            try:
                id = node_data["id"]
                memory = node_data["memory"]
                metadata = node_data.get("metadata", {})

                logger.debug(f"[add_nodes_batch] Processing node id: {id}")

                # Set user_name in metadata
                metadata["user_name"] = effective_user_name

                metadata = _prepare_node_metadata(metadata)

                # Merge node and set metadata
                created_at = metadata.pop("created_at", datetime.utcnow().isoformat())
                updated_at = metadata.pop("updated_at", datetime.utcnow().isoformat())

                # Prepare properties
                properties = {
                    "id": id,
                    "memory": memory,
                    "created_at": created_at,
                    "updated_at": updated_at,
                    **metadata,
                }

                # Generate embedding if not provided
                if "embedding" not in properties or not properties["embedding"]:
                    properties["embedding"] = generate_vector(
                        self._get_config_value("embedding_dimension", 1024)
                    )

                # Serialization - JSON-serialize sources and usage fields
                for field_name in ["sources", "usage"]:
                    if properties.get(field_name):
                        if isinstance(properties[field_name], list):
                            for idx in range(len(properties[field_name])):
                                # Serialize only when element is not a string
                                if not isinstance(properties[field_name][idx], str):
                                    properties[field_name][idx] = json.dumps(
                                        properties[field_name][idx]
                                    )
                        elif isinstance(properties[field_name], str):
                            # If already a string, leave as-is
                            pass

                # Extract embedding for separate column
                embedding_vector = properties.pop("embedding", [])
                if not isinstance(embedding_vector, list):
                    embedding_vector = []

                # Select column name based on embedding dimension
                embedding_column = "embedding"  # default column
                if len(embedding_vector) == 3072:
                    embedding_column = "embedding_3072"
                elif len(embedding_vector) == 1024:
                    embedding_column = "embedding"
                elif len(embedding_vector) == 768:
                    embedding_column = "embedding_768"

                prepared_nodes.append(
                    {
                        "id": id,
                        "memory": memory,
                        "properties": properties,
                        "embedding_vector": embedding_vector,
                        "embedding_column": embedding_column,
                    }
                )
            except Exception as e:
                logger.error(
                    f"[add_nodes_batch] Failed to prepare node {node_data.get('id', 'unknown')}: {e}",
                    exc_info=True,
                )
                # Continue with other nodes
                continue

        if not prepared_nodes:
            logger.warning("[add_nodes_batch] No valid nodes to insert after preparation")
            return

        # Group nodes by embedding column to optimize batch inserts
        nodes_by_embedding_column = {}
        for node in prepared_nodes:
            col = node["embedding_column"]
            if col not in nodes_by_embedding_column:
                nodes_by_embedding_column[col] = []
            nodes_by_embedding_column[col].append(node)

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Process each group separately
                for embedding_column, nodes_group in nodes_by_embedding_column.items():
                    # Batch delete existing records using IN clause
                    ids_to_delete = [node["id"] for node in nodes_group]
                    if ids_to_delete:
                        delete_query = f"""
                            DELETE FROM {self.db_name}_graph."Memory"
                            WHERE id IN (
                                SELECT ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, unnest(%s::text[])::cstring)
                            )
                        """
                        cursor.execute(delete_query, (ids_to_delete,))

                    # Batch get graph_ids for all nodes
                    get_graph_ids_query = f"""
                        SELECT
                            id_val,
                            ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, id_val::text::cstring) as graph_id
                        FROM unnest(%s::text[]) as id_val
                    """
                    cursor.execute(get_graph_ids_query, (ids_to_delete,))
                    graph_id_map = {row[0]: row[1] for row in cursor.fetchall()}

                    # Add graph_id to properties
                    for node in nodes_group:
                        graph_id = graph_id_map.get(node["id"])
                        if graph_id:
                            node["properties"]["graph_id"] = str(graph_id)

                    # Batch insert using VALUES with multiple rows
                    # Use psycopg2.extras.execute_values for efficient batch insert
                    from psycopg2.extras import execute_values

                    if embedding_column and any(node["embedding_vector"] for node in nodes_group):
                        # Prepare data tuples for batch insert with embedding
                        data_tuples = []
                        for node in nodes_group:
                            # Each tuple: (id, properties_json, embedding_json)
                            data_tuples.append(
                                (
                                    node["id"],
                                    json.dumps(node["properties"]),
                                    json.dumps(node["embedding_vector"])
                                    if node["embedding_vector"]
                                    else None,
                                )
                            )

                        # Build the INSERT query template
                        insert_query = f"""
                            INSERT INTO {self.db_name}_graph."Memory"(id, properties, {embedding_column})
                            VALUES %s
                        """

                        # Build the VALUES template for execute_values
                        # Each row: (graph_id_function, agtype, vector)
                        # Note: properties column is agtype, not jsonb
                        template = f"""
                            (
                                ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring),
                                %s::text::agtype,
                                %s::vector
                            )
                        """
                        # Execute batch insert
                        execute_values(
                            cursor,
                            insert_query,
                            data_tuples,
                            template=template,
                            page_size=100,  # Insert in batches of 100
                        )
                    else:
                        # Prepare data tuples for batch insert without embedding
                        data_tuples = []
                        for node in nodes_group:
                            # Each tuple: (id, properties_json)
                            data_tuples.append(
                                (
                                    node["id"],
                                    json.dumps(node["properties"]),
                                )
                            )

                        # Build the INSERT query template
                        insert_query = f"""
                            INSERT INTO {self.db_name}_graph."Memory"(id, properties)
                            VALUES %s
                        """

                        # Build the VALUES template for execute_values
                        # Note: properties column is agtype, not jsonb
                        template = f"""
                            (
                                ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring),
                                %s::text::agtype
                            )
                        """
                        logger.info(f"[add_nodes_batch] Inserting insert_query:{insert_query}")
                        logger.info(f"[add_nodes_batch] Inserting data_tuples:{data_tuples}")
                        # Execute batch insert
                        execute_values(
                            cursor,
                            insert_query,
                            data_tuples,
                            template=template,
                            page_size=100,  # Insert in batches of 100
                        )

                    logger.info(
                        f"[add_nodes_batch] Inserted {len(nodes_group)} nodes with embedding_column={embedding_column}"
                    )
                    elapsed_time = time.time() - batch_start_time
                    logger.info(
                        f"[add_nodes_batch] execute_values completed successfully in {elapsed_time:.2f}s"
                    )

        except Exception as e:
            logger.error(f"[add_nodes_batch] Failed to add nodes: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    def _build_node_from_agtype(self, node_agtype, embedding=None):
        """
        Parse the cypher-returned column `n` (agtype or JSON string)
        into a standard node and merge embedding into properties.
        """
        try:
            # String case: '{"id":...,"label":[...],"properties":{...}}::vertex'
            if isinstance(node_agtype, str):
                json_str = node_agtype.replace("::vertex", "")
                obj = json.loads(json_str)
                if not (isinstance(obj, dict) and "properties" in obj):
                    return None
                props = obj["properties"]
            # agtype case: has `value` attribute
            elif node_agtype and hasattr(node_agtype, "value"):
                val = node_agtype.value
                if not (isinstance(val, dict) and "properties" in val):
                    return None
                props = val["properties"]
            else:
                return None

            if embedding is not None:
                if isinstance(embedding, str):
                    try:
                        embedding = json.loads(embedding)
                    except (json.JSONDecodeError, TypeError):
                        logger.warning("Failed to parse embedding for node")
                props["embedding"] = embedding

            # Return standard format directly
            return {"id": props.get("id", ""), "memory": props.get("memory", ""), "metadata": props}
        except Exception:
            return None

    @timed
    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of dicts with node details and overlap count.
        """
        if not tags:
            return []

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build query conditions - more relaxed filters
        where_clauses = []
        params = []

        # Exclude specified IDs - use id in properties
        if exclude_ids:
            exclude_conditions = []
            for exclude_id in exclude_ids:
                exclude_conditions.append(
                    "ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) != %s::agtype"
                )
                params.append(self.format_param_value(exclude_id))
            where_clauses.append(f"({' AND '.join(exclude_conditions)})")

        # Status filter - keep only 'activated'
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
        )

        # Type filter - exclude 'reasoning' type
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"node_type\"'::agtype) != '\"reasoning\"'::agtype"
        )

        # User filter
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        )
        params.append(self.format_param_value(user_name))

        # Testing showed no data; annotate.
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) != '\"WorkingMemory\"'::agtype"
        )

        where_clause = " AND ".join(where_clauses)

        # Fetch all candidate nodes
        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory"
            WHERE {where_clause}
        """

        logger.debug(f"[get_neighbors_by_tag] query: {query}, params: {params}")

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()

                nodes_with_overlap = []
                for row in results:
                    node_id, properties_json, embedding_json = row
                    properties = properties_json if properties_json else {}

                    # Parse embedding
                    if include_embedding and embedding_json is not None:
                        try:
                            embedding = (
                                json.loads(embedding_json)
                                if isinstance(embedding_json, str)
                                else embedding_json
                            )
                            properties["embedding"] = embedding
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse embedding for node {node_id}")

                    # Compute tag overlap
                    node_tags = properties.get("tags", [])
                    if isinstance(node_tags, str):
                        try:
                            node_tags = json.loads(node_tags)
                        except (json.JSONDecodeError, TypeError):
                            node_tags = []

                    overlap_tags = [tag for tag in tags if tag in node_tags]
                    overlap_count = len(overlap_tags)

                    if overlap_count >= min_overlap:
                        node_data = self._parse_node(
                            {
                                "id": properties.get("id", node_id),
                                "memory": properties.get("memory", ""),
                                "metadata": properties,
                            }
                        )
                        nodes_with_overlap.append((node_data, overlap_count))

                # Sort by overlap count and return top_k items
                nodes_with_overlap.sort(key=lambda x: x[1], reverse=True)
                return [node for node, _ in nodes_with_overlap[:top_k]]

        except Exception as e:
            logger.error(f"Failed to get neighbors by tag: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)

    def get_neighbors_by_tag_ccl(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of dicts with node details and overlap count.
        """
        if not tags:
            return []

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build query conditions; keep consistent with nebular.py
        where_clauses = [
            'n.status = "activated"',
            'NOT (n.node_type = "reasoning")',
            'NOT (n.memory_type = "WorkingMemory")',
        ]
        where_clauses = [
            'n.status = "activated"',
            'NOT (n.memory_type = "WorkingMemory")',
        ]

        if exclude_ids:
            exclude_ids_str = "[" + ", ".join(f'"{id}"' for id in exclude_ids) + "]"
            where_clauses.append(f"NOT (n.id IN {exclude_ids_str})")

        where_clauses.append(f'n.user_name = "{user_name}"')

        where_clause = " AND ".join(where_clauses)
        tag_list_literal = "[" + ", ".join(f'"{t}"' for t in tags) + "]"

        return_fields = [
            "n.id AS id",
            "n.memory AS memory",
            "n.user_name AS user_name",
            "n.user_id AS user_id",
            "n.session_id AS session_id",
            "n.status AS status",
            "n.key AS key",
            "n.confidence AS confidence",
            "n.tags AS tags",
            "n.created_at AS created_at",
            "n.updated_at AS updated_at",
            "n.memory_type AS memory_type",
            "n.sources AS sources",
            "n.source AS source",
            "n.node_type AS node_type",
            "n.visibility AS visibility",
            "n.background AS background",
        ]

        if include_embedding:
            return_fields.append("n.embedding AS embedding")

        return_fields_str = ", ".join(return_fields)
        result_fields = []
        for field in return_fields:
            # Extract field name 'id' from 'n.id AS id'
            field_name = field.split(" AS ")[-1]
            result_fields.append(f"{field_name} agtype")

        # Add overlap_count
        result_fields.append("overlap_count agtype")
        result_fields_str = ", ".join(result_fields)
        # Use Cypher query; keep consistent with nebular.py
        query = f"""
            SELECT * FROM (
                SELECT * FROM cypher('{self.db_name}_graph', $$
                WITH {tag_list_literal} AS tag_list
                MATCH (n:Memory)
                WHERE {where_clause}
                RETURN {return_fields_str},
                       size([tag IN n.tags WHERE tag IN tag_list]) AS overlap_count
                $$) AS ({result_fields_str})
            ) AS subquery
            ORDER BY (overlap_count::integer) DESC
            LIMIT {top_k}
        """
        logger.debug(f"get_neighbors_by_tag: {query}")
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                neighbors = []
                for row in results:
                    # Parse results
                    props = {}
                    overlap_count = None

                    # Manually parse each field
                    field_names = [
                        "id",
                        "memory",
                        "user_name",
                        "user_id",
                        "session_id",
                        "status",
                        "key",
                        "confidence",
                        "tags",
                        "created_at",
                        "updated_at",
                        "memory_type",
                        "sources",
                        "source",
                        "node_type",
                        "visibility",
                        "background",
                    ]

                    if include_embedding:
                        field_names.append("embedding")
                    field_names.append("overlap_count")

                    for i, field in enumerate(field_names):
                        if field == "overlap_count":
                            overlap_count = row[i].value if hasattr(row[i], "value") else row[i]
                        else:
                            props[field] = row[i].value if hasattr(row[i], "value") else row[i]
                    overlap_int = int(overlap_count)
                    if overlap_count is not None and overlap_int >= min_overlap:
                        parsed = self._parse_node(props)
                        parsed["overlap_count"] = overlap_int
                        neighbors.append(parsed)

                # Sort by overlap count
                neighbors.sort(key=lambda x: x["overlap_count"], reverse=True)
                neighbors = neighbors[:top_k]

                # Remove overlap_count field
                result = []
                for neighbor in neighbors:
                    neighbor.pop("overlap_count", None)
                    result.append(neighbor)

                return result

        except Exception as e:
            logger.error(f"Failed to get neighbors by tag: {e}", exc_info=True)
            return []

    @timed
    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        """
        Import the entire graph from a serialized dictionary.

        Args:
            data: A dictionary containing all nodes and edges to be loaded.
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Import nodes
        for node in data.get("nodes", []):
            try:
                id, memory, metadata = _compose_node(node)
                metadata["user_name"] = user_name
                metadata = _prepare_node_metadata(metadata)
                metadata.update({"id": id, "memory": memory})

                # Use add_node to insert node
                self.add_node(id, memory, metadata)

            except Exception as e:
                logger.error(f"Fail to load node: {node}, error: {e}")

        # Import edges
        for edge in data.get("edges", []):
            try:
                source_id, target_id = edge["source"], edge["target"]
                edge_type = edge["type"]

                # Use add_edge to insert edge
                self.add_edge(source_id, target_id, edge_type, user_name)

            except Exception as e:
                logger.error(f"Fail to load edge: {edge}, error: {e}")

    @timed
    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY", user_name: str | None = None
    ) -> list[dict[str, str]]:
        """
        Get edges connected to a node, with optional type and direction filter.

        Args:
            id: Node ID to retrieve edges for.
            type: Relationship type to match, or 'ANY' to match all.
            direction: 'OUTGOING', 'INCOMING', or 'ANY'.
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of edges:
            [
              {"from": "source_id", "to": "target_id", "type": "RELATE"},
              ...
            ]
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        if direction == "OUTGOING":
            pattern = "(a:Memory)-[r]->(b:Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "INCOMING":
            pattern = "(a:Memory)<-[r]-(b:Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "ANY":
            pattern = "(a:Memory)-[r]-(b:Memory)"
            where_clause = f"a.id = '{id}' OR b.id = '{id}'"
        else:
            raise ValueError("Invalid direction. Must be 'OUTGOING', 'INCOMING', or 'ANY'.")

        # Add type filter
        if type != "ANY":
            where_clause += f" AND type(r) = '{type}'"

        # Add user filter
        where_clause += f" AND a.user_name = '{user_name}' AND b.user_name = '{user_name}'"

        query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
            MATCH {pattern}
            WHERE {where_clause}
            RETURN a.id AS from_id, b.id AS to_id, type(r) AS edge_type
            $$) AS (from_id agtype, to_id agtype, edge_type agtype)
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                edges = []
                for row in results:
                    # Extract and clean from_id
                    from_id_raw = row[0].value if hasattr(row[0], "value") else row[0]
                    if (
                        isinstance(from_id_raw, str)
                        and from_id_raw.startswith('"')
                        and from_id_raw.endswith('"')
                    ):
                        from_id = from_id_raw[1:-1]
                    else:
                        from_id = str(from_id_raw)

                    # Extract and clean to_id
                    to_id_raw = row[1].value if hasattr(row[1], "value") else row[1]
                    if (
                        isinstance(to_id_raw, str)
                        and to_id_raw.startswith('"')
                        and to_id_raw.endswith('"')
                    ):
                        to_id = to_id_raw[1:-1]
                    else:
                        to_id = str(to_id_raw)

                    # Extract and clean edge_type
                    edge_type_raw = row[2].value if hasattr(row[2], "value") else row[2]
                    if (
                        isinstance(edge_type_raw, str)
                        and edge_type_raw.startswith('"')
                        and edge_type_raw.endswith('"')
                    ):
                        edge_type = edge_type_raw[1:-1]
                    else:
                        edge_type = str(edge_type_raw)

                    edges.append({"from": from_id, "to": to_id, "type": edge_type})
                return edges

        except Exception as e:
            logger.error(f"Failed to get edges: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)

    def _convert_graph_edges(self, core_node: dict) -> dict:
        import copy

        data = copy.deepcopy(core_node)
        id_map = {}
        core_node = data.get("core_node", {})
        if not core_node:
            return {
                "core_node": None,
                "neighbors": data.get("neighbors", []),
                "edges": data.get("edges", []),
            }
        core_meta = core_node.get("metadata", {})
        if "graph_id" in core_meta and "id" in core_node:
            id_map[core_meta["graph_id"]] = core_node["id"]
        for neighbor in data.get("neighbors", []):
            n_meta = neighbor.get("metadata", {})
            if "graph_id" in n_meta and "id" in neighbor:
                id_map[n_meta["graph_id"]] = neighbor["id"]
        for edge in data.get("edges", []):
            src = edge.get("source")
            tgt = edge.get("target")
            if src in id_map:
                edge["source"] = id_map[src]
            if tgt in id_map:
                edge["target"] = id_map[tgt]
        return data

    def format_param_value(self, value: str | None) -> str:
        """Format parameter value to handle both quoted and unquoted formats"""
        # Handle None value
        if value is None:
            logger.warning("format_param_value: value is None")
            return "null"

        # Remove outer quotes if they exist
        if value.startswith('"') and value.endswith('"'):
            # Already has double quotes, return as is
            return value
        else:
            # Add double quotes
            return f'"{value}"'

    def _build_user_name_and_kb_ids_conditions_cypher(
        self,
        user_name: str | None,
        knowledgebase_ids: list | None,
        default_user_name: str | None = None,
    ) -> list[str]:
        """
        Build user_name and knowledgebase_ids conditions for Cypher queries.

        Args:
            user_name: User name for filtering
            knowledgebase_ids: List of knowledgebase IDs
            default_user_name: Default user name from config if user_name is None

        Returns:
            List of condition strings (will be joined with OR)
        """
        user_name_conditions = []
        effective_user_name = user_name if user_name else default_user_name

        if effective_user_name:
            escaped_user_name = effective_user_name.replace("'", "''")
            user_name_conditions.append(f"n.user_name = '{escaped_user_name}'")

        # Add knowledgebase_ids conditions (checking user_name field in the data)
        if knowledgebase_ids and isinstance(knowledgebase_ids, list) and len(knowledgebase_ids) > 0:
            for kb_id in knowledgebase_ids:
                if isinstance(kb_id, str):
                    escaped_kb_id = kb_id.replace("'", "''")
                    user_name_conditions.append(f"n.user_name = '{escaped_kb_id}'")

        return user_name_conditions

    def _build_user_name_and_kb_ids_conditions_sql(
        self,
        user_name: str | None,
        knowledgebase_ids: list | None,
        default_user_name: str | None = None,
    ) -> list[str]:
        """
        Build user_name and knowledgebase_ids conditions for SQL queries.

        Args:
            user_name: User name for filtering
            knowledgebase_ids: List of knowledgebase IDs
            default_user_name: Default user name from config if user_name is None

        Returns:
            List of condition strings (will be joined with OR)
        """
        user_name_conditions = []
        effective_user_name = user_name if user_name else default_user_name

        if effective_user_name:
            user_name_conditions.append(
                f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{effective_user_name}\"'::agtype"
            )

        # Add knowledgebase_ids conditions (checking user_name field in the data)
        if knowledgebase_ids and isinstance(knowledgebase_ids, list) and len(knowledgebase_ids) > 0:
            for kb_id in knowledgebase_ids:
                if isinstance(kb_id, str):
                    user_name_conditions.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{kb_id}\"'::agtype"
                    )

        return user_name_conditions

    def _build_filter_conditions_cypher(
        self,
        filter: dict | None,
    ) -> str:
        """
        Build filter conditions for Cypher queries.

        Args:
            filter: Filter dictionary with "or" or "and" logic

        Returns:
            Filter WHERE clause string (empty string if no filter)
        """
        filter_where_clause = ""
        filter = self.parse_filter(filter)
        if filter:

            def escape_cypher_string(value: str) -> str:
                """
                Escape single quotes in Cypher string literals.

                In Cypher, single quotes in string literals are escaped by doubling them: ' -> ''
                However, when inside PostgreSQL's $$ dollar-quoted string, we need to be careful.

                The issue: In $$ delimiters, Cypher still needs to parse string literals correctly.
                The solution: Use backslash escape \' instead of doubling '' when inside $$.
                """
                # Use backslash escape for single quotes inside $$ dollar-quoted strings
                # This works because $$ protects the backslash from PostgreSQL interpretation
                return value.replace("'", "\\'")

            def build_cypher_filter_condition(condition_dict: dict) -> str:
                """Build a Cypher WHERE condition for a single filter item."""
                condition_parts = []
                for key, value in condition_dict.items():
                    # Check if value is a dict with comparison operators (gt, lt, gte, lte, =, contains, in, like)
                    if isinstance(value, dict):
                        # Handle comparison operators: gt, lt, gte, lte, =, contains, in, like
                        # Supports multiple operators for the same field, e.g.:
                        # will generate: n.created_at >= '2025-09-19' AND n.created_at <= '2025-12-31'
                        for op, op_value in value.items():
                            if op in ("gt", "lt", "gte", "lte"):
                                # Map operator to Cypher operator
                                cypher_op_map = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
                                cypher_op = cypher_op_map[op]

                                # Check if key starts with "info." prefix (for nested fields like info.A, info.B)
                                if key.startswith("info."):
                                    # Nested field access: n.info.field_name
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        condition_parts.append(
                                            f"n.info.{info_field} {cypher_op} '{escaped_value}'"
                                        )
                                    else:
                                        condition_parts.append(
                                            f"n.info.{info_field} {cypher_op} {op_value}"
                                        )
                                else:
                                    # Direct property access (e.g., "created_at" is directly in n, not in n.info)
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        condition_parts.append(
                                            f"n.{key} {cypher_op} '{escaped_value}'"
                                        )
                                    else:
                                        condition_parts.append(f"n.{key} {cypher_op} {op_value}")
                            elif op == "=":
                                # Handle equality operator
                                # For array fields, = means exact match of the entire array (e.g., tags = ['test:zdy'] or tags = ['mode:fast', 'test:zdy'])
                                # For scalar fields, = means equality
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        # For array fields, check if array exactly equals [value]
                                        # For scalar fields, use =
                                        if info_field in ("tags", "sources"):
                                            condition_parts.append(
                                                f"n.info.{info_field} = ['{escaped_value}']"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"n.info.{info_field} = '{escaped_value}'"
                                            )
                                    elif isinstance(op_value, list):
                                        # For array fields, format list as Cypher array
                                        if info_field in ("tags", "sources"):
                                            escaped_items = [
                                                f"'{escape_cypher_string(str(item))}'"
                                                for item in op_value
                                            ]
                                            array_str = "[" + ", ".join(escaped_items) + "]"
                                            condition_parts.append(
                                                f"n.info.{info_field} = {array_str}"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"n.info.{info_field} = {op_value}"
                                            )
                                    else:
                                        if info_field in ("tags", "sources"):
                                            condition_parts.append(
                                                f"n.info.{info_field} = [{op_value}]"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"n.info.{info_field} = {op_value}"
                                            )
                                else:
                                    # Direct property access
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        # For array fields, check if array exactly equals [value]
                                        # For scalar fields, use =
                                        if key in ("tags", "sources"):
                                            condition_parts.append(f"n.{key} = ['{escaped_value}']")
                                        else:
                                            condition_parts.append(f"n.{key} = '{escaped_value}'")
                                    elif isinstance(op_value, list):
                                        # For array fields, format list as Cypher array
                                        if key in ("tags", "sources"):
                                            escaped_items = [
                                                f"'{escape_cypher_string(str(item))}'"
                                                for item in op_value
                                            ]
                                            array_str = "[" + ", ".join(escaped_items) + "]"
                                            condition_parts.append(f"n.{key} = {array_str}")
                                        else:
                                            condition_parts.append(f"n.{key} = {op_value}")
                                    else:
                                        if key in ("tags", "sources"):
                                            condition_parts.append(f"n.{key} = [{op_value}]")
                                        else:
                                            condition_parts.append(f"n.{key} = {op_value}")
                            elif op == "contains":
                                # Handle contains operator (for array fields)
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        condition_parts.append(
                                            f"'{escaped_value}' IN n.info.{info_field}"
                                        )
                                    else:
                                        condition_parts.append(f"{op_value} IN n.info.{info_field}")
                                else:
                                    # Direct property access
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        condition_parts.append(f"'{escaped_value}' IN n.{key}")
                                    else:
                                        condition_parts.append(f"{op_value} IN n.{key}")
                            elif op == "in":
                                # Handle in operator (for checking if field value is in a list)
                                # Supports array format: {"field": {"in": ["value1", "value2"]}}
                                # Generates: n.field IN ['value1', 'value2'] or (n.field = 'value1' OR n.field = 'value2')
                                if not isinstance(op_value, list):
                                    raise ValueError(
                                        f"in operator only supports array format. "
                                        f"Use {{'{key}': {{'in': ['{op_value}']}}}} instead of {{'{key}': {{'in': '{op_value}'}}}}"
                                    )
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    # Build OR conditions for nested properties (Apache AGE compatibility)
                                    if len(op_value) == 0:
                                        # Empty list means no match
                                        condition_parts.append("false")
                                    elif len(op_value) == 1:
                                        # Single value, use equality
                                        item = op_value[0]
                                        if isinstance(item, str):
                                            escaped_value = escape_cypher_string(item)
                                            condition_parts.append(
                                                f"n.info.{info_field} = '{escaped_value}'"
                                            )
                                        else:
                                            condition_parts.append(f"n.info.{info_field} = {item}")
                                    else:
                                        # Multiple values, use OR conditions instead of IN (Apache AGE compatibility)
                                        or_conditions = []
                                        for item in op_value:
                                            if isinstance(item, str):
                                                escaped_value = escape_cypher_string(item)
                                                or_conditions.append(
                                                    f"n.info.{info_field} = '{escaped_value}'"
                                                )
                                            else:
                                                or_conditions.append(
                                                    f"n.info.{info_field} = {item}"
                                                )
                                        if or_conditions:
                                            condition_parts.append(
                                                f"({' OR '.join(or_conditions)})"
                                            )
                                else:
                                    # Direct property access
                                    # Build array for IN clause or OR conditions
                                    if len(op_value) == 0:
                                        # Empty list means no match
                                        condition_parts.append("false")
                                    elif len(op_value) == 1:
                                        # Single value, use equality
                                        item = op_value[0]
                                        if isinstance(item, str):
                                            escaped_value = escape_cypher_string(item)
                                            condition_parts.append(f"n.{key} = '{escaped_value}'")
                                        else:
                                            condition_parts.append(f"n.{key} = {item}")
                                    else:
                                        # Multiple values, use IN clause
                                        escaped_items = [
                                            f"'{escape_cypher_string(str(item))}'"
                                            if isinstance(item, str)
                                            else str(item)
                                            for item in op_value
                                        ]
                                        array_str = "[" + ", ".join(escaped_items) + "]"
                                        condition_parts.append(f"n.{key} IN {array_str}")
                            elif op == "like":
                                # Handle like operator (for fuzzy matching, similar to SQL LIKE '%value%')
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        condition_parts.append(
                                            f"n.info.{info_field} CONTAINS '{escaped_value}'"
                                        )
                                    else:
                                        condition_parts.append(
                                            f"n.info.{info_field} CONTAINS {op_value}"
                                        )
                                else:
                                    # Direct property access
                                    if isinstance(op_value, str):
                                        escaped_value = escape_cypher_string(op_value)
                                        condition_parts.append(
                                            f"n.{key} CONTAINS '{escaped_value}'"
                                        )
                                    else:
                                        condition_parts.append(f"n.{key} CONTAINS {op_value}")
                    # Check if key starts with "info." prefix (for simple equality)
                    elif key.startswith("info."):
                        info_field = key[5:]
                        if isinstance(value, str):
                            escaped_value = escape_cypher_string(value)
                            condition_parts.append(f"n.info.{info_field} = '{escaped_value}'")
                        else:
                            condition_parts.append(f"n.info.{info_field} = {value}")
                    else:
                        # Direct property access (simple equality)
                        if isinstance(value, str):
                            escaped_value = escape_cypher_string(value)
                            condition_parts.append(f"n.{key} = '{escaped_value}'")
                        else:
                            condition_parts.append(f"n.{key} = {value}")
                return " AND ".join(condition_parts)

            if isinstance(filter, dict):
                if "or" in filter:
                    or_conditions = []
                    for condition in filter["or"]:
                        if isinstance(condition, dict):
                            condition_str = build_cypher_filter_condition(condition)
                            if condition_str:
                                or_conditions.append(f"({condition_str})")
                    if or_conditions:
                        filter_where_clause = " AND " + f"({' OR '.join(or_conditions)})"

                elif "and" in filter:
                    and_conditions = []
                    for condition in filter["and"]:
                        if isinstance(condition, dict):
                            condition_str = build_cypher_filter_condition(condition)
                            if condition_str:
                                and_conditions.append(f"({condition_str})")
                    if and_conditions:
                        filter_where_clause = " AND " + " AND ".join(and_conditions)
                else:
                    # Handle simple dict without "and" or "or" (e.g., {"id": "xxx"})
                    condition_str = build_cypher_filter_condition(filter)
                    if condition_str:
                        filter_where_clause = " AND " + condition_str

        return filter_where_clause

    def _build_filter_conditions_sql(
        self,
        filter: dict | None,
    ) -> list[str]:
        """
        Build filter conditions for SQL queries.

        Args:
            filter: Filter dictionary with "or" or "and" logic

        Returns:
            List of filter WHERE clause strings (empty list if no filter)
        """
        filter_conditions = []
        filter = self.parse_filter(filter)
        if filter:
            # Helper function to escape string value for SQL
            def escape_sql_string(value: str) -> str:
                """Escape single quotes in SQL string."""
                return value.replace("'", "''")

            # Helper function to build a single filter condition
            def build_filter_condition(condition_dict: dict) -> str:
                """Build a WHERE condition for a single filter item."""
                condition_parts = []
                for key, value in condition_dict.items():
                    # Check if value is a dict with comparison operators (gt, lt, gte, lte, =, contains)
                    if isinstance(value, dict):
                        # Handle comparison operators: gt, lt, gte, lte, =, contains
                        for op, op_value in value.items():
                            if op in ("gt", "lt", "gte", "lte"):
                                # Map operator to SQL operator
                                sql_op_map = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
                                sql_op = sql_op_map[op]

                                # Check if key starts with "info." prefix (for nested fields like info.A, info.B)
                                if key.startswith("info."):
                                    # Nested field access: properties->'info'->'field_name'
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        escaped_value = escape_sql_string(op_value)
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) {sql_op} '\"{escaped_value}\"'::agtype"
                                        )
                                    else:
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) {sql_op} {op_value}::agtype"
                                        )
                                else:
                                    # Direct property access (e.g., "created_at" is directly in properties, not in properties.info)
                                    if isinstance(op_value, str):
                                        escaped_value = escape_sql_string(op_value)
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) {sql_op} '\"{escaped_value}\"'::agtype"
                                        )
                                    else:
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) {sql_op} {op_value}::agtype"
                                        )
                            elif op == "=":
                                # Handle equality operator
                                # For array fields, = means exact match of the entire array (e.g., tags = ['test:zdy'] or tags = ['mode:fast', 'test:zdy'])
                                # For scalar fields, = means equality
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        escaped_value = escape_sql_string(op_value)
                                        # For array fields, check if array exactly equals [value]
                                        # For scalar fields, use =
                                        if info_field in ("tags", "sources"):
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = '[\"{escaped_value}\"]'::agtype"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = '\"{escaped_value}\"'::agtype"
                                            )
                                    elif isinstance(op_value, list):
                                        # For array fields, format list as JSON array string
                                        if info_field in ("tags", "sources"):
                                            escaped_items = [
                                                escape_sql_string(str(item)) for item in op_value
                                            ]
                                            json_array = json.dumps(escaped_items)
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = '{json_array}'::agtype"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = {op_value}::agtype"
                                            )
                                    else:
                                        if info_field in ("tags", "sources"):
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = '[{op_value}]'::agtype"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = {op_value}::agtype"
                                            )
                                else:
                                    # Direct property access
                                    if isinstance(op_value, str):
                                        escaped_value = escape_sql_string(op_value)
                                        # For array fields, check if array exactly equals [value]
                                        # For scalar fields, use =
                                        if key in ("tags", "sources"):
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '[\"{escaped_value}\"]'::agtype"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{escaped_value}\"'::agtype"
                                            )
                                    elif isinstance(op_value, list):
                                        # For array fields, format list as JSON array string
                                        if key in ("tags", "sources"):
                                            escaped_items = [
                                                escape_sql_string(str(item)) for item in op_value
                                            ]
                                            json_array = json.dumps(escaped_items)
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '{json_array}'::agtype"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {op_value}::agtype"
                                            )
                                    else:
                                        if key in ("tags", "sources"):
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '[{op_value}]'::agtype"
                                            )
                                        else:
                                            condition_parts.append(
                                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {op_value}::agtype"
                                            )
                            elif op == "contains":
                                # Handle contains operator (for string fields only)
                                # Check if agtype contains value (using @> operator)
                                if not isinstance(op_value, str):
                                    raise ValueError(
                                        f"contains operator only supports string format. "
                                        f"Use {{'{key}': {{'contains': '{op_value}'}}}} instead of {{'{key}': {{'contains': {op_value}}}}}"
                                    )
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    # String contains: use @> operator for agtype contains
                                    escaped_value = escape_sql_string(op_value)
                                    condition_parts.append(
                                        f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) @> '\"{escaped_value}\"'::agtype"
                                    )
                                else:
                                    # Direct property access
                                    # String contains: use @> operator for agtype contains
                                    escaped_value = escape_sql_string(op_value)
                                    condition_parts.append(
                                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) @> '\"{escaped_value}\"'::agtype"
                                    )
                            elif op == "like":
                                # Handle like operator (for fuzzy matching, similar to SQL LIKE '%value%')
                                # Check if key starts with "info." prefix
                                if key.startswith("info."):
                                    info_field = key[5:]  # Remove "info." prefix
                                    if isinstance(op_value, str):
                                        # Escape SQL special characters for LIKE: % and _ need to be escaped
                                        escaped_value = (
                                            escape_sql_string(op_value)
                                            .replace("%", "\\%")
                                            .replace("_", "\\_")
                                        )
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype])::text LIKE '%{escaped_value}%'"
                                        )
                                    else:
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype])::text LIKE '%{op_value}%'"
                                        )
                                else:
                                    # Direct property access
                                    if isinstance(op_value, str):
                                        # Escape SQL special characters for LIKE: % and _ need to be escaped
                                        escaped_value = (
                                            escape_sql_string(op_value)
                                            .replace("%", "\\%")
                                            .replace("_", "\\_")
                                        )
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype)::text LIKE '%{escaped_value}%'"
                                        )
                                    else:
                                        condition_parts.append(
                                            f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype)::text LIKE '%{op_value}%'"
                                        )
                    # Check if key starts with "info." prefix (for simple equality)
                    elif key.startswith("info."):
                        # Extract the field name after "info."
                        info_field = key[5:]  # Remove "info." prefix (5 characters)
                        if isinstance(value, str):
                            escaped_value = escape_sql_string(value)
                            condition_parts.append(
                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = '\"{escaped_value}\"'::agtype"
                            )
                        else:
                            condition_parts.append(
                                f"ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '\"info\"'::ag_catalog.agtype, '\"{info_field}\"'::ag_catalog.agtype]) = '\"{value}\"'::agtype"
                            )
                    else:
                        # Direct property access (simple equality)
                        if isinstance(value, str):
                            escaped_value = escape_sql_string(value)
                            condition_parts.append(
                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{escaped_value}\"'::agtype"
                            )
                        else:
                            condition_parts.append(
                                f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {value}::agtype"
                            )
                return " AND ".join(condition_parts)

            # Process filter structure
            if isinstance(filter, dict):
                if "or" in filter:
                    # OR logic: at least one condition must match
                    or_conditions = []
                    for condition in filter["or"]:
                        if isinstance(condition, dict):
                            condition_str = build_filter_condition(condition)
                            if condition_str:
                                or_conditions.append(f"({condition_str})")
                    if or_conditions:
                        filter_conditions.append(f"({' OR '.join(or_conditions)})")

                elif "and" in filter:
                    # AND logic: all conditions must match
                    for condition in filter["and"]:
                        if isinstance(condition, dict):
                            condition_str = build_filter_condition(condition)
                            if condition_str:
                                filter_conditions.append(f"({condition_str})")
                else:
                    # Handle simple dict without "and" or "or" (e.g., {"id": "xxx"})
                    condition_str = build_filter_condition(filter)
                    if condition_str:
                        filter_conditions.append(condition_str)

        return filter_conditions

    def parse_filter(
        self,
        filter_dict: dict | None = None,
    ):
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
        }

        def process_condition(condition):
            if not isinstance(condition, dict):
                return condition

            new_condition = {}

            for key, value in condition.items():
                if key.lower() in ["or", "and"]:
                    if isinstance(value, list):
                        processed_items = []
                        for item in value:
                            if isinstance(item, dict):
                                processed_item = {}
                                for item_key, item_value in item.items():
                                    if item_key not in full_fields and not item_key.startswith(
                                        "info."
                                    ):
                                        new_item_key = f"info.{item_key}"
                                    else:
                                        new_item_key = item_key
                                    processed_item[new_item_key] = item_value
                                processed_items.append(processed_item)
                            else:
                                processed_items.append(item)
                        new_condition[key] = processed_items
                    else:
                        new_condition[key] = value
                else:
                    if key not in full_fields and not key.startswith("info."):
                        new_key = f"info.{key}"
                    else:
                        new_key = key

                    new_condition[new_key] = value

            return new_condition

        return process_condition(filter_dict)

    @timed
    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """
        Delete nodes by memory_ids, file_ids, or filter.

        Args:
            writable_cube_ids (list[str], optional): List of cube IDs (user_name) to filter nodes.
                If not provided, no user_name filter will be applied.
            memory_ids (list[str], optional): List of memory node IDs to delete.
            file_ids (list[str], optional): List of file node IDs to delete.
            filter (dict, optional): Filter dictionary to query matching nodes for deletion.

        Returns:
            int: Number of nodes deleted.
        """
        batch_start_time = time.time()
        logger.info(
            f"[delete_node_by_prams] memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}, writable_cube_ids: {writable_cube_ids}"
        )

        # Build user_name condition from writable_cube_ids (OR relationship - match any cube_id)
        # Only add user_name filter if writable_cube_ids is provided
        user_name_conditions = []
        if writable_cube_ids and len(writable_cube_ids) > 0:
            for cube_id in writable_cube_ids:
                # Use agtype_access_operator with VARIADIC ARRAY format for consistency
                user_name_conditions.append(
                    f"agtype_access_operator(VARIADIC ARRAY[properties, '\"user_name\"'::agtype]) = '\"{cube_id}\"'::agtype"
                )

        # Build WHERE conditions separately for memory_ids and file_ids
        where_conditions = []

        # Handle memory_ids: query properties.id
        if memory_ids and len(memory_ids) > 0:
            memory_id_conditions = []
            for node_id in memory_ids:
                memory_id_conditions.append(
                    f"ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) = '\"{node_id}\"'::agtype"
                )
            if memory_id_conditions:
                where_conditions.append(f"({' OR '.join(memory_id_conditions)})")

        # Check if any file_id is in the file_ids array field (OR relationship)
        if file_ids and len(file_ids) > 0:
            file_id_conditions = []
            for file_id in file_ids:
                # Format: agtype_in_operator(agtype_access_operator(VARIADIC ARRAY[properties, '"file_ids"'::agtype]), '"file_id"'::agtype)
                file_id_conditions.append(
                    f"agtype_in_operator(agtype_access_operator(VARIADIC ARRAY[properties, '\"file_ids\"'::agtype]), '\"{file_id}\"'::agtype)"
                )
            if file_id_conditions:
                # Use OR to match any file_id in the array
                where_conditions.append(f"({' OR '.join(file_id_conditions)})")

        # Query nodes by filter if provided
        filter_ids = set()
        if filter:
            # Parse filter to validate and transform field names (e.g., add "info." prefix if needed)
            parsed_filter = self.parse_filter(filter)
            if parsed_filter:
                # Use get_by_metadata with empty filters list and parsed filter
                filter_ids = set(
                    self.get_by_metadata(
                        filters=[],
                        user_name=None,
                        filter=parsed_filter,
                        knowledgebase_ids=writable_cube_ids,
                    )
                )
            else:
                logger.warning(
                    "[delete_node_by_prams] Filter parsed to None, skipping filter query"
                )

        # If filter returned IDs, add condition for them
        if filter_ids:
            filter_id_conditions = []
            for node_id in filter_ids:
                filter_id_conditions.append(
                    f"ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) = '\"{node_id}\"'::agtype"
                )
            if filter_id_conditions:
                where_conditions.append(f"({' OR '.join(filter_id_conditions)})")

        # If no conditions (except user_name), return 0
        if not where_conditions:
            logger.warning(
                "[delete_node_by_prams] No nodes to delete (no memory_ids, file_ids, or filter provided)"
            )
            return 0

        # Build WHERE clause
        # First, combine memory_ids, file_ids, and filter conditions with OR (any condition can match)
        data_conditions = " OR ".join([f"({cond})" for cond in where_conditions])

        # Build final WHERE clause
        # If user_name_conditions exist, combine with data_conditions using AND
        # Otherwise, use only data_conditions
        if user_name_conditions:
            user_name_where = " OR ".join(user_name_conditions)
            where_clause = f"({user_name_where}) AND ({data_conditions})"
        else:
            where_clause = f"({data_conditions})"

        # Use SQL DELETE query for better performance
        # First count matching nodes to get accurate count
        count_query = f"""
                SELECT COUNT(*)
                FROM "{self.db_name}_graph"."Memory"
                WHERE {where_clause}
            """
        logger.info(f"[delete_node_by_prams] count_query: {count_query}")

        # Then delete nodes
        delete_query = f"""
                DELETE FROM "{self.db_name}_graph"."Memory"
                WHERE {where_clause}
            """

        logger.info(
            f"[delete_node_by_prams] Deleting nodes - memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}"
        )
        logger.info(f"[delete_node_by_prams] delete_query: {delete_query}")

        conn = None
        deleted_count = 0
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Count nodes before deletion
                cursor.execute(count_query)
                count_result = cursor.fetchone()
                expected_count = count_result[0] if count_result else 0

                logger.info(
                    f"[delete_node_by_prams] Found {expected_count} nodes matching the criteria"
                )

                # Delete nodes
                cursor.execute(delete_query)
                # Use rowcount to get actual deleted count
                deleted_count = cursor.rowcount
                elapsed_time = time.time() - batch_start_time
                logger.info(
                    f"[delete_node_by_prams] Deletion completed successfully in {elapsed_time:.2f}s, deleted {deleted_count} nodes"
                )
        except Exception as e:
            logger.error(f"[delete_node_by_prams] Failed to delete nodes: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

        logger.info(f"[delete_node_by_prams] Successfully deleted {deleted_count} nodes")
        return deleted_count

    @timed
    def get_user_names_by_memory_ids(self, memory_ids: list[str]) -> dict[str, list[str]]:
        """Get user names by memory ids.

        Args:
            memory_ids: List of memory node IDs to query.

        Returns:
            dict[str, list[str]]: Dictionary with one key:
                - 'no_exist_memory_ids': List of memory_ids that do not exist (if any are missing)
                - 'exist_user_names': List of distinct user names (if all memory_ids exist)
        """
        if not memory_ids:
            return {"exist_user_names": []}

        # Build OR conditions for each memory_id
        id_conditions = []
        for mid in memory_ids:
            id_conditions.append(
                f"ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) = '\"{mid}\"'::agtype"
            )

        where_clause = f"({' OR '.join(id_conditions)})"

        # Query to check which memory_ids exist
        check_query = f"""
            SELECT ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype)::text
            FROM "{self.db_name}_graph"."Memory"
            WHERE {where_clause}
        """

        logger.info(f"[get_user_names_by_memory_ids] check_query: {check_query}")
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Check which memory_ids exist
                cursor.execute(check_query)
                check_results = cursor.fetchall()
                existing_ids = set()
                for row in check_results:
                    node_id = row[0]
                    # Remove quotes if present
                    if isinstance(node_id, str):
                        node_id = node_id.strip('"').strip("'")
                    existing_ids.add(node_id)

                # Check if any memory_ids are missing
                no_exist_list = [mid for mid in memory_ids if mid not in existing_ids]

                # If any memory_ids are missing, return no_exist_memory_ids
                if no_exist_list:
                    logger.info(
                        f"[get_user_names_by_memory_ids] Found {len(no_exist_list)} non-existing memory_ids: {no_exist_list}"
                    )
                    return {"no_exist_memory_ids": no_exist_list}

                # All memory_ids exist, query user_names
                user_names_query = f"""
                    SELECT DISTINCT ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype)::text
                    FROM "{self.db_name}_graph"."Memory"
                    WHERE {where_clause}
                """
                logger.info(f"[get_user_names_by_memory_ids] user_names_query: {user_names_query}")

                cursor.execute(user_names_query)
                results = cursor.fetchall()
                user_names = []
                for row in results:
                    user_name = row[0]
                    # Remove quotes if present
                    if isinstance(user_name, str):
                        user_name = user_name.strip('"').strip("'")
                    user_names.append(user_name)

                logger.info(
                    f"[get_user_names_by_memory_ids] All memory_ids exist, found {len(user_names)} distinct user_names"
                )

                return {"exist_user_names": user_names}
        except Exception as e:
            logger.error(
                f"[get_user_names_by_memory_ids] Failed to get user names: {e}", exc_info=True
            )
            raise
        finally:
            self._return_connection(conn)
