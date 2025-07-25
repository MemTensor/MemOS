"""Connection pool manager for graph databases."""

import threading

from typing import Any

from memos.log import get_logger


logger = get_logger(__name__)


class Neo4jConnectionPool:
    """Singleton connection pool for Neo4j databases."""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if not getattr(self, "_initialized", False):
            self._drivers: dict[str, Any] = {}
            self._driver_lock = threading.Lock()
            self._initialized = True

    def get_driver(self, uri: str, user: str, password: str):
        """Get or create a driver for the given connection parameters."""
        connection_key = f"{uri}:{user}"

        if connection_key not in self._drivers:
            with self._driver_lock:
                if connection_key not in self._drivers:
                    from neo4j import GraphDatabase

                    driver = GraphDatabase.driver(uri, auth=(user, password))
                    self._drivers[connection_key] = driver
                    logger.info(f"Created new Neo4j driver for {connection_key}")
                else:
                    logger.debug(f"Using existing Neo4j driver for {connection_key}")
        else:
            logger.debug(f"Reusing existing Neo4j driver for {connection_key}")

        return self._drivers[connection_key]

    def close_all(self):
        """Close all connections in the pool."""
        with self._driver_lock:
            for connection_key, driver in self._drivers.items():
                try:
                    driver.close()
                    logger.info(f"Closed Neo4j driver for {connection_key}")
                except Exception as e:
                    logger.error(f"Error closing driver for {connection_key}: {e}")
            self._drivers.clear()

    def close_driver(self, uri: str, user: str):
        """Close a specific driver."""
        connection_key = f"{uri}:{user}"
        with self._driver_lock:
            if connection_key in self._drivers:
                try:
                    self._drivers[connection_key].close()
                    del self._drivers[connection_key]
                    logger.info(f"Closed and removed Neo4j driver for {connection_key}")
                except Exception as e:
                    logger.error(f"Error closing driver for {connection_key}: {e}")

    def get_active_connections(self) -> int:
        """Get the number of active connections."""
        return len(self._drivers)


# Global connection pool instance
connection_pool = Neo4jConnectionPool()
