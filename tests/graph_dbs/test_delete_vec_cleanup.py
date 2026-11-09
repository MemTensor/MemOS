"""
Regression tests for #2331: delete_node_by_prams must also purge vectors from vec_db.

When a memory is deleted via Neo4jCommunityGraphDB.delete_node_by_prams the
corresponding embedding vector must be removed from vec_db so that subsequent
searches no longer surface the deleted node.
"""

from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig


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
        """Wire a session that returns `ids_to_delete` from the pre-delete ID query.

        The fixed implementation makes exactly 2 session.run calls:
          1) id_collect_query  — MATCH ... RETURN n.id AS id
          2) delete_query      — MATCH ... DETACH DELETE n
        """
        session_ctx = MagicMock()
        session_ctx.__enter__ = MagicMock(return_value=session_ctx)
        session_ctx.__exit__ = MagicMock(return_value=False)

        # First run: id_collect_query — yields records with record["id"] == the node id
        id_records = []
        for nid in ids_to_delete:
            record = MagicMock()
            # capture nid via default argument to avoid late-binding closure
            record.__getitem__ = MagicMock(
                side_effect=lambda k, _id=nid: _id if k == "id" else None
            )
            id_records.append(record)
        id_result = MagicMock()
        id_result.__iter__ = MagicMock(return_value=iter(id_records))

        # Second run: delete_query — return value is not inspected
        delete_result = MagicMock()

        session_ctx.run.side_effect = [id_result, delete_result]
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

    def test_vec_db_delete_failure_does_not_raise(self, community_config):
        """A vec_db failure during cleanup must log a warning, not crash the request."""
        db = _make_db(community_config)
        ids = ["eee-555"]
        self._make_session_mock(db, ids)
        db.vec_db.delete.side_effect = RuntimeError("qdrant unavailable")

        # Should not raise — graph deletion already succeeded
        result = db.delete_node_by_prams(memory_ids=ids)
        assert result >= 0
