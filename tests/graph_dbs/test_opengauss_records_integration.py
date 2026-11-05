"""Real scoped soft deletion, recovery and ownership ambiguity."""

import json
import os

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Event

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs import test_opengauss_capacity_integration as support
from tests.graph_dbs.test_opengauss_integration import _query


database, stores = support.database, support.stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


def seed(db):
    for key, state in [
        ("a", "activated"),
        ("b", "archived"),
        ("c", "resolving"),
        ("d", None),
        ("e", "missing"),
        ("old", "deleted"),
    ]:
        meta = {
            "status": state,
            "memory_type": "LongTermMemory",
            "created_at": "2026-01-01",
            "updated_at": "2026-01-01",
            "embedding": [1, 0, 0],
            "delete_record_id": "previous",
            "info": {"keep": True},
        }
        if state == "missing":
            del meta["status"]
        db.add_node(key, "星港 " + key, meta)
    db.add_edge("a", "b", "PARENT")
    db.add_node("foreign", "B", {"status": "deleted"}, user_name="B")


def test_ownership_all_states_empty_and_ambiguous_identity(stores):
    db = stores()
    seed(db)
    assert db.exist_user_name("empty") == {"empty": False}
    assert db.exist_user_name("B") == {"B": True}
    assert db.get_user_names_by_memory_ids(["missing", "old", "foreign", "old"]) == {
        "missing": None,
        "old": "A",
        "foreign": "B",
    }
    db.add_node("old", "same ID", {}, user_name="B")
    with pytest.raises(GraphDBError, match="multiple"):
        db.get_user_names_by_memory_ids(["old", "foreign"])
    physical = stores(use_multi_db=True, user_name=None)
    physical.add_node("physical", "empty scope", {})
    assert physical.get_user_names_by_memory_ids(["physical"]) == {"physical": ""}


def test_soft_delete_recovery_and_batches_preserve_unrelated_data(stores, database):
    db = stores()
    seed(db)
    before = {key: db.get_node(key, True) for key in ["a", "b", "c", "d", "e", "old"]}
    admin, _ = database
    original = support.snapshot(admin)
    start = datetime.now(timezone.utc)
    assert db.delete_node_by_mem_cube_id("A", "R1") == 5
    end = datetime.now(timezone.utc)
    times = set()
    for key in ["a", "b", "c", "d", "e"]:
        row = db.get_node(key, True)
        stamp = row["metadata"]["delete_time"]
        assert start <= datetime.fromisoformat(stamp) <= end
        times.add(stamp)
        expected = {
            **before[key],
            "metadata": {
                **before[key]["metadata"],
                "status": "deleted",
                "delete_record_id": "R1",
                "delete_time": stamp,
            },
        }
        assert row == expected
    assert len(times) == 1 and db.get_node("old", True) == before["old"]
    assert support.snapshot(admin)["edges"] == original["edges"]
    assert db.get_memory_count("LongTermMemory") == 6
    assert db.get_structure_optimization_candidates("LongTermMemory") == []
    assert db.export_graph()["nodes"] == []
    assert db.search_by_embedding([1, 0, 0], top_k=20) == []
    assert db.search_by_fulltext(["星港"], top_k=20) == []
    assert db.get_by_metadata([], filter={"delete_record_id": "R1"}) == ["a", "b", "c", "d", "e"]
    assert db.delete_node_by_mem_cube_id("A", "R1") == 0
    assert db.recover_memory_by_mem_cube_id("A", "wrong") == 0
    db.add_node("new", "new", {"status": "activated"})
    assert db.delete_node_by_mem_cube_id("A", "R2") == 1
    assert db.recover_memory_by_mem_cube_id("A", "R1") == 5
    assert db.recover_memory_by_mem_cube_id("A", "R1") == 0
    for key in ["a", "b", "c", "d", "e"]:
        assert db.get_node(key, True) == {
            **before[key],
            "metadata": {
                **before[key]["metadata"],
                "status": "activated",
                "delete_record_id": "",
                "delete_time": "",
            },
        }
    assert [n["id"] for n in db.get_structure_optimization_candidates("LongTermMemory")] == [
        "c",
        "d",
        "e",
    ]
    assert len(db.search_by_embedding([1, 0, 0], top_k=20)) == 5
    assert len(db.search_by_fulltext(["星港"], top_k=20)) == 5
    assert db.delete_node_by_mem_cube_id("A", "R1", True) == 0
    assert db.delete_node_by_mem_cube_id("A", "R2", True) == 1
    assert db.delete_node_by_mem_cube_id("A", "R2", True) == 0
    assert db.get_node("new") is None
    assert db.get_node("foreign", user_name="B")["memory"] == "B"
    assert db.delete_node_by_mem_cube_id("A", "R1") == 5
    assert db.delete_node_by_mem_cube_id("A", "R1", True) == 5
    assert support.ids(db) == ["old"]
    assert db.get_edges("a") == []


@pytest.mark.parametrize("operation", ["delete", "recover"])
def test_late_property_update_failure_rolls_back_entire_record(stores, database, operation):
    db = stores()
    seed(db)
    admin, _ = database
    if operation == "recover":
        db.delete_node_by_mem_cube_id("A", "R")
    before = support.snapshot(admin)
    _query(
        admin,
        """CREATE FUNCTION memos_graph.record_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.business_id='e' THEN RAISE EXCEPTION 'record failure'; END IF; RETURN NEW; END $$""",
    )
    _query(
        admin,
        """CREATE TRIGGER record_fail BEFORE UPDATE ON memos_graph."Memory" FOR EACH ROW EXECUTE PROCEDURE memos_graph.record_fail()""",
    )
    try:
        with pytest.raises(GraphDBError):
            if operation == "delete":
                db.delete_node_by_mem_cube_id("A", "R")
            else:
                db.recover_memory_by_mem_cube_id("A", "R")
    finally:
        _query(admin, 'DROP TRIGGER record_fail ON memos_graph."Memory"')
        _query(admin, "DROP FUNCTION memos_graph.record_fail()")
    assert support.snapshot(admin) == before


@pytest.mark.parametrize("failure", [None, "x0500", "x1000"])
def test_hard_delete_record_three_blocks_is_atomic(stores, database, failure):
    db = stores()
    admin, _ = database
    support.seed_large(db, admin)
    assert db.delete_node_by_mem_cube_id("A", "R") == 1200
    before = support.snapshot(admin)
    if failure is None:
        assert db.delete_node_by_mem_cube_id("A", "R", True) == 1200
        assert support.snapshot(admin) == {"nodes": [], "edges": []}
    else:
        with support.failing_delete(admin, node_id=failure), pytest.raises(GraphDBError):
            db.delete_node_by_mem_cube_id("A", "R", True)
        assert support.snapshot(admin) == before


def test_soft_delete_fixed_set_leaves_concurrent_insert_for_next_call(stores, monkeypatch):
    db, writer = stores(), stores()
    seed(db)
    selected, resume = Event(), Event()

    def hook(stage, cursor, rows):
        if stage == "fetchall" and "FOR UPDATE" in cursor.statement:
            selected.set()
            assert resume.wait(8)

    with monkeypatch.context() as patch:
        support.observe(db, patch, hook)
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(db.delete_node_by_mem_cube_id, "A", "R")
            try:
                assert selected.wait(8)
                writer.add_node("late", "new", {"status": "activated"})
            finally:
                resume.set()
            assert pending.result(timeout=8) == 5
    assert db.get_node("late")["metadata"]["status"] == "activated"
    assert db.delete_node_by_mem_cube_id("A", "R") == 1
    assert db.recover_memory_by_mem_cube_id("A", "R") == 6


@pytest.mark.parametrize("operation", ["delete", "recover"])
def test_record_change_preserves_update_committed_while_waiting_for_row(
    stores, database, operation
):
    db, writer = stores(maxconn=1), stores(maxconn=1)
    admin, _ = database
    seed(db)
    if operation == "recover":
        db.delete_node_by_mem_cube_id("A", "R")
    node = writer.get_node("a")
    props = {
        **node["metadata"],
        "id": "a",
        "memory": node["memory"],
        "user_name": "A",
        "info": {"concurrent": "kept"},
    }
    raw = db.connection_pool.getconn()
    pid = _query(raw, "SELECT pg_backend_pid()")[0][0]
    raw.rollback()
    db.connection_pool.putconn(raw)
    update = writer.connection_pool.getconn()
    try:
        with update.cursor() as cursor:
            cursor.execute(
                'UPDATE memos_graph."Memory" SET properties=%s::ag_catalog.agtype WHERE scope=%s AND business_id=%s',
                (json.dumps(props), "A", "a"),
            )
        with ThreadPoolExecutor(max_workers=1) as executor:
            method = (
                db.delete_node_by_mem_cube_id
                if operation == "delete"
                else db.recover_memory_by_mem_cube_id
            )
            future = executor.submit(method, "A", "R")
            try:
                support.wait_until(
                    lambda: _query(
                        admin, "SELECT 1 FROM pg_locks WHERE pid=%s AND NOT granted", (pid,)
                    )
                )
            finally:
                update.commit()
            assert future.result(timeout=8) == 5
    finally:
        update.rollback()
        writer.connection_pool.putconn(update)
    assert db.get_node("a")["metadata"]["info"] == {"concurrent": "kept"}
    assert db.get_node("a", True)["metadata"]["embedding"] == [1, 0, 0]
