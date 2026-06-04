"""
Regression test for issue #1469: Neo4j Community update_node should sync to Qdrant.

When Neo4jCommunityGraphDB.update_node() is called, it should update both Neo4j
and the external Qdrant vector database to maintain data consistency.
"""

import uuid

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.configs.vec_db import QdrantConfig


@pytest.fixture
def qdrant_config():
    return QdrantConfig(
        url="http://localhost:6333",
        collection_name="test_collection",
        embedding_dimension=1536,
    )


@pytest.fixture
def neo4j_community_config(qdrant_config):
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_memory_db",
        auto_create=False,
        use_multi_db=False,
        vec_config=qdrant_config,
    )


@pytest.fixture
def neo4j_community_db(neo4j_community_config):
    """Create a mocked Neo4jCommunityGraphDB instance."""
    with patch("neo4j.GraphDatabase") as mock_gd, patch(
        "memos.vec_dbs.factory.VecDBFactory.from_config"
    ) as mock_vec_factory:
        # Mock Neo4j driver
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver

        # Mock Qdrant vec_db
        mock_vec_db = MagicMock()
        mock_vec_factory.return_value = mock_vec_db

        from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB

        db = Neo4jCommunityGraphDB(neo4j_community_config)
        db.driver = mock_driver
        db.vec_db = mock_vec_db

        yield db


class TestNeo4jCommunityUpdateNode:
    """Tests for Neo4jCommunityGraphDB.update_node with Qdrant synchronization."""

    def test_update_node_syncs_to_qdrant_when_embedding_present(self, neo4j_community_db):
        """update_node should update both Neo4j and Qdrant when embedding is in fields."""
        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = MagicMock()

        node_id = str(uuid.uuid4())
        new_embedding = [0.1] * 1536
        update_fields = {
            "memory": "updated memory content",
            "embedding": new_embedding,
            "tags": ["updated"],
            "updated_at": datetime.utcnow().isoformat(),
        }

        neo4j_community_db.update_node(node_id, update_fields)

        # Verify Neo4j was updated
        assert session_mock.run.called
        neo4j_query = session_mock.run.call_args[0][0]
        assert "MATCH (n:Memory {id: $id})" in neo4j_query
        assert "SET" in neo4j_query

        # Verify Qdrant was updated
        neo4j_community_db.vec_db.update.assert_called_once()
        vec_update_call = neo4j_community_db.vec_db.update.call_args
        updated_items = vec_update_call[0][0]  # First positional argument
        assert len(updated_items) == 1
        assert updated_items[0].id == node_id
        assert updated_items[0].vector == new_embedding
        assert updated_items[0].payload["memory"] == "updated memory content"

    def test_update_node_skips_qdrant_when_no_embedding(self, neo4j_community_db):
        """update_node should only update Neo4j when no embedding is provided."""
        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = MagicMock()

        node_id = str(uuid.uuid4())
        update_fields = {
            "tags": ["updated"],
            "status": "archived",
            "updated_at": datetime.utcnow().isoformat(),
        }

        neo4j_community_db.update_node(node_id, update_fields)

        # Verify Neo4j was updated
        assert session_mock.run.called

        # Verify Qdrant was NOT called
        neo4j_community_db.vec_db.update.assert_not_called()

    def test_update_node_handles_qdrant_failure_gracefully(self, neo4j_community_db):
        """update_node should log error and continue if Qdrant update fails."""
        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = MagicMock()

        # Make Qdrant update fail
        neo4j_community_db.vec_db.update.side_effect = Exception("Qdrant connection error")

        node_id = str(uuid.uuid4())
        update_fields = {
            "embedding": [0.1] * 1536,
            "memory": "updated memory",
            "updated_at": datetime.utcnow().isoformat(),
        }

        # Should not raise exception
        neo4j_community_db.update_node(node_id, update_fields)

        # Verify Neo4j update still happened
        assert session_mock.run.called

    def test_update_node_preserves_payload_fields(self, neo4j_community_db):
        """update_node should include all non-embedding fields in Qdrant payload."""
        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = MagicMock()

        node_id = str(uuid.uuid4())
        update_fields = {
            "memory": "updated content",
            "embedding": [0.1] * 1536,
            "tags": ["tag1", "tag2"],
            "status": "activated",
            "custom_field": "custom_value",
            "updated_at": datetime.utcnow().isoformat(),
        }

        neo4j_community_db.update_node(node_id, update_fields)

        # Verify Qdrant payload contains all fields except embedding
        vec_update_call = neo4j_community_db.vec_db.update.call_args
        updated_items = vec_update_call[0][0]
        payload = updated_items[0].payload

        assert payload["memory"] == "updated content"
        assert payload["tags"] == ["tag1", "tag2"]
        assert payload["status"] == "activated"
        assert payload["custom_field"] == "custom_value"
        assert "embedding" not in payload  # embedding should not be in payload
