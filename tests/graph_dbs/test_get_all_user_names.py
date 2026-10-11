"""Offline tests for Neo4jGraphDB.get_all_user_names (issue #2480).

The structure reorganizer needs to enumerate every tenant (user_name) present
in the graph so optimization covers all tenants instead of only the configured
default one. These tests stub the Neo4j driver; no server is required.
"""

from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig


@pytest.fixture
def neo4j_db():
    config = Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_memory_db",
        auto_create=False,
        embedding_dimension=3,
        user_name="memosdefault",
    )
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(config)
        db.driver = mock_driver
        yield db


class TestNeo4jGetAllUserNames:
    def test_returns_distinct_user_names(self, neo4j_db):
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = [
            {"user_name": "alice"},
            {"user_name": "bob"},
            {"user_name": "memosdefault"},
        ]

        assert neo4j_db.get_all_user_names() == ["alice", "bob", "memosdefault"]

    def test_ignores_null_and_blank_user_names(self, neo4j_db):
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = [
            {"user_name": "alice"},
            {"user_name": None},
            {"user_name": ""},
        ]

        assert neo4j_db.get_all_user_names() == ["alice"]

    def test_empty_graph_falls_back_to_configured_user_name(self, neo4j_db):
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        assert neo4j_db.get_all_user_names() == ["memosdefault"]

    def test_query_failure_falls_back_to_configured_user_name(self, neo4j_db):
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.side_effect = RuntimeError("driver closed")

        assert neo4j_db.get_all_user_names() == ["memosdefault"]
