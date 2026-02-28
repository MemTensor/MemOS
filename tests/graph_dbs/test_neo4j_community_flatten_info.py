"""
Regression tests for issue #1122:
Neo4jCommunityGraphDB.add_node() must flatten nested 'info' dict in metadata
to avoid Neo4j CypherTypeError on Map-type property values.
"""

import uuid
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig


@pytest.fixture
def neo4j_community_config():
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="neo4j",
        auto_create=False,
        use_multi_db=False,
        user_name="test-user",
        embedding_dimension=3,
    )


@pytest.fixture
def neo4j_community_db(neo4j_community_config):
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver

        from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB

        db = object.__new__(Neo4jCommunityGraphDB)
        db.config = neo4j_community_config
        db.driver = mock_driver
        db.db_name = neo4j_community_config.db_name
        db.vec_db = MagicMock()
        yield db


class TestNeo4jCommunityFlattenInfo:
    """Regression: add_node must flatten nested info dict before passing to Neo4j."""

    def test_add_node_flattens_info_field(self, neo4j_community_db):
        """Nested 'info' dict should be flattened to top-level keys in metadata."""
        node_id = str(uuid.uuid4())
        memory = "User prefers Python for AI development"
        now = datetime.utcnow().isoformat()
        metadata = {
            "embedding": [0.1, 0.2, 0.3],
            "created_at": now,
            "updated_at": now,
            "sources": [],
            "info": {
                "preference": "python",
            },
        }

        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value

        neo4j_community_db.add_node(
            id=node_id, memory=memory, metadata=metadata, user_name="test-user"
        )

        call_args = session_mock.run.call_args
        passed_metadata = call_args.kwargs.get("metadata", call_args[1].get("metadata", {}))

        assert "info" not in passed_metadata, (
            f"'info' field was not flattened: metadata={passed_metadata}"
        )
        assert passed_metadata.get("preference") == "python"

    def test_add_node_without_info_field_still_works(self, neo4j_community_db):
        """add_node should work normally when metadata has no 'info' field."""
        node_id = str(uuid.uuid4())
        memory = "Simple memory"
        now = datetime.utcnow().isoformat()
        metadata = {
            "embedding": [0.1, 0.2, 0.3],
            "created_at": now,
            "updated_at": now,
            "sources": [],
        }

        session_mock = neo4j_community_db.driver.session.return_value.__enter__.return_value

        neo4j_community_db.add_node(
            id=node_id, memory=memory, metadata=metadata, user_name="test-user"
        )

        assert session_mock.run.called
