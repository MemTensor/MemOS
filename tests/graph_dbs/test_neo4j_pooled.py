"""Tests for Neo4j connection pooling functionality."""

from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import GraphDBConfigFactory
from memos.graph_dbs.connection_pool import Neo4jConnectionPool, connection_pool
from memos.graph_dbs.factory import GraphStoreFactory
from memos.graph_dbs.neo4j_pooled import Neo4jPooledGraphDB


class TestNeo4jConnectionPool:
    """Test the connection pool implementation."""

    def test_singleton_pattern(self):
        """Test that connection pool follows singleton pattern."""
        pool1 = Neo4jConnectionPool()
        pool2 = Neo4jConnectionPool()
        assert pool1 is pool2

    @patch("memos.graph_dbs.connection_pool.GraphDatabase")
    def test_connection_reuse(self, mock_graph_db):
        """Test that connections are reused for same URI/user."""
        mock_driver = MagicMock()
        mock_graph_db.driver.return_value = mock_driver

        pool = Neo4jConnectionPool()
        pool._drivers.clear()  # Clear any existing connections

        # First call should create driver
        driver1 = pool.get_driver("bolt://localhost:7687", "neo4j", "password")
        assert mock_graph_db.driver.call_count == 1
        assert driver1 == mock_driver

        # Second call with same params should reuse
        driver2 = pool.get_driver("bolt://localhost:7687", "neo4j", "password")
        assert mock_graph_db.driver.call_count == 1  # No additional calls
        assert driver2 == mock_driver

    @patch("memos.graph_dbs.connection_pool.GraphDatabase")
    def test_different_connections(self, mock_graph_db):
        """Test that different URI/user combinations create separate drivers."""
        mock_driver1 = MagicMock()
        mock_driver2 = MagicMock()
        mock_graph_db.driver.side_effect = [mock_driver1, mock_driver2]

        pool = Neo4jConnectionPool()
        pool._drivers.clear()

        driver1 = pool.get_driver("bolt://localhost:7687", "user1", "pass1")
        driver2 = pool.get_driver("bolt://localhost:7687", "user2", "pass2")

        assert mock_graph_db.driver.call_count == 2
        assert driver1 != driver2


class TestNeo4jPooledGraphDB:
    """Test the pooled Neo4j GraphDB implementation."""

    @patch("memos.graph_dbs.neo4j_pooled.connection_pool")
    def test_uses_connection_pool(self, mock_pool):
        """Test that Neo4jPooledGraphDB uses connection pool."""
        mock_driver = MagicMock()
        mock_pool.get_driver.return_value = mock_driver
        mock_pool.get_active_connections.return_value = 1

        config = GraphDBConfigFactory(
            backend="neo4j",
            config={
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "password",
                "db_name": "test_db",
                "auto_create": False,
                "embedding_dimension": 768,
            },
        )

        with (
            patch.object(Neo4jPooledGraphDB, "_ensure_database_exists"),
            patch.object(Neo4jPooledGraphDB, "create_index"),
        ):
            db = Neo4jPooledGraphDB(config.config)

            # Verify connection pool was used
            mock_pool.get_driver.assert_called_once_with(
                "bolt://localhost:7687", "neo4j", "password"
            )
            assert db.driver == mock_driver


class TestGraphStoreFactory:
    """Test factory integration with pooled backend."""

    def test_factory_supports_pooled_backend(self):
        """Test that factory can create pooled Neo4j instances."""
        config = GraphDBConfigFactory(
            backend="neo4j-pooled",
            config={
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "password",
                "db_name": "test_db",
                "auto_create": False,
                "embedding_dimension": 768,
            },
        )

        with patch.object(Neo4jPooledGraphDB, "__init__", return_value=None):
            instance = GraphStoreFactory.from_config(config)
            assert isinstance(instance, Neo4jPooledGraphDB)


@pytest.fixture
def clean_connection_pool():
    """Fixture to ensure clean connection pool for tests."""
    # Clear existing connections
    if hasattr(connection_pool, "_drivers"):
        connection_pool._drivers.clear()
    yield connection_pool
    # Clean up after test
    if hasattr(connection_pool, "_drivers"):
        connection_pool._drivers.clear()


def test_integration_multiple_instances(clean_connection_pool):
    """Integration test: multiple instances should share connections."""

    config1 = GraphDBConfigFactory(
        backend="neo4j-pooled",
        config={
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "password",
            "db_name": "db1",
            "user_name": "user1",
            "auto_create": False,
            "embedding_dimension": 768,
        },
    )

    config2 = GraphDBConfigFactory(
        backend="neo4j-pooled",
        config={
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "password",
            "db_name": "db2",
            "user_name": "user2",
            "auto_create": False,
            "embedding_dimension": 768,
        },
    )

    with (
        patch("memos.graph_dbs.connection_pool.GraphDatabase") as mock_gdb,
        patch.object(Neo4jPooledGraphDB, "_ensure_database_exists"),
        patch.object(Neo4jPooledGraphDB, "create_index"),
    ):
        mock_driver = MagicMock()
        mock_gdb.driver.return_value = mock_driver

        # Create two instances
        db1 = GraphStoreFactory.from_config(config1)
        db2 = GraphStoreFactory.from_config(config2)

        # Should only create one driver (same URI/user)
        assert mock_gdb.driver.call_count == 1
        assert db1.driver == db2.driver == mock_driver
        assert clean_connection_pool.get_active_connections() == 1
