"""
Regression tests for issue #955: search methods support specifying return fields.

Tests that search_by_embedding (and other search methods) accept a `return_fields`
parameter and include the requested fields in the result dicts, eliminating the
need for N+1 get_node() calls.
"""

import uuid

from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig


@pytest.fixture
def neo4j_config():
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_memory_db",
        auto_create=False,
        embedding_dimension=3,
    )


@pytest.fixture
def neo4j_db(neo4j_config):
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(neo4j_config)
        db.driver = mock_driver
        yield db


class TestNeo4jSearchReturnFields:
    """Tests for Neo4jGraphDB.search_by_embedding with return_fields."""

    def test_return_fields_included_in_results(self, neo4j_db):
        """return_fields values are present in each result dict."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        node_id = str(uuid.uuid4())
        session_mock.run.return_value = [
            {"id": node_id, "score": 0.95, "memory": "hello", "status": "activated"},
        ]

        results = neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
            return_fields=["memory", "status"],
        )

        assert len(results) == 1
        assert results[0]["id"] == node_id
        assert results[0]["score"] == 0.95
        assert results[0]["memory"] == "hello"
        assert results[0]["status"] == "activated"

    def test_backward_compatible_without_return_fields(self, neo4j_db):
        """Without return_fields, only id and score are returned (old behavior)."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = [
            {"id": str(uuid.uuid4()), "score": 0.9},
        ]

        results = neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
        )

        assert len(results) == 1
        assert set(results[0].keys()) == {"id", "score"}

    def test_cypher_return_clause_includes_fields(self, neo4j_db):
        """Cypher RETURN clause contains the requested fields."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
            return_fields=["memory", "tags"],
        )

        query = session_mock.run.call_args[0][0]
        assert "node.memory AS memory" in query
        assert "node.tags AS tags" in query

    def test_cypher_return_clause_default(self, neo4j_db):
        """Without return_fields, RETURN clause only has id and score."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
        )

        query = session_mock.run.call_args[0][0]
        assert "RETURN node.id AS id, score" in query
        assert "node.memory" not in query

    def test_return_fields_skips_id_field(self, neo4j_db):
        """Passing 'id' in return_fields does not duplicate it in RETURN clause."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
            return_fields=["id", "memory"],
        )

        query = session_mock.run.call_args[0][0]
        # 'id' should appear only once (as node.id AS id), not duplicated
        assert query.count("node.id AS id") == 1
        assert "node.memory AS memory" in query

    def test_threshold_filtering_still_works_with_return_fields(self, neo4j_db):
        """Threshold filtering works correctly when return_fields is specified."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = [
            {"id": str(uuid.uuid4()), "score": 0.9, "memory": "high score"},
            {"id": str(uuid.uuid4()), "score": 0.3, "memory": "low score"},
        ]

        results = neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
            threshold=0.5,
            return_fields=["memory"],
        )

        assert len(results) == 1
        assert results[0]["memory"] == "high score"


class TestPolarDBExtractFieldsFromProperties:
    """Tests for PolarDBGraphDB._extract_fields_from_properties helper."""

    @pytest.fixture
    def polardb_instance(self):
        """Create a minimal PolarDB instance for testing the helper method."""
        with patch("memos.graph_dbs.polardb.PolarDBGraphDB.__init__", return_value=None):
            from memos.graph_dbs.polardb import PolarDBGraphDB

            db = PolarDBGraphDB.__new__(PolarDBGraphDB)
            yield db

    def test_extract_from_json_string(self, polardb_instance):
        """Extract fields from a JSON string properties value."""
        props = '{"id": "abc", "memory": "hello", "status": "activated", "tags": ["a"]}'
        result = polardb_instance._extract_fields_from_properties(
            props, ["memory", "status", "tags"]
        )
        assert result == {"memory": "hello", "status": "activated", "tags": ["a"]}

    def test_extract_from_dict(self, polardb_instance):
        """Extract fields from a dict properties value."""
        props = {"id": "abc", "memory": "hello", "status": "activated"}
        result = polardb_instance._extract_fields_from_properties(props, ["memory", "status"])
        assert result == {"memory": "hello", "status": "activated"}

    def test_extract_skips_id(self, polardb_instance):
        """'id' field is skipped even if requested."""
        props = '{"id": "abc", "memory": "hello"}'
        result = polardb_instance._extract_fields_from_properties(props, ["id", "memory"])
        assert result == {"memory": "hello"}

    def test_extract_missing_fields(self, polardb_instance):
        """Missing fields are silently skipped."""
        props = '{"id": "abc", "memory": "hello"}'
        result = polardb_instance._extract_fields_from_properties(props, ["memory", "nonexistent"])
        assert result == {"memory": "hello"}

    def test_extract_empty_properties(self, polardb_instance):
        """Empty/None properties return empty dict."""
        assert polardb_instance._extract_fields_from_properties(None, ["memory"]) == {}
        assert polardb_instance._extract_fields_from_properties("", ["memory"]) == {}

    def test_extract_invalid_json(self, polardb_instance):
        """Invalid JSON returns empty dict without raising."""
        result = polardb_instance._extract_fields_from_properties("not-json", ["memory"])
        assert result == {}


class TestFieldNameValidation:
    """Tests for _validate_return_fields injection prevention."""

    def test_valid_field_names_pass(self):
        from memos.graph_dbs.base import BaseGraphDB

        result = BaseGraphDB._validate_return_fields(["memory", "status", "tags", "user_name"])
        assert result == ["memory", "status", "tags", "user_name"]

    def test_invalid_field_names_rejected(self):
        from memos.graph_dbs.base import BaseGraphDB

        # Cypher injection attempts
        result = BaseGraphDB._validate_return_fields(
            [
                "memory} RETURN n //",
                "status; DROP",
                "valid_field",
                "a.b",
                "field name",
                "",
            ]
        )
        assert result == ["valid_field"]

    def test_none_returns_empty(self):
        from memos.graph_dbs.base import BaseGraphDB

        assert BaseGraphDB._validate_return_fields(None) == []

    def test_empty_list_returns_empty(self):
        from memos.graph_dbs.base import BaseGraphDB

        assert BaseGraphDB._validate_return_fields([]) == []

    def test_injection_in_cypher_query_prevented(self, neo4j_db):
        """Malicious field names should not appear in the Cypher query."""
        session_mock = neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            user_name="test_user",
            return_fields=["memory} RETURN n //", "valid_field"],
        )

        query = session_mock.run.call_args[0][0]
        # Injection attempt should NOT appear in query
        assert "memory}" not in query
        assert "RETURN n //" not in query
        # Valid field should appear
        assert "node.valid_field AS valid_field" in query


class TestNeo4jCommunitySearchReturnFields:
    """Tests for Neo4jCommunityGraphDB._fetch_return_fields with return_fields."""

    @pytest.fixture
    def neo4j_community_db(self):
        """Create a minimal Neo4jCommunityGraphDB instance by patching __init__."""
        with patch(
            "memos.graph_dbs.neo4j_community.Neo4jCommunityGraphDB.__init__", return_value=None
        ):
            from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB

            db = Neo4jCommunityGraphDB.__new__(Neo4jCommunityGraphDB)
            db.driver = MagicMock()
            db.db_name = "test_memory_db"
            yield db

    def test_fetch_return_fields_queries_neo4j(self, neo4j_community_db):
        """_fetch_return_fields builds correct Cypher and returns fields."""
        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = [
            {"id": "node-1", "memory": "hello", "status": "activated"},
        ]

        results = neo4j_community_db._fetch_return_fields(
            ids=["node-1"],
            score_map={"node-1": 0.95},
            return_fields=["memory", "status"],
        )

        assert len(results) == 1
        assert results[0]["id"] == "node-1"
        assert results[0]["score"] == 0.95
        assert results[0]["memory"] == "hello"
        assert results[0]["status"] == "activated"

        query = session_mock.run.call_args[0][0]
        assert "n.memory AS memory" in query
        assert "n.status AS status" in query

    def test_fetch_return_fields_validates_names(self, neo4j_community_db):
        """_fetch_return_fields rejects invalid field names."""
        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        neo4j_community_db._fetch_return_fields(
            ids=["node-1"],
            score_map={"node-1": 0.95},
            return_fields=["memory} RETURN n //", "valid_field"],
        )

        query = session_mock.run.call_args[0][0]
        assert "memory}" not in query
        assert "n.valid_field AS valid_field" in query
