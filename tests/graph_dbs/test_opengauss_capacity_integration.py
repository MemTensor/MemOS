"""Public counts/capacity methods against AGE, DataVec and native BM25.

Uses only the UUID database and ordinary application role owned by the existing
integration fixtures. Expected business results are fixed independently of SQL.
"""

import math
import os
import threading
import time

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_integration import (
    _query,
)
from tests.graph_dbs.test_opengauss_integration import (
    database as _database,
)
from tests.graph_dbs.test_opengauss_integration import (
    stores as _stores,
)


database, stores = _database, _stores

pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)

TABLE = '"memos_graph"."Memory"'
WORKING = ["w1", "w2", "w3", "w4", "w5"]
GROUPS = [
    {"memory_type": "InsightMemory", "count": 1},
    {"memory_type": "LongTermMemory", "count": 3},
    {"memory_type": "UserMemory", "count": 1},
    {"memory_type": "WorkingMemory", "count": 5},
]


def seed(db, scope="A", only_working=False):
    rows = []
    times = [
        "2026-01-01T00:00:00",
        "2026-01-01T01:00:00",
        "2026-01-01T09:00:00+08:00",
        None,
        "2026-01-01T02:00:00",
    ]
    for node_id, instant in zip(WORKING, times, strict=True):
        metadata = {"memory_type": "WorkingMemory", "embedding": [1, 0, 0]}
        if instant is not None:
            metadata["updated_at"] = instant
        if node_id in {"w1", "w2"}:
            metadata["info"] = {"department": "研发部"}
        rows.append({"id": node_id, "memory": "星港 回归", "metadata": metadata})
    if not only_working:
        for node_id, kind, status in [
            ("l1", "LongTermMemory", "deleted"),
            ("l2", "LongTermMemory", "activated"),
            ("l3", "LongTermMemory", "archived"),
            ("u1", "UserMemory", "activated"),
            ("i1", "InsightMemory", "activated"),
        ]:
            metadata = {"memory_type": kind, "status": status, "updated_at": "2026-01-01T00:00:00Z"}
            if node_id == "l2":
                metadata["info"] = {"department": "研发部"}
            rows.append({"id": node_id, "memory": "计数 样例", "metadata": metadata})
    db.add_nodes_batch(rows, user_name=scope)
    if not only_working:
        db.add_edge("w1", "l2", "RELATE", user_name=scope)
        db.add_edge("w3", "w5", "FOLLOWS", user_name=scope)


def snapshot(admin, scope="A"):
    return {
        "nodes": _query(
            admin,
            f"SELECT business_id,id::text,memory,properties,embedding::text FROM ONLY {TABLE} WHERE scope=%s ORDER BY business_id",
            (scope,),
        ),
        "edges": _query(
            admin,
            'SELECT id::text,start_id::text,end_id::text,properties FROM "memos_graph"._ag_label_edge ORDER BY id',
        ),
    }


def ids(db, scope="A"):
    return db.get_by_metadata([], user_name=scope, status=None)


def visible(db, expected, scope="A"):
    vector = db.search_by_embedding(
        [1, 0, 0], scope="WorkingMemory", user_name=scope, top_k=100, threshold=None
    )
    text = db.search_by_fulltext(
        ["星港"], scope="WorkingMemory", user_name=scope, top_k=100, threshold=None
    )
    assert [row["id"] for row in vector] == expected
    assert [row["id"] for row in text] == expected
    assert all(row["score"] == pytest.approx(1, abs=1e-6) for row in vector)
    assert all(math.isfinite(row["score"]) and row["score"] > 0 for row in text)


@contextmanager
def failing_delete(admin, scope="A", node_id="w1", action="RAISE EXCEPTION 'capacity injection'"):
    from psycopg2 import sql

    _query(
        admin,
        sql.SQL(
            "CREATE FUNCTION memos_graph.capacity_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.scope={} AND OLD.business_id={} THEN "
        ).format(sql.Literal(scope), sql.Literal(node_id))
        + sql.SQL(action + "; END IF; RETURN OLD; END $$"),
    )
    _query(
        admin,
        f"CREATE TRIGGER capacity_fail BEFORE DELETE ON {TABLE} FOR EACH ROW EXECUTE PROCEDURE memos_graph.capacity_fail()",
    )
    try:
        yield
    finally:
        _query(admin, f"DROP TRIGGER capacity_fail ON {TABLE}")
        _query(admin, "DROP FUNCTION memos_graph.capacity_fail()")


def test_grouped_counts_full_results_and_scoped_predicates(stores):
    db = stores()
    seed(db)
    db.add_node(
        "w1",
        "星港 回归",
        {
            "memory_type": "WorkingMemory",
            "embedding": [1, 0, 0],
            "updated_at": "2026-01-01T00:00:00",
            "info": {"department": "研发部"},
        },
        user_name="B",
    )
    db.add_node(
        "l1",
        "计数 样例",
        {
            "memory_type": "LongTermMemory",
            "status": "activated",
            "updated_at": "2026-01-01T00:00:00Z",
        },
        user_name="B",
    )
    assert db.get_grouped_counts(["memory_type"]) == GROUPS
    assert db.get_grouped_counts(["memory_type"], user_name="B") == [
        {"memory_type": "LongTermMemory", "count": 1},
        {"memory_type": "WorkingMemory", "count": 1},
    ]
    assert db.get_grouped_counts(["memory_type"], user_name="K") == []
    assert db.get_grouped_counts(["memory_type", "status"]) == [
        {"memory_type": kind, "status": status, "count": count}
        for kind, status, count in [
            ("InsightMemory", "activated", 1),
            ("LongTermMemory", "activated", 1),
            ("LongTermMemory", "archived", 1),
            ("LongTermMemory", "deleted", 1),
            ("UserMemory", "activated", 1),
            ("WorkingMemory", None, 5),
        ]
    ]
    assert db.get_grouped_counts(["memory_type", "info.department"]) == [
        {"memory_type": kind, "info.department": department, "count": count}
        for kind, department, count in [
            ("InsightMemory", None, 1),
            ("LongTermMemory", "研发部", 1),
            ("LongTermMemory", None, 2),
            ("UserMemory", None, 1),
            ("WorkingMemory", "研发部", 2),
            ("WorkingMemory", None, 3),
        ]
    ]
    condition = "ag_catalog.agtype_access_operator(properties, '\"status\"'::ag_catalog.agtype) = %(status)s::ag_catalog.agtype"
    expected = [GROUPS[0], {"memory_type": "LongTermMemory", "count": 1}, GROUPS[2]]
    for predicate in [
        condition,
        "WHERE " + condition,
        condition + " OR " + condition,
        condition + " OR scope='B'",
    ]:
        assert (
            db.get_grouped_counts(["memory_type"], predicate, {"status": '"activated"'}) == expected
        )
    assert db.get_grouped_counts(["memory_type"], "scope=%(scope)s", {"scope": "B"}) == []
    assert db.get_grouped_counts(["memory_type"], "memory LIKE '%%'", {}) == GROUPS
    for kind, expected_count in [("LongTermMemory", 3), ("WorkingMemory", 5), ("SkillMemory", 0)]:
        count = db.get_memory_count(kind)
        missing = db.node_not_exist(kind)
        assert count == expected_count and type(count) is int
        assert missing == int(expected_count == 0) and type(missing) is int
    assert db.get_memory_count("WorkingMemory", user_name="B") == 1
    assert db.node_not_exist("UserMemory", user_name="B") == 1


def test_grouped_age_values_numeric_equivalence_and_many_groups(stores):
    db = stores()
    values = [
        {},
        {"v": None},
        {"v": 1},
        {"v": 1.0},
        {"v": "1"},
        {"v": True},
        {"v": [1]},
        {"v": {"a": 1}},
    ]
    db.add_nodes_batch(
        [
            {"id": f"j{i}", "memory": "", "metadata": {"info": value}}
            for i, value in enumerate(values)
        ]
    )
    result = db.get_grouped_counts(["info.v"])
    assert result == [
        {"info.v": value, "count": count}
        for value, count in [("1", 1), (1, 2), ([1], 1), (True, 1), ({"a": 1}, 1), (None, 2)]
    ]
    assert [type(row["info.v"]) for row in result] == [str, int, list, bool, dict, type(None)]
    db.add_nodes_batch(
        [
            {"id": f"n{i}", "memory": "", "metadata": {"info": {"v": value}, "status": "p"}}
            for i, value in enumerate([1, 1.0, [1], [1.0], {"a": 1}, {"a": 1.0}])
        ],
        user_name="N",
    )
    nested = db.get_grouped_counts(["info.v", "status"], user_name="N")
    assert nested == [
        {"info.v": value, "status": "p", "count": 2} for value in [1, [1.0], {"a": 1.0}]
    ]
    assert type(nested[0]["info.v"]) is int
    assert type(nested[1]["info.v"][0]) is float
    assert type(nested[2]["info.v"]["a"]) is float
    db.add_nodes_batch(
        [
            {"id": f"g{i:03}", "memory": "", "metadata": {"info": {"bucket": f"g{i:03}"}}}
            for i in range(105)
        ],
        user_name="G",
    )
    assert db.get_grouped_counts(["info.bucket"], user_name="G") == [
        {"info.bucket": f"g{i:03}", "count": 1} for i in range(105)
    ]


@pytest.mark.parametrize(
    "keep,retained,edges",
    [
        (0, [], 0),
        (1, ["w5"], 0),
        (2, ["w3", "w5"], 1),
        (5, WORKING, 2),
        (6, WORKING, 2),
        ("02", ["w3", "w5"], 1),
    ],
)
def test_capacity_retains_exact_nodes_edges_and_public_search(
    stores, database, keep, retained, edges
):
    db = stores()
    admin, _ = database
    seed(db)
    db.add_node(
        "w1",
        "星港 回归",
        {
            "memory_type": "WorkingMemory",
            "embedding": [1, 0, 0],
            "updated_at": "2026-01-01T00:00:00",
            "info": {"department": "研发部"},
        },
        user_name="B",
    )
    before = snapshot(admin)
    before_b = db.get_node("w1", include_embedding=True, user_name="B")
    visible(db, WORKING)
    visible(db, ["w1"], "B")
    assert db.remove_oldest_memory("WorkingMemory", keep) is None
    assert ids(db) == ["i1", "l1", "l2", "l3", "u1", *retained]
    after = snapshot(admin)
    assert after["nodes"] == [
        row for row in before["nodes"] if row[0] not in set(WORKING) - set(retained)
    ]
    assert len(after["edges"]) == edges
    graphids = {row[1] for row in after["nodes"]}
    assert after["edges"] == [
        edge for edge in before["edges"] if edge[1] in graphids and edge[2] in graphids
    ]
    assert [node["id"] for node in db.get_nodes(WORKING)] == retained
    assert [
        node["id"] for node in db.get_all_memory_items("WorkingMemory", status=None)
    ] == retained
    visible(db, retained)
    visible(db, ["w1"], "B")
    assert db.get_node("w1", include_embedding=True, user_name="B") == before_b


@pytest.mark.parametrize("keep", [0, 2, 6, 7])
def test_bad_time_is_checked_even_without_deletions(stores, database, keep):
    db = stores()
    admin, _ = database
    seed(db)
    db.add_node(
        "w6",
        "星港 回归",
        {"memory_type": "WorkingMemory", "updated_at": "not-a-time", "embedding": [1, 0, 0]},
    )
    before = snapshot(admin)
    with pytest.raises(GraphDBError) as caught:
        db.remove_oldest_memory("WorkingMemory", keep)
    assert caught.value.__cause__.pgcode == "22007"
    assert snapshot(admin) == before
    visible(db, [*WORKING, "w6"])


def test_all_statuses_occupy_capacity_and_equal_time_uses_id(stores):
    db = stores()
    statuses = ["activated", "resolving", "archived", "deleted", "missing", None]
    db.add_nodes_batch(
        [
            {
                "id": f"s{i}",
                "memory": "状态样例",
                "metadata": {
                    "memory_type": "WorkingMemory",
                    "updated_at": f"2026-01-0{i + 1}T00:00:00Z",
                    **({} if status == "missing" else {"status": status}),
                },
            }
            for i, status in enumerate(statuses)
        ]
    )
    assert db.get_memory_count("WorkingMemory") == 6
    assert db.node_not_exist("WorkingMemory") == 0
    assert db.get_grouped_counts(["status"]) == [
        {"status": value, "count": count}
        for value, count in [
            ("activated", 1),
            ("archived", 1),
            ("deleted", 1),
            ("resolving", 1),
            (None, 2),
        ]
    ]
    db.remove_oldest_memory("WorkingMemory", 3)
    assert ids(db) == ["s3", "s4", "s5"]
    assert db.get_memory_count("WorkingMemory") == 3
    assert db.node_not_exist("WorkingMemory") == 0
    assert db.get_grouped_counts(["status"]) == [
        {"status": "deleted", "count": 1},
        {"status": None, "count": 2},
    ]
    seed(db, "L")
    db.remove_oldest_memory("LongTermMemory", 1, user_name="L")
    assert ids(db, "L") == ["i1", "l3", "u1", *WORKING]


@pytest.mark.parametrize("value", [None, 3, True, [], {}])
def test_nonstring_time_is_oldest_and_null_ties_use_id(stores, value):
    db = stores()
    db.add_nodes_batch(
        [
            {
                "id": node_id,
                "memory": "",
                "metadata": {"memory_type": "WorkingMemory", "updated_at": value},
            }
            for node_id in ["a", "b"]
        ]
    )
    db.remove_oldest_memory("WorkingMemory", 1)
    assert ids(db) == ["b"]


def test_delete_failure_restores_edges_nodes_and_public_search(stores, database):
    db = stores()
    admin, _ = database
    seed(db)
    before = snapshot(admin)
    visible(db, WORKING)
    with failing_delete(admin), pytest.raises(GraphDBError) as caught:
        db.remove_oldest_memory("WorkingMemory", 2)
    assert caught.value.__cause__.pgcode == "P0001"
    assert snapshot(admin) == before
    visible(db, WORKING)


class ObservedCursor:
    """Forward every database operation; hooks observe real rows or inject faults."""

    def __init__(self, cursor, hook):
        self.cursor = cursor
        self.hook = hook
        self.statement = None
        self.params = None

    def __enter__(self):
        self.cursor.__enter__()
        return self

    def __exit__(self, *args):
        return self.cursor.__exit__(*args)

    def execute(self, statement, params=None):
        self.statement, self.params = statement, params
        result = self.cursor.execute(statement, params)
        self.hook("execute", self, None)
        return result

    def fetchall(self):
        rows = self.cursor.fetchall()
        self.hook("fetchall", self, rows)
        return rows

    def __getattr__(self, name):
        return getattr(self.cursor, name)


class ObservedConnection:
    def __init__(self, connection, hook):
        self.connection = connection
        self.hook = hook

    def cursor(self):
        return ObservedCursor(self.connection.cursor(), self.hook)


def observe(db, monkeypatch, hook):
    original = db._get_connection

    @contextmanager
    def connection():
        with original() as raw:
            yield ObservedConnection(raw, hook)

    monkeypatch.setattr(db, "_get_connection", connection)


def raw_setting(db, setting):
    connection = db.connection_pool.getconn()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SHOW " + setting)
            return cursor.fetchone()[0]
    finally:
        connection.rollback()
        db.connection_pool.putconn(connection)


def test_groupaggregate_plan_and_setting_restored_on_success_and_failure(
    stores, monkeypatch, record_property
):
    db = stores(maxconn=1)
    db.add_nodes_batch(
        [
            {"id": "int", "memory": "", "metadata": {"info": {"v": 1}}},
            {"id": "float", "memory": "", "metadata": {"info": {"v": 1.0}}},
        ]
    )
    assert raw_setting(db, "enable_hashagg") == "on"
    plans = []

    def hook(stage, cursor, rows):
        if stage == "fetchall" and "GROUP BY" in cursor.statement:
            with cursor.connection.cursor() as check:
                check.execute("SHOW enable_hashagg")
                assert check.fetchone() == ("off",)
                check.execute("EXPLAIN " + cursor.statement, cursor.params)
                plans.extend(row[0] for row in check.fetchall())

    observe(db, monkeypatch, hook)
    assert db.get_grouped_counts(["info.v"]) == [{"info.v": 1, "count": 2}]
    assert any("GroupAggregate" in line for line in plans)
    assert not any("HashAggregate" in line for line in plans)
    record_property("group_plan", "\n".join(plans))
    assert raw_setting(db, "enable_hashagg") == "on"
    with pytest.raises(GraphDBError) as caught:
        db.get_grouped_counts(["info.v"], "nonexistent_column = 1")
    assert caught.value.__cause__.pgcode == "42703"
    assert raw_setting(db, "enable_hashagg") == "on"


def seed_large(db, admin):
    db.add_nodes_batch(
        [
            {
                "id": f"x{i:04}",
                "memory": "批量样例",
                "metadata": {
                    "memory_type": "WorkingMemory",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "embedding": [1, 0, 0],
                },
            }
            for i in range(1200)
        ]
    )
    # Native label already belongs to this test's graph. Bulk edge fixture
    # avoids 1199 independent transactions while retaining real graph IDs.
    db.add_edge("x0000", "x0000", "RELATE")
    _query(
        admin,
        f"INSERT INTO memos_graph.\"RELATE\"(start_id,end_id,properties) SELECT a.id,b.id,'{{}}'::ag_catalog.agtype FROM ONLY {TABLE} a JOIN ONLY {TABLE} b ON b.scope=a.scope AND substring(b.business_id,2)::int=substring(a.business_id,2)::int+1 WHERE a.scope=%s",
        ("A",),
    )


@pytest.mark.parametrize("failure", [None, "x0500", "x1000", "timeout"])
def test_three_delete_blocks_are_atomic_and_timeout_replaces_session(
    stores, database, monkeypatch, record_property, failure
):
    db = stores(maxconn=1)
    admin, _ = database
    seed_large(db, admin)
    before = snapshot(admin)
    assert len(before["nodes"]) == 1200 and len(before["edges"]) == 1200
    assert db.get_memory_count("WorkingMemory") == 1200
    connection = db.connection_pool.getconn()
    old_pid = _query(connection, "SELECT pg_backend_pid()")[0][0]
    old_session = _query(
        admin, "SELECT pid,backend_start FROM pg_stat_activity WHERE pid=%s", (old_pid,)
    )
    connection.rollback()
    db.connection_pool.putconn(connection)
    blocks = []
    plans = []

    def hook(stage, cursor, rows):
        if (
            stage == "execute"
            and cursor.statement == "SET LOCAL TIME ZONE 'UTC'"
            and failure == "timeout"
        ):
            cursor.cursor.execute("SET LOCAL statement_timeout = '2000ms'")
        if stage == "execute" and cursor.statement.startswith("DELETE FROM ONLY"):
            blocks.append(len(cursor.params["ids"]))
        if stage == "fetchall" and "NULLS LAST" in cursor.statement:
            with cursor.connection.cursor() as check:
                check.execute("EXPLAIN " + cursor.statement, cursor.params)
                plans.extend(row[0] for row in check.fetchall())

    observe(db, monkeypatch, hook)
    start = time.monotonic()
    if failure is None:
        db.remove_oldest_memory("WorkingMemory", 100)
        assert ids(db) == [f"x{i:04}" for i in range(1100, 1200)]
        after = snapshot(admin)
        assert after["nodes"] == before["nodes"][1100:]
        retained_graphids = {row[1] for row in after["nodes"]}
        assert after["edges"] == [
            edge
            for edge in before["edges"]
            if edge[1] in retained_graphids and edge[2] in retained_graphids
        ]
        assert len(after["edges"]) == 99
        assert blocks == [500, 500, 100]
        assert db.get_memory_count("WorkingMemory") == 100
    else:
        action = (
            "PERFORM pg_sleep(10)"
            if failure == "timeout"
            else "RAISE EXCEPTION 'capacity injection'"
        )
        node_id = "x1000" if failure == "timeout" else failure
        with (
            failing_delete(admin, node_id=node_id, action=action),
            pytest.raises(GraphDBError) as caught,
        ):
            db.remove_oldest_memory("WorkingMemory", 100)
        assert caught.value.__cause__.pgcode == ("57014" if failure == "timeout" else "P0001")
        assert blocks == ([500] if failure == "x0500" else [500, 500])
        assert snapshot(admin) == before
        assert db.get_memory_count("WorkingMemory") == 1200
        new = db.connection_pool.getconn()
        try:
            new_pid = _query(new, "SELECT pg_backend_pid()")[0][0]
            new_session = _query(
                admin, "SELECT pid,backend_start FROM pg_stat_activity WHERE pid=%s", (new_pid,)
            )
            # openGauss can immediately reuse the server thread identifier.
            # The closed driver object and new backend_start identify replacement.
            assert old_session and new_session
            assert (new_session != old_session) == (failure == "timeout")
            assert (new is not connection) == (failure == "timeout")
            assert bool(connection.closed) == (failure == "timeout")
        finally:
            new.rollback()
            db.connection_pool.putconn(new)
    record_property("elapsed_seconds", time.monotonic() - start)
    record_property("ranking_plan", "\n".join(plans))


def wait_until(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    pytest.fail("Database synchronization deadline exceeded")


@pytest.mark.parametrize("mode", ["insert", "update", "upsert"])
def test_fixed_locked_set_with_real_concurrent_writers(stores, database, monkeypatch, mode):
    db, writer = stores(maxconn=1), stores(maxconn=1)
    admin, _ = database
    seed(db)
    before = snapshot(admin)
    locked, release = threading.Event(), threading.Event()

    def hook(stage, cursor, rows):
        if stage == "fetchall" and "FOR UPDATE" in cursor.statement:
            assert rows == [(key,) for key in WORKING]
            locked.set()
            assert release.wait(8), "Trim barrier timed out"

    observe(db, monkeypatch, hook)
    # Record PID before SQL can block, using the already-owned idle session.
    connection = writer.connection_pool.getconn()
    pid = _query(connection, "SELECT pg_backend_pid()")[0][0]
    connection.rollback()
    writer.connection_pool.putconn(connection)

    def write():
        if mode == "update":
            writer.update_node("w3", {"memory": "更新后正文"})
        else:
            writer.add_node(
                "w0" if mode == "insert" else "w1",
                "重建后正文",
                {
                    "memory_type": "WorkingMemory",
                    "updated_at": "2000-01-01T00:00:00Z",
                    "embedding": [1, 0, 0],
                },
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        trim = executor.submit(db.remove_oldest_memory, "WorkingMemory", 2)
        try:
            assert locked.wait(8), "Trim did not lock its set"
            writing = executor.submit(write)
            if mode == "insert":
                writing.result(timeout=8)
            else:
                wait_until(
                    lambda: _query(
                        admin, "SELECT 1 FROM pg_locks WHERE pid=%s AND NOT granted", (pid,)
                    )
                )
                assert not writing.done()
        finally:
            release.set()
        trim.result(timeout=8)
        writing.result(timeout=8)
    expected = {"insert": ["w0", "w3", "w5"], "update": ["w3", "w5"], "upsert": ["w1", "w3", "w5"]}[
        mode
    ]
    assert ids(db) == ["i1", "l1", "l2", "l3", "u1", *expected]
    after = snapshot(admin)
    assert len(after["edges"]) == 1
    graphids = {row[1] for row in after["nodes"]}
    assert after["edges"] == [
        edge for edge in before["edges"] if edge[1] in graphids and edge[2] in graphids
    ]
    old = {row[0]: row for row in before["nodes"]}
    new = {row[0]: row for row in after["nodes"]}
    if mode == "update":
        assert new["w3"][1] == old["w3"][1] and new["w3"][2] == "更新后正文"
    elif mode == "upsert":
        assert new["w1"][1] != old["w1"][1] and new["w1"][2] == "重建后正文"
    else:
        # Remove the one-shot observer before the second, independent trim.
        monkeypatch.undo()
        db.remove_oldest_memory("WorkingMemory", 2)
        assert ids(db) == ["i1", "l1", "l2", "l3", "u1", "w3", "w5"]


@pytest.mark.parametrize("stage", ["before_commit", "after_commit", "putconn"])
def test_commit_acknowledgement_and_return_failures_have_distinct_side_effects(
    stores, database, monkeypatch, stage
):
    import psycopg2

    db = stores(maxconn=1)
    admin, _ = database
    seed(db)
    before = snapshot(admin)
    pool = db.connection_pool
    getconn, putconn = pool.getconn, pool.putconn
    counts = {"borrow": 0, "commit": 0}
    original = psycopg2.OperationalError("synthetic commit acknowledgement loss")

    class CommitConnection:
        def __init__(self, raw):
            self.raw = raw

        def __getattr__(self, name):
            return getattr(self.raw, name)

        def commit(self):
            counts["commit"] += 1
            if stage != "before_commit":
                self.raw.commit()
            if stage != "putconn":
                raise original

    def borrow():
        counts["borrow"] += 1
        return CommitConnection(getconn())

    def give_back(connection, close=False):
        if stage == "putconn":
            raise original
        putconn(connection.raw, close=close)

    with monkeypatch.context() as patch:
        patch.setattr(pool, "getconn", borrow)
        patch.setattr(pool, "putconn", give_back)
        with pytest.raises(GraphDBError) as caught:
            db.remove_oldest_memory("WorkingMemory", 2)
        assert caught.value.__cause__ is original
        assert counts == {"borrow": 1, "commit": 1}
        assert db._closed == (stage == "putconn")
    after = snapshot(admin)
    if stage == "before_commit":
        assert after == before
        visible(db, WORKING)
    else:
        assert after["nodes"] == [
            row for row in before["nodes"] if row[0] not in {"w1", "w2", "w4"}
        ]
        graphids = {row[1] for row in after["nodes"]}
        assert after["edges"] == [
            edge for edge in before["edges"] if edge[1] in graphids and edge[2] in graphids
        ]
        assert len(after["edges"]) == 1
        check = stores(maxconn=1) if stage == "putconn" else db
        visible(check, ["w3", "w5"])


def test_real_query_cancel_rolls_back_and_discards_original_session(stores, database, monkeypatch):
    db = stores(maxconn=1)
    admin, _ = database
    seed(db)
    before = snapshot(admin)
    connection = db.connection_pool.getconn()
    pid = _query(connection, "SELECT pg_backend_pid()")[0][0]
    connection.rollback()
    db.connection_pool.putconn(connection)
    old_session = _query(
        admin, "SELECT pid,backend_start FROM pg_stat_activity WHERE pid=%s", (pid,)
    )
    _query(admin, "SELECT pg_advisory_lock(621503, 9000)")

    def hook(stage, cursor, rows):
        if stage == "execute" and cursor.statement == "SET LOCAL TIME ZONE 'UTC'":
            cursor.cursor.execute("SET LOCAL statement_timeout = '10000ms'")

    observe(db, monkeypatch, hook)
    try:
        with (
            failing_delete(admin, action="PERFORM pg_advisory_xact_lock(621503, 9000)"),
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            operation = executor.submit(db.remove_oldest_memory, "WorkingMemory", 2)
            try:
                wait_until(
                    lambda: _query(
                        admin,
                        "SELECT 1 FROM pg_locks WHERE pid=%s AND locktype='advisory' AND NOT granted",
                        (pid,),
                    )
                )
                connection.cancel()
                with pytest.raises(GraphDBError) as caught:
                    operation.result(timeout=8)
                assert caught.value.__cause__.pgcode == "57014"
            finally:
                _query(admin, "SELECT pg_advisory_unlock(621503, 9000)")
    finally:
        _query(admin, "SELECT pg_advisory_unlock_all()")
    assert snapshot(admin) == before
    assert connection.closed
    visible(db, WORKING)
    replacement = db.connection_pool.getconn()
    try:
        replacement_pid = _query(replacement, "SELECT pg_backend_pid()")[0][0]
        new_session = _query(
            admin, "SELECT pid,backend_start FROM pg_stat_activity WHERE pid=%s", (replacement_pid,)
        )
        assert old_session and new_session and old_session != new_session
        assert replacement is not connection
    finally:
        replacement.rollback()
        db.connection_pool.putconn(replacement)


def test_physical_scope_and_unknown_group_fields_are_not_remapped(stores):
    db = stores(user_name=None, use_multi_db=True)
    db.add_node("p", "", {"memory_type": "WorkingMemory", "info": {"custom": "nested", "count": 2}})
    db.add_node("p", "", {"memory_type": "WorkingMemory"}, user_name="B")
    assert db.get_grouped_counts(["custom", "info.custom", "info.count"]) == [
        {"custom": None, "info.custom": "nested", "info.count": 2, "count": 1}
    ]
    assert db.get_memory_count("WorkingMemory") == 1
    assert db.node_not_exist("WorkingMemory") == 0
    db.remove_oldest_memory("WorkingMemory", 0)
    assert db.get_grouped_counts(["memory_type"]) == []
    assert db.node_not_exist("WorkingMemory") == 1
    assert db.get_memory_count("WorkingMemory", user_name="B") == 1
