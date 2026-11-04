"""Unit tests for the batched ``Neo4jCommunityGraphDB.get_nodes`` override.

These tests pin the behavioral contract of the override:
1. Result equivalence with the inherited per-node path (deep equality,
   same ordering, identical Cypher and query params).
2. The vector-DB call pattern: one batched ``get_by_ids`` call instead of
   N per-node ``get_by_id`` calls (the structural fix for the N+1 issue).
3. A latency-injection smoke test proving the serial round trips are
   eliminated (relative assertion, robust on slow CI machines).
"""

import time

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jCommunityGraphDBConfig
from memos.configs.vec_db import VectorDBConfigFactory
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB


N = 20
VECTOR = [0.1, 0.2, 0.3]


def _make_config():
    return Neo4jCommunityGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_memory_db",
        auto_create=False,
        use_multi_db=False,
        embedding_dimension=3,
        user_name="tester",
        # VecDBFactory.from_config is patched in the fixture below, so only a
        # structurally valid shape is needed here.
        vec_config=VectorDBConfigFactory.model_construct(
            backend="qdrant", config={"collection_name": "test_collection"}
        ),
    )


def _make_records(n):
    """Build a fake Neo4j result set: ``record["n"]`` yields the node dict."""

    class _Record:
        def __init__(self, node):
            self._node = node

        def __getitem__(self, key):
            if key == "n":
                return self._node
            raise KeyError(key)

    records = []
    for i in range(n):
        node = {
            "id": f"node-{i}",
            "memory": f"memory content {i}",
            "memory_type": "LongTermMemory",
            "created_at": datetime(2026, 1, 1, 0, 0, i),
            "updated_at": datetime(2026, 1, 2, 0, 0, i),
            "sources": ['{"conversation_id": "s1"}'],
            "user_name": "tester",
            "tags": ["t"],
        }
        records.append(_Record(node))
    return records


def _wire_session(db, records):
    session_mock = db.driver.session.return_value.__enter__.return_value
    session_mock.run.return_value = records
    return session_mock


def _wire_vec_all_present(vec):
    vec.get_by_id.side_effect = lambda id: SimpleNamespace(id=id, vector=VECTOR)
    vec.get_by_ids.side_effect = lambda ids: [SimpleNamespace(id=i, vector=VECTOR) for i in ids]


@pytest.fixture
def db():
    # Same patching pattern as test_search_return_fields.py: neo4j.py imports
    # GraphDatabase lazily inside __init__, so the top-level neo4j package is
    # the patch target.
    with (
        patch("neo4j.GraphDatabase") as mock_gd,
        patch("memos.graph_dbs.neo4j_community.VecDBFactory") as factory,
    ):
        mock_gd.driver.return_value = MagicMock()
        factory.from_config.return_value = MagicMock()
        gdb = Neo4jCommunityGraphDB(_make_config())
        yield gdb


def _run_inherited(db, ids):
    """Run the pre-override behavior: call the base class method directly."""
    return Neo4jGraphDB.get_nodes(db, ids)


def test_get_nodes_equivalence_and_call_pattern(db):
    """Same output as the inherited path; vector fetch collapses N calls to 1."""
    ids = [f"node-{i}" for i in range(N)]

    _wire_session(db, _make_records(N))
    _wire_vec_all_present(db.vec_db)
    inherited_res = _run_inherited(db, ids)
    assert db.vec_db.get_by_id.call_count == N
    assert db.vec_db.get_by_ids.call_count == 0

    db.vec_db.reset_mock(side_effect=True)
    _wire_vec_all_present(db.vec_db)
    _wire_session(db, _make_records(N))
    override_res = db.get_nodes(ids)
    assert db.vec_db.get_by_ids.call_count == 1
    assert db.vec_db.get_by_id.call_count == 0

    assert override_res == inherited_res
    assert [r["id"] for r in override_res] == ids


def test_cypher_and_params_identical_to_base(db):
    """The override must issue byte-identical Cypher and params."""
    ids = [f"node-{i}" for i in range(N)]
    _wire_vec_all_present(db.vec_db)

    _wire_session(db, _make_records(N))
    _run_inherited(db, ids)
    inherited_call = db.driver.session.return_value.__enter__.return_value.run.call_args_list[-1]

    _wire_session(db, _make_records(N))
    db.get_nodes(ids)
    override_call = db.driver.session.return_value.__enter__.return_value.run.call_args_list[-1]

    assert override_call.args == inherited_call.args
    assert "n.id IN $ids" in override_call.args[0]
    assert "n.user_name = $user_name" in override_call.args[0]


def test_empty_ids_short_circuits(db):
    """Empty input returns [] without issuing any new query."""
    session_mock = db.driver.session.return_value.__enter__.return_value
    before = session_mock.run.call_count
    assert db.get_nodes([]) == []
    assert session_mock.run.call_count == before
    db.vec_db.get_by_ids.assert_not_called()


def test_missing_vector_semantics_pinned(db):
    """Pin the only behavioral delta: missing vectors now yield None.

    The inherited path omits the ``embedding`` key when a node has no vector,
    while the batched path sets ``metadata["embedding"] = None`` (matching the
    existing ``_parse_nodes``/``get_all_memory_items`` behavior). Downstream
    consumers read the field via ``.get()``/getattr truthiness, so the two
    states are indistinguishable in practice.
    """
    ids = [f"node-{i}" for i in range(N)]
    missing = {"node-3", "node-7"}

    _wire_session(db, _make_records(N))
    db.vec_db.get_by_id.side_effect = (
        lambda id: None if id in missing else SimpleNamespace(id=id, vector=VECTOR)
    )
    db.vec_db.get_by_ids.side_effect = lambda ids: [
        SimpleNamespace(id=i, vector=VECTOR) for i in ids if i not in missing
    ]
    inherited_res = _run_inherited(db, ids)

    _wire_session(db, _make_records(N))
    override_res = db.get_nodes(ids)

    for inherited_node, override_node in zip(inherited_res, override_res, strict=True):
        if inherited_node["id"] in missing:
            assert "embedding" not in inherited_node["metadata"]
            assert override_node["metadata"]["embedding"] is None
        else:
            assert (
                inherited_node["metadata"]["embedding"]
                == VECTOR
                == override_node["metadata"]["embedding"]
            )
        # Semantically equivalent for .get()-style consumers.
        assert inherited_node["metadata"].get("embedding") == override_node["metadata"].get(
            "embedding"
        )


def test_performance_latency_injection(db):
    """Smoke test: injected per-call latency is paid once, not N times.

    Absolute timings are not asserted (CI machines vary); instead both paths
    are timed in-process and the batched path must win by a wide margin that
    only holds if the N serial round trips are gone.
    """
    ids = [f"node-{i}" for i in range(N)]
    per_call = 0.01

    def _slow_get_by_id(id):
        time.sleep(per_call)
        return SimpleNamespace(id=id, vector=VECTOR)

    def _slow_get_by_ids(ids):
        time.sleep(per_call)
        return [SimpleNamespace(id=i, vector=VECTOR) for i in ids]

    _wire_session(db, _make_records(N))
    db.vec_db.get_by_id.side_effect = _slow_get_by_id
    db.vec_db.get_by_ids.side_effect = _slow_get_by_ids

    start = time.perf_counter()
    _run_inherited(db, ids)
    inherited_elapsed = time.perf_counter() - start

    start = time.perf_counter()
    db.get_nodes(ids)
    override_elapsed = time.perf_counter() - start

    assert db.vec_db.get_by_ids.call_count == 1
    assert inherited_elapsed >= N * per_call * 0.9
    assert override_elapsed * 5 < inherited_elapsed, (
        f"batched path should be at least 5x faster: "
        f"override={override_elapsed:.3f}s inherited={inherited_elapsed:.3f}s"
    )
