"""Real consistent graph export and global Cube pagination."""

import os

from contextlib import contextmanager
from copy import deepcopy

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity_integration import ObservedConnection
from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


def seed(db):
    for owner, key, state, instant in [
        ("A", "same", "activated", "2026-01-02T08:00:00+08:00"),
        ("B", "same", "activated", "2026-01-02T00:00:00Z"),
        ("A", "old", "deleted", "2026-01-01T00:00:00Z"),
        ("A", "null", None, None),
        ("A", "missing", "missing", 10),
    ]:
        meta = {
            "status": state,
            "memory_type": "LongTermMemory",
            "created_at": instant,
            "user_id": "u",
            "embedding": [1, 0, 0],
        }
        if state == "missing":
            del meta["status"]
        db.add_node(key, owner + " " + key, meta, user_name=owner)
    db.add_edge("same", "old", "PARENT")
    db.add_edge("same", "same", "FOLLOWS", user_name="B")


def identities(result):
    return [(n["metadata"]["user_name"], n["id"]) for n in result["nodes"]]


def test_global_pages_counts_scope_and_induced_edges(stores):
    db = stores()
    seed(db)
    assert identities(db.export_graph()) == [("A", "same"), ("A", "null"), ("A", "missing")]
    assert identities(db.export_graph(user_name="B")) == [("B", "same")]
    result = db.export_graph(all_cubes=True, status=[], include_embedding=True)
    assert identities(result) == [
        ("A", "same"),
        ("B", "same"),
        ("A", "old"),
        ("A", "null"),
        ("A", "missing"),
    ]
    assert result["total_nodes"] == 5 and result["total_edges"] == 2
    assert result["edges"] == [
        {"source": "same", "target": "old", "type": "PARENT", "user_name": "A"},
        {"source": "same", "target": "same", "type": "FOLLOWS", "user_name": "B"},
    ]
    assert all(n["metadata"]["embedding"] == [1, 0, 0] for n in result["nodes"])
    pages = [db.export_graph(all_cubes=True, status=[], page=p, page_size=2) for p in range(1, 5)]
    assert [identities(p) for p in pages] == [
        [("A", "same"), ("B", "same")],
        [("A", "old"), ("A", "null")],
        [("A", "missing")],
        [],
    ]
    assert [p["total_nodes"] for p in pages] == [5] * 4
    assert [p["total_edges"] for p in pages] == [1, 0, 0, 0]
    assert all("embedding" not in n["metadata"] for p in pages for n in p["nodes"])


@pytest.mark.parametrize(
    "status,expected",
    [
        (None, ["same", "null", "missing"]),
        ([], ["same", "old", "null", "missing"]),
        (["activated"], ["same", "missing"]),
        (["deleted", "activated"], ["same", "old", "missing"]),
    ],
)
def test_filter_status_user_type_and_nested_or(stores, status, expected):
    db = stores()
    seed(db)
    condition = {"or": [{"user_name": "B"}, {"user_id": "u"}]}
    before = deepcopy(condition)
    result = db.export_graph(
        filter=condition, status=status, user_id="u", memory_type=["LongTermMemory", "DreamDiary"]
    )
    assert identities(result) == [("A", key) for key in expected]
    assert result["total_nodes"] == len(expected) and condition == before
    assert db.export_graph(user_id="absent")["total_nodes"] == 0
    assert db.export_graph(memory_type=["InsightMemory"])["nodes"] == []


def test_full_single_cube_edges_and_null_vector(stores, database):
    db = stores()
    seed(db)
    db.add_node("z", "no vector", {"created_at": "2026-01-03"})
    admin, _ = database
    _query(
        admin,
        """SELECT * FROM ag_catalog.cypher('memos_graph', $$MATCH (a:Memory {id:'same',user_name:'A'}),(b:Memory {id:'same',user_name:'B'}) CREATE (a)-[:DIRTY]->(b)$$) AS (r agtype)""",
    )
    result = db.export_graph(include_embedding=True, status=[])
    assert result["nodes"][0] == {
        "id": "z",
        "memory": "no vector",
        "metadata": {"user_name": "A", "created_at": "2026-01-03", "embedding": None},
    }
    assert result["edges"] == [{"source": "same", "target": "old", "type": "PARENT"}]
    assert db.export_graph(all_cubes=True, status=[])["total_edges"] == 2


def test_one_snapshot_survives_writes_between_count_nodes_and_edges(stores, monkeypatch):
    db, writer = stores(maxconn=1), stores()
    seed(db)
    original = db._get_connection
    seen = []

    def hook(stage, cursor, rows):
        if stage == "execute" and cursor.statement.startswith("SELECT COUNT(*)"):
            seen.append("count")
            writer.add_node("late", "after count", {"created_at": "2027-01-01"})
        elif stage == "fetchall" and cursor.statement.startswith("SELECT business_id,"):
            seen.append("nodes")
            writer.delete_edge("same", "old", "PARENT")
            writer.add_node("same", "changed", {"status": "deleted"})

    @contextmanager
    def observed(**kwargs):
        with original(**kwargs) as raw:
            yield ObservedConnection(raw, hook)

    with monkeypatch.context() as patch:
        patch.setattr(db, "_get_connection", observed)
        result = db.export_graph(status=[])
    assert seen == ["count", "nodes"]
    assert result["total_nodes"] == 4 and result["total_edges"] == 1
    assert result["nodes"][0]["memory"] == "A same"
    assert db.export_graph(status=[])["total_nodes"] == 5
    assert db.export_graph(status=[])["total_edges"] == 0
    db.add_node("after", "write works", {})


def test_bad_time_decode_and_readonly_failure_restore_session(stores, database):
    db = stores(maxconn=1)
    db.add_node("bad", "fixture", {"created_at": "not a time"})
    with pytest.raises(GraphDBError):
        db.export_graph(page=99, page_size=1)
    db.add_node("bad", "fixed", {})
    with pytest.raises(GraphDBError), db._cursor(snapshot=True) as cursor:
        cursor.execute('DELETE FROM memos_graph."Memory"')
    db.add_node("after", "works", {})
    assert db.export_graph()["total_nodes"] == 2
    admin, _ = database
    _query(
        admin,
        """UPDATE memos_graph."Memory" SET properties='{}'::agtype WHERE business_id='bad' """,
    )
    with pytest.raises(GraphDBError, match="Inconsistent"):
        db.export_graph()


def test_physical_empty_scope_special_values_and_no_input_changes(stores):
    db = stores(user_name=None, use_multi_db=True)
    meta = {"user_id": " u' ", "memory_type": "DreamDiary", "status": "activated"}
    db.add_node(" ID' ", "exact", meta)
    assert db.export_graph(user_id=" u' ", memory_type=[])["nodes"] == [
        {"id": " ID' ", "memory": "exact", "metadata": {**meta, "user_name": ""}}
    ]
