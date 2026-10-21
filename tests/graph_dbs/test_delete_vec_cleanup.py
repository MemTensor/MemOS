"""
Regression test for issue #2331: deleting memories must also purge their vectors.

`Neo4jCommunityGraphDB.delete_node_by_prams` removed the Neo4j nodes but never
removed the matching embeddings from `vec_db`, so a deleted memory stayed
retrievable through vector search while the delete API still answered "success".
`clear()` and `delete_node_by_mem_cube_id()` already purged `vec_db`;
`delete_node_by_prams` simply omitted that step.

The Neo4j driver and the vector store are both faked, so these tests need no
Neo4j, no Qdrant, and no network.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jCommunityGraphDBConfig, Neo4jGraphDBConfig


class _FakeNeo4jSession:
    """Minimal stand-in for a neo4j session that tracks a set of live node ids."""

    def __init__(self, live_ids: set[str], issued_queries: list[str]):
        self.live_ids = live_ids
        self.issued_queries = issued_queries

    def run(self, query, params=None, **kwargs):
        self.issued_queries.append(query)
        params = params or kwargs
        ids = params.get("memory_ids") or params.get("filter_ids")
        matched = sorted(i for i in self.live_ids if ids is None or i in ids)
        if "count(n) AS node_count" in query:
            return _FakeResult([{"node_count": len(matched)}])
        if "DETACH DELETE" in query and "RETURN n.id AS id" in query:
            # The collect-and-delete statement: it removes the nodes AND returns
            # their ids, in one round trip.
            self.live_ids.difference_update(matched)
            return _FakeResult([{"id": i} for i in matched], deleted=len(matched))
        if "DETACH DELETE" in query:
            self.live_ids.difference_update(matched)
            return _FakeResult([], deleted=len(matched))
        if "RETURN n.id AS id" in query:
            return _FakeResult([{"id": i} for i in matched])
        return _FakeResult([])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeResult:
    """Minimal stand-in for a neo4j Result (iterable, plus .single()/.consume())."""

    def __init__(self, records, deleted: int = 0):
        self._records = records
        self._deleted = deleted

    def __iter__(self):
        return iter(self._records)

    def single(self):
        return self._records[0] if self._records else None

    def consume(self):
        return SimpleNamespace(counters=SimpleNamespace(nodes_deleted=self._deleted))


def _base_config_kwargs() -> dict:
    return {
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "test",
        "db_name": "test_memory_db",
        "auto_create": False,
        "use_multi_db": False,
        "user_name": "alice",
        "embedding_dimension": 3,
    }


@pytest.fixture
def community_config():
    """`neo4j-community` is the backend that owns a `vec_db` mirror."""
    return Neo4jCommunityGraphDBConfig(
        **_base_config_kwargs(),
        vec_config={
            "backend": "qdrant",
            "config": {
                "collection_name": "test_vectors",
                "path": "/tmp/memos_test_vectors",
            },
        },
    )


@pytest.fixture
def enterprise_config():
    """`neo4j` has no `vec_db`; it searches the native vector index instead."""
    return Neo4jGraphDBConfig(**_base_config_kwargs())


@pytest.fixture
def community_db(community_config):
    """Community backend with a faked driver and a faked vector store."""
    from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB

    live_ids = {"mem-1", "mem-2", "mem-3"}
    issued_queries: list[str] = []

    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_gd.driver.return_value = MagicMock()
        with patch("memos.graph_dbs.neo4j_community.VecDBFactory.from_config") as mock_factory:
            mock_factory.return_value = MagicMock()
            db = Neo4jCommunityGraphDB(community_config)

    db.driver = MagicMock()
    db.driver.session.side_effect = lambda **kwargs: _FakeNeo4jSession(live_ids, issued_queries)

    vector_ids = set(live_ids)
    db.vec_db = MagicMock()
    db.vec_db.delete.side_effect = lambda ids: [vector_ids.discard(i) for i in ids]

    db.live_ids = live_ids
    db.vector_ids = vector_ids
    db.issued_queries = issued_queries
    return db


class TestCommunityDeletePurgesVectors:
    """Regression: the community backend deletes vectors together with nodes."""

    def test_delete_by_memory_ids_purges_vectors(self, community_db):
        deleted = community_db.delete_node_by_prams(memory_ids=["mem-1", "mem-2"])

        assert deleted == 2
        assert community_db.live_ids == {"mem-3"}
        assert community_db.vector_ids == {"mem-3"}, "vectors of deleted nodes must not survive"
        assert community_db.vec_db.delete.call_count == 1
        assert sorted(community_db.vec_db.delete.call_args[0][0]) == ["mem-1", "mem-2"]

    def test_graph_deletion_and_return_value_unchanged(self, community_db):
        """The fix must not change which nodes the graph store deletes."""
        deleted = community_db.delete_node_by_prams(memory_ids=["mem-3"])

        assert deleted == 1
        assert community_db.live_ids == {"mem-1", "mem-2"}
        assert community_db.vector_ids == {"mem-1", "mem-2"}
        assert any("DETACH DELETE" in q for q in community_db.issued_queries)

    def test_vec_db_failure_does_not_mask_successful_delete(self, community_db):
        """A vector store outage must not turn a committed delete into a failure."""
        community_db.vec_db.delete.side_effect = RuntimeError("qdrant unreachable")

        deleted = community_db.delete_node_by_prams(memory_ids=["mem-1"])

        assert deleted == 1
        assert community_db.live_ids == {"mem-2", "mem-3"}

    def test_delete_by_filter_purges_vectors(self, community_db):
        """Deleting by metadata filter must purge vectors too."""
        community_db.get_by_metadata = MagicMock(return_value=["mem-1", "mem-3"])

        deleted = community_db.delete_node_by_prams(filter={"user_id": "u_1"})

        assert deleted == 2
        assert community_db.live_ids == {"mem-2"}
        assert community_db.vector_ids == {"mem-2"}
        assert sorted(community_db.vec_db.delete.call_args[0][0]) == ["mem-1", "mem-3"]

    def test_no_match_does_not_touch_vec_db(self, community_db):
        """An empty match set must not issue a vector delete call."""
        deleted = community_db.delete_node_by_prams(memory_ids=["does-not-exist"])

        assert deleted == 0
        assert community_db.live_ids == {"mem-1", "mem-2", "mem-3"}
        assert community_db.vector_ids == {"mem-1", "mem-2", "mem-3"}
        community_db.vec_db.delete.assert_not_called()

    def test_clear_still_purges_all_vectors(self, community_db):
        """The neighbouring `clear()` path keeps working after the refactor."""
        community_db.vec_db.get_by_filter.return_value = [
            SimpleNamespace(id="mem-1"),
            SimpleNamespace(id="mem-2"),
        ]

        community_db.clear(user_name="alice")

        community_db.vec_db.get_by_filter.assert_called_once_with({"user_name": "alice"})
        community_db.vec_db.delete.assert_called_once_with(["mem-1", "mem-2"])
        assert community_db.live_ids == set()
        assert any("DETACH DELETE" in q for q in community_db.issued_queries)

    def test_collect_and_delete_are_one_statement(self, community_db):
        """The ids and the deletion must come from a single statement.

        Two separate auto-commit statements leave a window in which a concurrent
        writer can add nodes matching the same filter: those nodes are deleted
        without their ids ever being collected, so their vectors stay behind and
        the memory keeps surfacing in vector search.
        """
        deleted = community_db.delete_node_by_prams(memory_ids=["mem-1", "mem-2"])

        assert deleted == 2
        deletes = [q for q in community_db.issued_queries if "DETACH DELETE" in q]
        assert len(deletes) == 1, f"expected one delete statement, got {deletes}"
        assert "RETURN n.id AS id" in deletes[0], (
            "the delete statement must return the deleted ids, "
            "so no separate id-collection round trip is needed"
        )


class TestBackendWithoutVecDB:
    """`neo4j` sets up no `vec_db`, so the vector purge must degrade to a no-op."""

    @pytest.fixture
    def enterprise_db(self, enterprise_config):
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        live_ids = {"mem-1", "mem-2", "mem-3"}
        issued_queries: list[str] = []

        with patch("neo4j.GraphDatabase") as mock_gd:
            mock_gd.driver.return_value = MagicMock()
            db = Neo4jGraphDB(enterprise_config)

        db.driver = MagicMock()
        db.driver.session.side_effect = lambda **kwargs: _FakeNeo4jSession(live_ids, issued_queries)
        db.live_ids = live_ids
        db.issued_queries = issued_queries
        return db

    def test_delete_without_vec_db_succeeds(self, enterprise_db):
        deleted = enterprise_db.delete_node_by_prams(memory_ids=["mem-1", "mem-2"])

        assert deleted == 2
        assert enterprise_db.live_ids == {"mem-3"}
        assert any("DETACH DELETE" in q for q in enterprise_db.issued_queries)

    def test_no_match_without_vec_db(self, enterprise_db):
        deleted = enterprise_db.delete_node_by_prams(memory_ids=["does-not-exist"])

        assert deleted == 0
        assert enterprise_db.live_ids == {"mem-1", "mem-2", "mem-3"}
