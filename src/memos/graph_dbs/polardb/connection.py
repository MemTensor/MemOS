import time

from contextlib import suppress

from memos.configs.graph_db import PolarDBGraphDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger


logger = get_logger(__name__)


class ConnectionMixin:
    """Mixin class providing PolarDB connection pool management."""

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

    def __del__(self):
        """Close database connection when object is destroyed."""
        if hasattr(self, "connection") and self.connection:
            self.connection.close()
