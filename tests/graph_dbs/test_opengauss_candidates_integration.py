"""Real AGE candidate sets, projection, isolation and cancellation."""

import os

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity_integration import observe, wait_until
from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)
TYPE = "LongTermMemory"


def node(key, status="activated", kind=TYPE, vector=None):
    return {
        "id": key,
        "memory": "fixture " + key,
        "metadata": {"status": status, "memory_type": kind, "embedding": vector},
    }


@pytest.mark.parametrize("embedding", [False, True])
def test_strict_status_and_type_full_projection_and_isolation(stores, embedding):
    db = stores()
    inputs = [node("same", vector=[1, 0, 0]), node("z"), node("missing")]
    del inputs[-1]["metadata"]["status"]
    inputs += [
        node(str(i), state)
        for i, state in enumerate(
            [None, "resolving", "archived", "deleted", "Activated", True, ["activated"]]
        )
    ]
    inputs += [node("other-type", kind="UserMemory"), node("null-type", kind=None)]
    original = deepcopy(inputs)
    db.add_nodes_batch(inputs)
    db.add_node("same", "B same ID", node("same")["metadata"], user_name="B")
    assert db.get_structure_optimization_candidates(TYPE, embedding) == [
        {
            "id": key,
            "memory": "fixture " + key,
            "metadata": {
                "status": "activated",
                "memory_type": TYPE,
                **({"embedding": vec} if embedding else {}),
            },
        }
        for key, vec in [("same", [1, 0, 0]), ("z", None)]
    ]
    assert db.get_structure_optimization_candidates(TYPE, user_name="B") == [
        {
            "id": "same",
            "memory": "B same ID",
            "metadata": {"status": "activated", "memory_type": TYPE},
        }
    ]
    assert db.get_structure_optimization_candidates(TYPE, user_name="empty") == []
    assert inputs == original
    assert db.get_memory_count(TYPE) == 10  # Candidate strictness does not change capacity.


def test_parent_directions_self_loop_neighbor_state_and_dirty_edges(stores, database):
    db = stores()
    admin, _ = database
    keep = ["a-other-relation", "b-cross-out", "c-cross-in", "d-isolated"]
    db.add_nodes_batch([node(key) for key in [*keep, "in", "out", "self"]])
    db.add_nodes_batch([node("deleted", "deleted", "UserMemory"), node("archived", "archived")])
    db.add_edge("deleted", "in", "PARENT")
    db.add_edge("out", "archived", "PARENT")
    db.add_edge("self", "self", "PARENT")
    db.add_edge("a-other-relation", "archived", "FOLLOWS")
    db.add_node("foreign", "B", node("foreign")["metadata"], user_name="B")
    _query(
        admin,
        """SELECT * FROM ag_catalog.cypher('memos_graph', $$
        MATCH (a:Memory {id:'b-cross-out',user_name:'A'}),
              (b:Memory {id:'foreign',user_name:'B'}),
              (c:Memory {id:'c-cross-in',user_name:'A'})
        CREATE (a)-[:PARENT]->(b), (b)-[:PARENT]->(c)
        $$) AS (result agtype)""",
    )
    assert [n["id"] for n in db.get_structure_optimization_candidates(TYPE)] == keep
    assert [n["id"] for n in db.get_structure_optimization_candidates(TYPE, user_name="B")] == [
        "foreign"
    ]


def test_no_limit_special_strings_and_physical_scope(stores):
    db = stores(use_multi_db=True, user_name=None)
    keys = [f"id-{i:04}" for i in range(510)] + [" 中文 ' %_\\ "]
    kind = " DreamDiary ' "
    db.add_nodes_batch([node(key, kind=kind) for key in reversed(keys)])
    assert [n["id"] for n in db.get_structure_optimization_candidates(kind)] == sorted(keys)
    cube = " Cube 中文 ' %_\\ "
    db.add_node("explicit", "exact", node("explicit", kind=kind)["metadata"], user_name=cube)
    assert [n["id"] for n in db.get_structure_optimization_candidates(kind, user_name=cube)] == [
        "explicit"
    ]


@pytest.mark.parametrize("direction", ["INCOMING", "OUTGOING"])
@pytest.mark.parametrize("kind", [TYPE, "UserMemory"])
@pytest.mark.parametrize(
    "state", ["activated", "resolving", "archived", "deleted", None, "missing"]
)
def test_parent_neighbor_status_and_type_never_restore_eligibility(stores, direction, kind, state):
    db = stores()
    neighbor = node("neighbor", state, kind)
    if state == "missing":
        del neighbor["metadata"]["status"]
    db.add_nodes_batch([node("candidate"), neighbor])
    source, target = (
        ("neighbor", "candidate") if direction == "INCOMING" else ("candidate", "neighbor")
    )
    db.add_edge(source, target, "PARENT")
    assert db.get_structure_optimization_candidates(TYPE) == []


def test_candidate_and_content_share_one_statement_snapshot(stores, monkeypatch):
    db, writer = stores(), stores()
    db.add_nodes_batch([node("a"), node("b")])
    queries = []

    def interleave(stage, cursor, rows):
        if stage == "execute" and "NOT EXISTS" in cursor.statement:
            queries.append(cursor.statement)
            writer.add_edge("a", "b", "PARENT")
            writer.add_node("b", "concurrent change", {"memory_type": TYPE, "status": "deleted"})

    with monkeypatch.context() as patch:
        observe(db, patch, interleave)
        assert db.get_structure_optimization_candidates(TYPE) == [
            {
                "id": key,
                "memory": "fixture " + key,
                "metadata": {"status": "activated", "memory_type": TYPE},
            }
            for key in ("a", "b")
        ]
    assert len(queries) == 1
    assert db.get_structure_optimization_candidates(TYPE) == []
    assert db.get_node("b")["memory"] == "concurrent change"


def test_inconsistent_stored_properties_fail_then_pool_recovers(stores, database):
    db = stores()
    admin, _ = database
    db.add_nodes_batch([node("a"), node("z")])
    _query(
        admin,
        """UPDATE memos_graph."Memory" SET properties =
        '{"id":"wrong","memory":"fixture z","user_name":"A","memory_type":"LongTermMemory","status":"activated"}'::agtype
        WHERE business_id='z' """,
    )
    with pytest.raises(GraphDBError, match="Inconsistent"):
        db.get_structure_optimization_candidates(TYPE)
    db.add_nodes_batch([node("z")])
    assert [n["id"] for n in db.get_structure_optimization_candidates(TYPE)] == ["a", "z"]


def test_real_cancel_replaces_connection_and_preserves_candidates(stores, database):
    db = stores(maxconn=1)
    admin, _ = database
    db.add_nodes_batch([node("a"), node("b")])
    connection = db.connection_pool.getconn()
    pid = _query(connection, "SELECT pg_backend_pid()")[0][0]
    connection.rollback()
    db.connection_pool.putconn(connection)
    admin.autocommit = False
    try:
        _query(admin, 'LOCK TABLE memos_graph."Memory" IN ACCESS EXCLUSIVE MODE')
        with ThreadPoolExecutor(max_workers=1) as executor:
            operation = executor.submit(db.get_structure_optimization_candidates, TYPE)
            try:
                wait_until(
                    lambda: _query(
                        admin, "SELECT 1 FROM pg_locks WHERE pid=%s AND NOT granted", (pid,)
                    )
                )
                connection.cancel()
                with pytest.raises(GraphDBError) as caught:
                    operation.result(timeout=8)
                assert caught.value.__cause__.pgcode == "57014"
            finally:
                admin.rollback()
    finally:
        admin.rollback()
        admin.autocommit = True
    assert connection.closed
    assert [n["id"] for n in db.get_structure_optimization_candidates(TYPE)] == ["a", "b"]
    replacement = db.connection_pool.getconn()
    try:
        assert replacement is not connection
    finally:
        db.connection_pool.putconn(replacement)
