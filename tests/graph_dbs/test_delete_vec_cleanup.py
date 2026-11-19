"""
Regression tests for #2331: delete_node_by_prams must also purge vectors from vec_db.

When a memory is deleted via Neo4jCommunityGraphDB.delete_node_by_prams the
corresponding embedding vector must be removed from vec_db so that subsequent
searches no longer surface the deleted node.
"""

from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.exceptions import VectorDBError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_db(config: Neo4jGraphDBConfig) -> "Neo4jCommunityGraphDB":  # noqa: F821
    """Build a Neo4jCommunityGraphDB with all heavy dependencies mocked out.

    Uses __new__ to skip __init__ entirely so no real Neo4j driver or Qdrant
    connection is attempted.
    """
    from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB

    db = Neo4jCommunityGraphDB.__new__(Neo4jCommunityGraphDB)
    db.config = config
    db.driver = MagicMock()
    db.db_name = config.db_name
    db.vec_db = MagicMock()
    db._schema_ready = True
    return db


@pytest.fixture
def community_config():
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_db",
        auto_create=False,
        use_multi_db=False,
        user_name="alice",
        embedding_dimension=3,
    )


# ---------------------------------------------------------------------------
# Tests - vec_db cleanup is called for every delete mode
# ---------------------------------------------------------------------------


class TestDeleteNodeByPramsVecCleanup:
    """delete_node_by_prams must remove vectors from vec_db after graph deletion."""

    def _make_session_mock(self, db: "Neo4jCommunityGraphDB", ids_to_delete: list[str]):  # noqa: F821
        """Wire deletion records returned from an explicit graph transaction."""
        session_ctx = MagicMock()
        session_ctx.__enter__ = MagicMock(return_value=session_ctx)
        session_ctx.__exit__ = MagicMock(return_value=False)

        transaction = session_ctx.begin_transaction.return_value.__enter__.return_value
        transaction.run.return_value = [{"id": nid} for nid in ids_to_delete]
        db.driver.session.return_value = session_ctx
        return session_ctx

    def test_delete_by_memory_ids_cleans_vec_db(self, community_config):
        """Deleting by memory_ids must call vec_db.delete with those IDs."""
        db = _make_db(community_config)
        ids = ["aaa-111", "bbb-222"]
        self._make_session_mock(db, ids)

        db.delete_node_by_prams(memory_ids=ids)

        db.vec_db.delete.assert_called_once_with(ids)

    def test_delete_by_filter_cleans_vec_db(self, community_config):
        """Deleting by filter must call vec_db.delete with all matched IDs."""
        db = _make_db(community_config)
        matched_ids = ["ccc-333", "ddd-444"]

        # get_by_metadata is called internally for filter path
        db.get_by_metadata = MagicMock(return_value=matched_ids)
        self._make_session_mock(db, matched_ids)

        db.delete_node_by_prams(filter={"user_id": "alice"})

        db.get_by_metadata.assert_called_once()
        db.vec_db.delete.assert_called_once_with(matched_ids)

    def test_delete_by_memory_ids_empty_list_no_vec_call(self, community_config):
        """Empty memory_ids must not call vec_db.delete (early-return path)."""
        db = _make_db(community_config)

        result = db.delete_node_by_prams(memory_ids=[])

        db.vec_db.delete.assert_not_called()
        assert result == 0

    def test_delete_no_args_no_vec_call(self, community_config):
        """No delete args must return 0 and not touch vec_db."""
        db = _make_db(community_config)

        result = db.delete_node_by_prams()

        db.vec_db.delete.assert_not_called()
        assert result == 0

    def test_vec_db_delete_failure_propagates_without_graph_commit(self, community_config):
        db = _make_db(community_config)
        session = self._make_session_mock(db, ["eee-555"])
        transaction = session.begin_transaction.return_value.__enter__.return_value
        db.vec_db.delete.side_effect = OSError("Synthetic vector outage")

        with pytest.raises(VectorDBError):
            db.delete_node_by_prams(memory_ids=["eee-555"])

        transaction.commit.assert_not_called()

    def test_deletion_uses_one_graph_statement_and_purges_before_commit(self, community_config):
        db = _make_db(community_config)
        session = self._make_session_mock(db, ["aaa-111"])
        transaction = session.begin_transaction.return_value.__enter__.return_value
        order = []
        db.vec_db.delete.side_effect = lambda ids: order.append(("vectors", ids))
        transaction.commit.side_effect = lambda: order.append(("commit", None))

        result = db.delete_node_by_prams(writable_cube_ids=["alice"], memory_ids=["aaa-111"])

        assert result == 1
        session.run.assert_not_called()
        transaction.run.assert_called_once()
        query = transaction.run.call_args.args[0]
        assert "DETACH DELETE n" in query
        assert "RETURN id" in query
        assert transaction.run.call_args.kwargs["cube_id_0"] == "alice"
        assert order == [("vectors", ["aaa-111"]), ("commit", None)]

    def test_graph_statement_failure_does_not_remove_vectors(self, community_config):
        db = _make_db(community_config)
        session = self._make_session_mock(db, ["aaa-111"])
        transaction = session.begin_transaction.return_value.__enter__.return_value
        transaction.run.side_effect = OSError("Synthetic graph outage")

        with pytest.raises(OSError):
            db.delete_node_by_prams(memory_ids=["aaa-111"])

        db.vec_db.delete.assert_not_called()
        transaction.commit.assert_not_called()

    def test_no_matching_nodes_does_not_remove_vectors(self, community_config):
        db = _make_db(community_config)
        self._make_session_mock(db, [])

        assert db.delete_node_by_prams(memory_ids=["absent"]) == 0
        db.vec_db.delete.assert_not_called()

    def test_file_deletion_requires_cube_scope(self, community_config):
        db = _make_db(community_config)

        with pytest.raises(ValueError, match="writable_cube_ids"):
            db.delete_node_by_prams(file_ids=["file-1"])

        db.driver.session.assert_not_called()
        db.vec_db.delete.assert_not_called()
