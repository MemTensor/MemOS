"""
Tests for Neo4j vector search pre-filtering and related regressions.

- Unit tests: verify query structure (pre-filter vs ANN paths) using mocks
- Integration tests: verify real search behavior with multi-user data (requires Neo4j 5.18+)

The pre-filter approach (Neo4j 5.18+):
  When WHERE filters are present (scope, status, user_name, etc.), the query uses
  MATCH + WHERE to narrow candidates first, then vector.similarity.cosine()
  computes similarity only on the filtered set. This avoids the post-filter
  problem entirely — no nodes are lost due to global top-k truncation.

  When no filters are present, the ANN vector index (db.index.vector.queryNodes)
  is used for maximum efficiency.
"""

import math
import os
import uuid

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig


# ──────────────────────────────────────────────────────────────────────────────
# Fixtures for unit tests (mocked Neo4j driver)
# ──────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def shared_db_config():
    """Shared-database multi-tenant config (use_multi_db=False)."""
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_db",
        auto_create=False,
        use_multi_db=False,
        user_name="default_user",
        embedding_dimension=3,
    )


@pytest.fixture
def multi_db_config():
    """Multi-database config — no user_name filter in queries."""
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_db",
        auto_create=False,
        use_multi_db=True,
        embedding_dimension=3,
    )


@pytest.fixture
def shared_neo4j_db(shared_db_config):
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(shared_db_config)
        db.driver = mock_driver
        yield db


@pytest.fixture
def multi_neo4j_db(multi_db_config):
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(multi_db_config)
        db.driver = mock_driver
        yield db


# ──────────────────────────────────────────────────────────────────────────────
# Unit tests: pre-filter vs ANN query paths
# ──────────────────────────────────────────────────────────────────────────────


class TestVectorSearchPreFilter:
    """Verify pre-filter path uses MATCH + vector.similarity.cosine()
    and ANN path uses db.index.vector.queryNodes."""

    def test_prefilter_with_scope(self, shared_neo4j_db):
        """With scope filter, query should use MATCH + cosine similarity, not queryNodes."""
        session_mock = shared_neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        shared_neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            scope="LongTermMemory",
        )

        query = session_mock.run.call_args[0][0]
        assert "MATCH (node:Memory)" in query
        assert "vector.similarity.cosine(node.embedding, $embedding)" in query
        assert "queryNodes" not in query

    def test_prefilter_with_all_filters(self, shared_neo4j_db):
        """With scope + status + user_name, all filters appear in WHERE before similarity."""
        session_mock = shared_neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        shared_neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=10,
            scope="LongTermMemory",
            status="activated",
            user_name="some_user",
        )

        query = session_mock.run.call_args[0][0]
        assert "MATCH (node:Memory)" in query
        assert "node.memory_type = $scope" in query
        assert "node.status = $status" in query
        assert "node.user_name = $user_name" in query
        assert "vector.similarity.cosine" in query

    def test_prefilter_includes_embedding_not_null(self, shared_neo4j_db):
        """Pre-filter query should exclude nodes without embeddings."""
        session_mock = shared_neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        shared_neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            scope="LongTermMemory",
        )

        query = session_mock.run.call_args[0][0]
        assert "node.embedding IS NOT NULL" in query

    def test_prefilter_has_order_by_and_limit(self, shared_neo4j_db):
        """Pre-filter results should be ordered by score and limited."""
        session_mock = shared_neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        shared_neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
            scope="LongTermMemory",
        )

        query = session_mock.run.call_args[0][0]
        assert "ORDER BY score DESC" in query
        assert "LIMIT $top_k" in query
        params = session_mock.run.call_args[0][1]
        assert params["top_k"] == 5

    def test_ann_path_without_filters(self, multi_neo4j_db):
        """Without any filter, query should use queryNodes ANN index."""
        session_mock = multi_neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        multi_neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
        )

        query = session_mock.run.call_args[0][0]
        assert "queryNodes" in query
        assert "$top_k" in query
        assert "MATCH (node:Memory)" not in query
        params = session_mock.run.call_args[0][1]
        assert params["top_k"] == 5

    def test_ann_path_no_redundant_params(self, multi_neo4j_db):
        """ANN path should only have embedding and top_k, nothing extra."""
        session_mock = multi_neo4j_db.driver.session.return_value.__enter__.return_value
        session_mock.run.return_value = []

        multi_neo4j_db.search_by_embedding(
            vector=[0.1, 0.2, 0.3],
            top_k=5,
        )

        params = session_mock.run.call_args[0][1]
        assert set(params.keys()) == {"embedding", "top_k"}


# ──────────────────────────────────────────────────────────────────────────────
# Unit tests: sources KeyError regression
# ──────────────────────────────────────────────────────────────────────────────


class TestSourcesKeyErrorRegression:
    """Verify that missing/None 'sources' key doesn't cause KeyError."""

    def test_add_node_without_sources_key(self, shared_neo4j_db):
        session_mock = shared_neo4j_db.driver.session.return_value.__enter__.return_value

        shared_neo4j_db.add_node(
            id="test-node-1",
            memory="test content",
            metadata={
                "memory_type": "WorkingMemory",
                "embedding": [0.1, 0.2, 0.3],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )

        calls = session_mock.run.call_args_list
        assert any("MERGE (n:Memory" in str(call) for call in calls)

    def test_add_node_with_empty_sources(self, shared_neo4j_db):
        _session_mock = shared_neo4j_db.driver.session.return_value.__enter__.return_value

        shared_neo4j_db.add_node(
            id="test-node-2",
            memory="test content",
            metadata={
                "memory_type": "WorkingMemory",
                "embedding": [0.1, 0.2, 0.3],
                "sources": [],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    def test_parse_node_without_sources_key(self, shared_neo4j_db):
        result = shared_neo4j_db._parse_node(
            {
                "id": "node-1",
                "memory": "hello",
                "memory_type": "WorkingMemory",
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }
        )
        assert result["id"] == "node-1"
        assert result["memory"] == "hello"


# ──────────────────────────────────────────────────────────────────────────────
# Integration tests (require a running Neo4j 5.18+ with vector index)
#
# Activate by setting environment variables:
#   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
#
# Run:
#   pytest tests/graph_dbs/test_neo4j_vector_search.py -k Integration -v
# ──────────────────────────────────────────────────────────────────────────────


def _neo4j_package_available():
    try:
        import neo4j  # noqa: F401

        return True
    except ImportError:
        return False


_neo4j_configured = _neo4j_package_available() and all(
    os.getenv(k) for k in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD")
)
_TEST_RUN_ID = uuid.uuid4().hex[:8]
_TARGET_USER = f"__test_target_{_TEST_RUN_ID}"
_OTHER_USER_PREFIX = f"__test_other_{_TEST_RUN_ID}"


def _make_unit_vector(
    dim: int, dominant_axis: int, secondary_axis: int | None = None
) -> list[float]:
    """
    Create a unit vector concentrated on one axis, optionally blended with a second.

    Used to control cosine similarity in tests:
    - Two vectors on the same axis → cos_sim ≈ 1.0
    - Orthogonal axes → cos_sim ≈ 0.0
    - Blended → cos_sim ≈ 0.707
    """
    vec = [0.0] * dim
    vec[dominant_axis % dim] = 1.0
    if secondary_axis is not None:
        vec[secondary_axis % dim] = 1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec]


@pytest.fixture(scope="module")
def integration_config():
    if not _neo4j_configured:
        pytest.skip("Neo4j not configured (need NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)")
    return Neo4jGraphDBConfig(
        uri=os.getenv("NEO4J_URI"),
        user=os.getenv("NEO4J_USER"),
        password=os.getenv("NEO4J_PASSWORD"),
        db_name=os.getenv("NEO4J_DB_NAME", "neo4j"),
        auto_create=False,
        use_multi_db=False,
        user_name=f"__test_default_{_TEST_RUN_ID}",
        embedding_dimension=int(os.getenv("EMBEDDING_DIMENSION", "1536")),
    )


@pytest.fixture(scope="module")
def integration_db(integration_config):
    from memos.graph_dbs.neo4j import Neo4jGraphDB

    return Neo4jGraphDB(integration_config)


@pytest.mark.skipif(not _neo4j_configured, reason="Neo4j not configured")
class TestNeo4jPreFilterIntegration:
    """
    Integration test: pre-filtered vector search in a multi-user shared database.

    Uses vector.similarity.cosine() with MATCH + WHERE to pre-filter by user,
    guaranteeing that target user's nodes are always considered regardless of
    how many other users' nodes exist in the database.
    """

    @pytest.fixture(scope="class", autouse=True)
    def seed_and_cleanup(self, integration_db, integration_config):
        """
        Seed multi-user test data, then clean up.

        - 50 "other" user nodes: embeddings along axis 0 → cos_sim ≈ 1.0 with query
        - 3 "target" user nodes: embeddings blended axis 0+1 → cos_sim ≈ 0.707 with query

        With pre-filtering, only the target user's 3 nodes are candidates for
        similarity computation, so all 3 are always returned.
        """
        dim = integration_config.embedding_dimension
        now = datetime.now(timezone.utc).isoformat()

        for i in range(50):
            other_user = f"{_OTHER_USER_PREFIX}_{i % 10}"
            integration_db.add_node(
                id=f"__test_other_{_TEST_RUN_ID}_{i}",
                memory=f"Other user memory {i}",
                metadata={
                    "memory_type": "LongTermMemory",
                    "status": "activated",
                    "embedding": _make_unit_vector(dim, dominant_axis=0),
                    "created_at": now,
                    "updated_at": now,
                },
                user_name=other_user,
            )

        for i in range(3):
            integration_db.add_node(
                id=f"__test_target_{_TEST_RUN_ID}_{i}",
                memory=f"Target user memory {i}",
                metadata={
                    "memory_type": "LongTermMemory",
                    "status": "activated",
                    "embedding": _make_unit_vector(dim, dominant_axis=0, secondary_axis=1),
                    "created_at": now,
                    "updated_at": now,
                },
                user_name=_TARGET_USER,
            )

        yield

        integration_db.clear(user_name=_TARGET_USER)
        for i in range(10):
            integration_db.clear(user_name=f"{_OTHER_USER_PREFIX}_{i}")

    def test_search_returns_all_target_user_results(self, integration_db, integration_config):
        """Pre-filtering guarantees all target user nodes are found."""
        dim = integration_config.embedding_dimension
        query_vector = _make_unit_vector(dim, dominant_axis=0)

        results = integration_db.search_by_embedding(
            vector=query_vector,
            top_k=3,
            scope="LongTermMemory",
            status="activated",
            user_name=_TARGET_USER,
        )

        assert len(results) == 3, (
            f"Pre-filter should return all 3 target user nodes, got {len(results)}. "
            "This indicates pre-filtering is not working correctly."
        )

    def test_all_returned_ids_belong_to_target_user(self, integration_db, integration_config):
        dim = integration_config.embedding_dimension
        query_vector = _make_unit_vector(dim, dominant_axis=0)

        results = integration_db.search_by_embedding(
            vector=query_vector,
            top_k=3,
            scope="LongTermMemory",
            status="activated",
            user_name=_TARGET_USER,
        )

        for r in results:
            assert r["id"].startswith(f"__test_target_{_TEST_RUN_ID}_"), (
                f"Result {r['id']} does not belong to the target user"
            )

    def test_scores_are_positive(self, integration_db, integration_config):
        dim = integration_config.embedding_dimension
        query_vector = _make_unit_vector(dim, dominant_axis=0)

        results = integration_db.search_by_embedding(
            vector=query_vector,
            top_k=3,
            scope="LongTermMemory",
            status="activated",
            user_name=_TARGET_USER,
        )

        for r in results:
            assert r["score"] > 0, f"Score should be positive, got {r['score']}"
