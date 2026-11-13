"""Real import round trips, rollback and fixed-set clearing."""

import os

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs import test_opengauss_capacity_integration as support
from tests.graph_dbs.test_opengauss_integration import _query


database, stores = support.database, support.stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


def fixture():
    return {
        "nodes": [
            {
                "id": key,
                "memory": "星港 " + key,
                "metadata": {
                    "memory_type": "WorkingMemory",
                    "status": state,
                    "embedding": [1, 0, 0],
                    "created_at": "2026-01-01T00:00:00Z",
                    "info": {"keep": [True, None, 3]},
                },
            }
            for key, state in [("a", "activated"), ("b", "archived"), ("c", "deleted")]
        ],
        "edges": [
            {"source": a, "target": b, "type": t}
            for a, b, t in [
                ("a", "b", "PARENT"),
                ("b", "a", "PARENT"),
                ("a", "a", "FOLLOWS"),
                ("a", "b", "RELATE"),
            ]
        ],
    }


def test_import_export_roundtrip_all_status_vectors_and_edges(stores, database):
    db = stores()
    data = fixture()
    data["edges"].append(deepcopy(data["edges"][0]))
    before = deepcopy(data)
    db.import_graph(data)
    assert data == before
    backup = db.export_graph(status=[], include_embedding=True)
    assert backup["total_nodes"] == 3 and backup["total_edges"] == 4
    assert sorted((e["source"], e["target"], e["type"]) for e in backup["edges"]) == [
        ("a", "a", "FOLLOWS"),
        ("a", "b", "PARENT"),
        ("a", "b", "RELATE"),
        ("b", "a", "PARENT"),
    ]
    db.add_node("a", "foreign", {}, user_name="B")
    foreign = db.get_node("a", user_name="B")
    db.clear()
    assert db.export_graph(status=[])["nodes"] == []
    db.import_graph(backup)
    assert db.export_graph(status=[], include_embedding=True) == backup
    assert db.get_node("a", user_name="B") == foreign
    support.visible(db, ["a"])
    db.drop_database()
    assert db.get_node("a", user_name="B") == foreign
    assert db.export_graph(status=[])["nodes"] == []
    db.import_graph({})


def test_upsert_preserves_graph_identity_and_file_external_data(stores, database):
    db = stores()
    admin, _ = database
    db.import_graph(fixture())
    old = support.snapshot(admin)
    db.import_graph(
        {
            "nodes": [{"id": "a", "memory": "replacement", "metadata": {"status": "activated"}}],
            "edges": [{"source": "a", "target": "c", "type": "NEW", "user_name": "A"}],
        }
    )
    new = support.snapshot(admin)
    assert new["nodes"][0][1] == old["nodes"][0][1]
    assert new["nodes"][1:] == old["nodes"][1:]
    assert db.get_node("a", True) == {
        "id": "a",
        "memory": "replacement",
        "metadata": {"status": "activated", "embedding": None},
    }
    assert db.export_graph(status=[])["total_edges"] == 5
    db.import_graph({"edges": [{"source": "b", "target": "c", "type": "EXISTING"}]})
    assert db.edge_exists("b", "c", "EXISTING")


def test_missing_endpoint_and_late_node_or_edge_sql_failure_roll_back(stores, database):
    db = stores()
    admin, _ = database
    db.import_graph(fixture())
    before = support.snapshot(admin)
    with pytest.raises(GraphDBError, match="endpoint"):
        db.import_graph(
            {
                "nodes": [{"id": "new", "memory": "x"}],
                "edges": [{"source": "new", "target": "missing", "type": "PARENT"}],
            }
        )
    assert support.snapshot(admin) == before
    _query(
        admin,
        """CREATE FUNCTION memos_graph.fail_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.business_id='z' THEN RAISE EXCEPTION 'import injection'; END IF; RETURN NEW; END $$""",
    )
    _query(
        admin,
        """CREATE TRIGGER fail_import BEFORE INSERT ON memos_graph."Memory" FOR EACH ROW EXECUTE PROCEDURE memos_graph.fail_import()""",
    )
    try:
        with pytest.raises(GraphDBError):
            db.import_graph(
                {"nodes": [{"id": "a", "memory": "changed"}, {"id": "z", "memory": "failure"}]}
            )
    finally:
        _query(admin, 'DROP TRIGGER fail_import ON memos_graph."Memory"')
        _query(admin, "DROP FUNCTION memos_graph.fail_import()")
    assert support.snapshot(admin) == before
    # A real AGE label permission failure happens after input nodes have been upserted.
    _, config = database
    from psycopg2 import sql

    _query(
        admin,
        sql.SQL('REVOKE INSERT ON memos_graph."PARENT" FROM {}').format(
            sql.Identifier(config.user)
        ),
    )
    try:
        with pytest.raises(GraphDBError):
            db.import_graph(
                {
                    "nodes": [{"id": "z", "memory": "new"}],
                    "edges": [{"source": "z", "target": "b", "type": "PARENT"}],
                }
            )
    finally:
        _query(
            admin,
            sql.SQL('GRANT INSERT ON memos_graph."PARENT" TO {}').format(
                sql.Identifier(config.user)
            ),
        )
    assert support.snapshot(admin) == before
    support.visible(db, ["a"])


@pytest.mark.parametrize("failure", [None, "x0500", "x1000", "timeout", "permission"])
def test_clear_three_blocks_rollback_and_search_visibility(stores, database, monkeypatch, failure):
    from psycopg2 import sql

    db = stores(maxconn=1)
    admin, config = database
    support.seed_large(db, admin)
    before = support.snapshot(admin)
    if failure is None:
        db.clear()
        assert support.snapshot(admin) == {"nodes": [], "edges": []}
        assert db.search_by_embedding([1, 0, 0]) == []
        assert db.search_by_fulltext(["批量"]) == []
        return
    if failure == "permission":
        _query(
            admin,
            sql.SQL('REVOKE DELETE ON memos_graph."Memory" FROM {}').format(
                sql.Identifier(config.user)
            ),
        )
        try:
            with pytest.raises(GraphDBError) as caught:
                db.clear()
            assert caught.value.__cause__.pgcode == "42501"
        finally:
            _query(
                admin,
                sql.SQL('GRANT DELETE ON memos_graph."Memory" TO {}').format(
                    sql.Identifier(config.user)
                ),
            )
    else:

        def hook(stage, cursor, rows):
            if (
                stage == "execute"
                and "pg_advisory_xact_lock" in cursor.statement
                and failure == "timeout"
            ):
                cursor.cursor.execute("SET LOCAL statement_timeout='500ms'")

        support.observe(db, monkeypatch, hook)
        with (
            support.failing_delete(
                admin,
                node_id="x1000" if failure == "timeout" else failure,
                action="PERFORM pg_sleep(2)"
                if failure == "timeout"
                else "RAISE EXCEPTION 'clear failure'",
            ),
            pytest.raises(GraphDBError) as caught,
        ):
            db.clear()
        assert caught.value.__cause__.pgcode == ("57014" if failure == "timeout" else "P0001")
    assert support.snapshot(admin) == before
    assert len(db.search_by_embedding([1, 0, 0], top_k=1300)) == 1200
    assert len(db.search_by_fulltext(["批量"], top_k=1300)) == 1200


def test_clear_fixed_set_excludes_later_insert_and_serializes_update(stores, database, monkeypatch):
    db, writer = stores(), stores()
    db.import_graph(fixture())
    selected, release = Event(), Event()

    def hook(stage, cursor, rows):
        if stage == "fetchall" and "FOR UPDATE" in cursor.statement:
            selected.set()
            assert release.wait(8)

    with monkeypatch.context() as patch:
        support.observe(db, patch, hook)
        with ThreadPoolExecutor(max_workers=2) as executor:
            clear = executor.submit(db.clear)
            try:
                assert selected.wait(8)
                writer.add_node("later", "new insertion", {})
                update = executor.submit(writer.add_node, "a", "rebuilt", {})
                assert not update.done()
            finally:
                release.set()
            clear.result(timeout=8)
            update.result(timeout=8)
    assert support.ids(db) == ["a", "later"]
    assert db.get_node("a")["memory"] == "rebuilt"
    assert db.get_edges("a") == []


@pytest.mark.parametrize("operation", ["import", "clear"])
@pytest.mark.parametrize("stage", ["before_commit", "after_commit", "putconn"])
def test_commit_uncertainty_is_observable_without_replay(
    stores, database, monkeypatch, operation, stage
):
    import psycopg2

    db = stores(maxconn=1)
    admin, _ = database
    db.import_graph(fixture())
    before = support.snapshot(admin)
    pool = db.connection_pool
    getconn, putconn = pool.getconn, pool.putconn
    calls = []
    error = psycopg2.OperationalError("synthetic commit confirmation loss")

    class Connection:
        def __init__(self, raw):
            self.raw = raw

        def __getattr__(self, name):
            return getattr(self.raw, name)

        def commit(self):
            calls.append("commit")
            if stage != "before_commit":
                self.raw.commit()
            if stage != "putconn":
                raise error

    def borrow():
        calls.append("borrow")
        return Connection(getconn())

    def release(connection, close=False):
        if stage == "putconn":
            raise error
        putconn(connection.raw, close=close)

    with monkeypatch.context() as patch:
        patch.setattr(pool, "getconn", borrow)
        patch.setattr(pool, "putconn", release)
        with pytest.raises(GraphDBError) as caught:
            if operation == "import":
                db.import_graph({"nodes": [{"id": "z", "memory": "committed"}]})
            else:
                db.clear()
        assert caught.value.__cause__ is error
    assert calls == ["borrow", "commit"]
    if stage == "before_commit":
        assert support.snapshot(admin) == before
    else:
        check = stores() if stage == "putconn" else db
        assert support.ids(check) == (["a", "b", "c", "z"] if operation == "import" else [])


@pytest.mark.parametrize("operation", ["clear", "hard_delete"])
def test_scoped_delete_actual_cancel_restores_data_and_replaces_connection(
    stores, database, operation
):
    db = stores(maxconn=1)
    admin, _ = database
    db.import_graph(fixture())
    if operation == "hard_delete":
        db.delete_node_by_mem_cube_id("A", "R")
    before = support.snapshot(admin)
    raw = db.connection_pool.getconn()
    pid = _query(raw, "SELECT pg_backend_pid()")[0][0]
    raw.rollback()
    db.connection_pool.putconn(raw)
    _query(admin, "SELECT pg_advisory_lock(621503, 9000)")
    try:
        with (
            support.failing_delete(
                admin, node_id="a", action="PERFORM pg_advisory_xact_lock(621503, 9000)"
            ),
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            future = (
                executor.submit(db.clear)
                if operation == "clear"
                else executor.submit(db.delete_node_by_mem_cube_id, "A", "R", True)
            )
            try:
                support.wait_until(
                    lambda: _query(
                        admin,
                        "SELECT 1 FROM pg_locks WHERE pid=%s AND locktype='advisory' AND NOT granted",
                        (pid,),
                    )
                )
                raw.cancel()
                with pytest.raises(GraphDBError) as caught:
                    future.result(timeout=8)
                assert caught.value.__cause__.pgcode == "57014"
            finally:
                _query(admin, "SELECT pg_advisory_unlock(621503, 9000)")
    finally:
        _query(admin, "SELECT pg_advisory_unlock_all()")
    assert raw.closed and support.snapshot(admin) == before
    if operation == "hard_delete":
        assert db.search_by_embedding([1, 0, 0]) == []
        assert db.search_by_fulltext(["星港"]) == []
        db.recover_memory_by_mem_cube_id("A", "R")
        assert db.get_node("a")["metadata"]["status"] == "activated"
        assert db.search_by_embedding([1, 0, 0])
        assert db.search_by_fulltext(["星港"])
        return
    support.visible(db, ["a"])


def test_physical_scope_clear_does_not_remove_named_cube(stores):
    db = stores(use_multi_db=True, user_name=None)
    db.import_graph(fixture())
    db.import_graph({"nodes": [{"id": "a", "memory": "named"}]}, user_name="A")
    db.drop_database()
    assert db.export_graph(status=[])["nodes"] == []
    assert db.get_node("a", user_name="A")["memory"] == "named"
