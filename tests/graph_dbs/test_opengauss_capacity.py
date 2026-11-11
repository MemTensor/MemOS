"""Counts/capacity contracts: validation, bound SQL and transaction failures."""

import inspect
import json
import sys

from copy import deepcopy
from datetime import datetime

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


pool_case = _pool_case

CALLS = [
    ("get_grouped_counts", (["memory_type"],)),
    ("get_memory_count", ("WorkingMemory",)),
    ("node_not_exist", ("WorkingMemory",)),
    ("remove_oldest_memory", ("WorkingMemory", 2)),
]


@pytest.fixture
def capacity(pool_case):
    _, db, pool, connection, _ = pool_case
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = []
    cursor.fetchone.return_value = (0,)
    return db, pool, connection, cursor


@pytest.mark.parametrize("method,args", CALLS)
def test_closed_precedes_validation(capacity, method, args):
    db, pool, _, _ = capacity
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        getattr(db, method)(*args, user_name="\0")
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("method,args", CALLS)
@pytest.mark.parametrize("scope", ["", " ", 1, False, "A\0"])
def test_invalid_scope_before_borrow(capacity, method, args, scope):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        getattr(db, method)(*args, user_name=scope)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("method,args", CALLS[1:])
@pytest.mark.parametrize("kind", [None, "", " ", 1, False, "WorkingMemory\0"])
def test_invalid_memory_type_before_borrow(capacity, method, args, kind):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        getattr(db, method)(kind, *args[1:])
    pool.getconn.assert_not_called()


@pytest.mark.parametrize(
    "fields",
    [
        None,
        [],
        (),
        "memory_type",
        [1],
        [None],
        [[]],
        ["memory_type", "memory_type"],
        ["count"],
        ["a.b"],
        ["info.a.b"],
        ["类型"],
        ["a;"],
        ["a\0"],
        ["1bad"],
    ],
)
def test_invalid_group_fields_before_borrow(capacity, fields):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.get_grouped_counts(fields)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize(
    "where,params",
    [
        (1, None),
        (False, None),
        (";", None),
        ("true -- comment", None),
        ("true /* comment */", None),
        ("\0", None),
        ("x=%s", None),
        ("x=%(x)d", {"x": 1}),
        ("%", None),
        ("%(bad-key)s", {"bad-key": 1}),
        ("%(x)s", None),
        ("", {"x": 1}),
        ("", []),
        ("", {1: 1}),
        ("%(memos_scope)s", {"memos_scope": "B"}),
        ("%(memos_x)s", {"memos_x": 1}),
        ("%(x)s", {"x": []}),
        ("%(x)s", {"x": {}}),
        ("%(x)s", {"x": b"x"}),
        ("%(x)s", {"x": datetime(2026, 1, 1)}),
        ("%(x)s", {"x": object()}),
        ("%(x)s", {"x": float("inf")}),
        ("%(x)s", {"x": float("nan")}),
        ("%(x)s", {"x": "a\0"}),
    ],
)
def test_invalid_predicate_before_borrow(capacity, where, params):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.get_grouped_counts(["memory_type"], where, params)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("where", [None, "", "  ", "WHERE", "  wHeRe  "])
def test_empty_predicate_and_empty_groups(capacity, where):
    db, _, connection, cursor = capacity
    assert db.get_grouped_counts(["memory_type"], where) == []
    statement, params = cursor.execute.call_args.args
    assert isinstance(params, dict) and params["memos_scope"] == "A"
    assert "AND ()" not in statement
    cursor.execute.assert_any_call("SET LOCAL enable_hashagg = off")
    connection.commit.assert_called_once()


@pytest.mark.parametrize("value", [None, True, 1, 1.5, "bound'", 10**400])
def test_named_bindings_keep_predicate_grouping_and_inputs(capacity, value):
    db, _, _, cursor = capacity
    fields = ["memory_type", "info.count", "unknown"]
    params = {"x": value}
    before = deepcopy((fields, params))
    predicate = "business_id = %(x)s OR scope = %(x)s OR memory LIKE '100%%'"
    db.get_grouped_counts(fields, " wHeRe " + predicate, params, "B'")
    statement, bound = cursor.execute.call_args.args
    assert f"AND ({predicate})" in statement
    assert bound["memos_scope"] == "B'" and bound["x"] == value
    assert "B'" not in statement and "memory_type" not in statement
    assert all(key == "x" or key.startswith("memos_") for key in bound)
    assert "GROUP BY" in statement and 'COLLATE "C"' in statement
    assert (fields, params) == before


def test_where_prefix_requires_word_boundary(capacity):
    db, _, _, cursor = capacity
    db.get_grouped_counts(["info.x"], "WHEREVER")
    assert "AND (WHEREVER)" in cursor.execute.call_args.args[0]


def test_group_decoding_preserves_json_types_and_age_decimals(capacity):
    db, _, _, cursor = capacity
    cursor.fetchall.return_value = [
        ('"1"', 1),
        ("1", 2),
        ('[.8, -.8, "text .8"]', 1),
        ("true", 1),
        ('{"a": 1.0}', 1),
        (None, 2),
    ]
    result = db.get_grouped_counts(["info.v"])
    assert result == [
        {"info.v": "1", "count": 1},
        {"info.v": 1, "count": 2},
        {"info.v": [0.8, -0.8, "text .8"], "count": 1},
        {"info.v": True, "count": 1},
        {"info.v": {"a": 1.0}, "count": 1},
        {"info.v": None, "count": 2},
    ]
    assert [type(row["info.v"]) for row in result] == [str, int, list, bool, dict, type(None)]
    assert all(type(row["count"]) is int for row in result)


@pytest.mark.parametrize("payload", ["{", "not-json", 12, "NaN", "Infinity", "-Infinity", "[NaN]"])
def test_corrupt_group_result_rolls_back(capacity, payload):
    db, pool, connection, cursor = capacity
    cursor.fetchall.return_value = [(payload, 1)]
    with pytest.raises(GraphDBError) as caught:
        db.get_grouped_counts(["info.x"])
    assert isinstance(caught.value.__cause__, TypeError | ValueError)
    connection.commit.assert_not_called()
    assert connection.rollback.call_count == 2
    pool.putconn.assert_called_once_with(connection, close=False)


@pytest.mark.parametrize(
    "method,raw,expected",
    [
        ("get_memory_count", 3, 3),
        ("get_memory_count", 0, 0),
        ("node_not_exist", 3, 0),
        ("node_not_exist", 0, 1),
    ],
)
def test_counts_include_every_status_and_bind_exact_type(capacity, method, raw, expected):
    db, _, _, cursor = capacity
    cursor.fetchone.return_value = (raw,)
    result = getattr(db, method)(" WorkingMemory ", user_name="B'")
    assert result == expected and type(result) is int
    statement, params = cursor.execute.call_args.args
    assert "status" not in statement and "B'" not in statement
    assert "B'" in params.values() and json.dumps(" WorkingMemory ") in params.values()


@pytest.mark.parametrize(
    "keep", [-1, True, False, 1.5, None, "", " ", "+2", "-1", "٢", "２", "2 ", "0" * 5000]
)
def test_invalid_capacity_before_borrow(capacity, keep):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.remove_oldest_memory("WorkingMemory", keep)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("keep", ["0" * 65, "9" * 65, "0" * 5000])
def test_capacity_string_limit_is_independent_of_interpreter(capacity, keep):
    db, pool, _, _ = capacity
    previous = sys.get_int_max_str_digits()
    try:
        sys.set_int_max_str_digits(0)
        with pytest.raises(ValueError, match="64"):
            db.remove_oldest_memory("WorkingMemory", keep)
    finally:
        sys.set_int_max_str_digits(previous)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize(
    "keep",
    ["0" * 64, "9" * 64, "02", 10**5000],
    ids=["zeros", "digits", "leading-zero", "large-int"],
)
def test_capacity_text_boundary_and_unbounded_integer_remain_valid(capacity, keep):
    db, pool, _, _ = capacity
    db.remove_oldest_memory("WorkingMemory", keep)
    pool.getconn.assert_called_once()


@pytest.mark.parametrize(
    "keep,deleted",
    [
        (0, ["w1", "w2", "w3"]),
        ("0", ["w1", "w2", "w3"]),
        ("02", ["w1"]),
        (2, ["w1"]),
        (3, []),
        (10**100, []),
    ],
)
def test_capacity_ranks_full_locked_set_before_slicing(capacity, keep, deleted):
    db, _, connection, cursor = capacity
    cursor.fetchall.side_effect = [[("w1",), ("w2",), ("w3",)], [("w3",), ("w2",), ("w1",)], []]
    assert db.remove_oldest_memory("WorkingMemory", keep) is None
    calls = [call.args for call in cursor.execute.call_args_list]
    assert ("SELECT pg_advisory_xact_lock(621503, %(lock)s)", {"lock": 2}) in calls
    assert ("SET LOCAL TIME ZONE 'UTC'",) in calls
    ranked = [(s, p) for s, *rest in calls if "NULLS LAST" in s for p in rest]
    assert len(ranked) == 1
    assert "ANY(%(ids)s)" in ranked[0][0] and "LIMIT" not in ranked[0][0]
    assert ["w1", "w2", "w3"] in ranked[0][1].values()
    deletes = [args for args in calls if args[0].startswith("DELETE FROM ONLY")]
    assert [args[1]["ids"] for args in deletes] == ([deleted] if deleted else [])
    connection.commit.assert_called_once()


def test_capacity_empty_set_and_physical_scope(capacity):
    db, _, connection, cursor = capacity
    db.config.user_name = None
    db.config.use_multi_db = True
    db.remove_oldest_memory("WorkingMemory", 0)
    assert not any("NULLS LAST" in c.args[0] for c in cursor.execute.call_args_list)
    assert cursor.execute.call_args.args[1]["scope"] == ""
    connection.commit.assert_called_once()


def test_capacity_chunks_are_sorted_and_share_one_transaction(capacity):
    db, _, connection, cursor = capacity
    ids = [f"x{i:04}" for i in range(1200)]
    cursor.fetchall.side_effect = [[(i,) for i in ids], [(i,) for i in reversed(ids)], [], [], []]
    db.remove_oldest_memory("WorkingMemory", 100)
    deletes = [
        c.args[1]["ids"]
        for c in cursor.execute.call_args_list
        if c.args[0].startswith("DELETE FROM ONLY")
    ]
    assert deletes == [ids[:500], ids[500:1000], ids[1000:1100]]
    bodies = [c.args[0] for c in cursor.execute.call_args_list if c.args[0].startswith("PREPARE")]
    assert len(bodies) == 3 and all("-[r]->" in b and "DELETE r" in b for b in bodies)
    connection.commit.assert_called_once()


@pytest.mark.parametrize("method,args", CALLS)
@pytest.mark.parametrize("stage", ["cursor", "execute", "fetch", "commit", "putconn"])
def test_method_failures_preserve_cause_and_never_retry(capacity, method, args, stage):
    import psycopg2

    db, pool, connection, cursor = capacity
    error = psycopg2.ProgrammingError("synthetic failure")
    if stage == "cursor":
        connection.cursor.side_effect = error
    elif stage == "execute":
        cursor.execute.side_effect = error
    elif stage == "fetch":
        cursor.fetchall.side_effect = error
        cursor.fetchone.side_effect = error
    elif stage == "commit":
        connection.commit.side_effect = error
    else:
        pool.putconn.side_effect = error
    with pytest.raises(GraphDBError) as caught:
        getattr(db, method)(*args)
    assert caught.value.__cause__ is error
    assert pool.getconn.call_count == 1 and connection.commit.call_count <= 1
    assert db._active == 0
    assert db._closed == (stage == "putconn")


def test_public_signatures(capacity):
    db, _, _, _ = capacity
    assert list(inspect.signature(db.get_grouped_counts).parameters) == [
        "group_fields",
        "where_clause",
        "params",
        "user_name",
    ]
    assert list(inspect.signature(db.get_memory_count).parameters) == ["memory_type", "user_name"]
    assert list(inspect.signature(db.node_not_exist).parameters) == ["scope", "user_name"]
    assert list(inspect.signature(db.remove_oldest_memory).parameters) == [
        "memory_type",
        "keep_latest",
        "user_name",
    ]


@pytest.mark.parametrize(
    "stage",
    [
        "lock",
        "lock_fetch",
        "rank",
        "rank_fetch",
        "deallocate_all",
        "prepare",
        "cypher",
        "cypher_fetch",
        "deallocate",
        "delete1",
        "delete2",
        "delete3",
    ],
)
def test_capacity_sql_failpoints_rollback_all_blocks(capacity, stage):
    import psycopg2

    db, pool, connection, cursor = capacity
    error = psycopg2.ProgrammingError("capacity failpoint")
    current = None
    deletes = 0
    keys = [f"x{i:04}" for i in range(1200)]

    def execute(statement, params=None):
        nonlocal current, deletes
        current = statement
        point = None
        if "FOR UPDATE" in statement:
            point = "lock"
        elif "NULLS LAST" in statement:
            point = "rank"
        elif statement == "DEALLOCATE ALL":
            point = "deallocate_all"
        elif statement.startswith("PREPARE"):
            point = "prepare"
        elif statement.startswith("EXECUTE memos_age"):
            point = "cypher"
        elif statement == "DEALLOCATE memos_age":
            point = "deallocate"
        elif statement.startswith("DELETE FROM ONLY"):
            deletes += 1
            point = f"delete{deletes}"
        if point == stage:
            raise error

    def fetch():
        if "FOR UPDATE" in current:
            point, result = "lock_fetch", [(key,) for key in keys]
        elif "NULLS LAST" in current:
            point, result = "rank_fetch", [(key,) for key in reversed(keys)]
        else:
            point, result = "cypher_fetch", []
        if point == stage:
            raise error
        return result

    cursor.execute.side_effect = execute
    cursor.fetchall.side_effect = fetch
    with pytest.raises(GraphDBError) as caught:
        db.remove_oldest_memory("WorkingMemory", 100)
    assert caught.value.__cause__ is error
    connection.commit.assert_not_called()
    assert connection.rollback.call_count == 2
    pool.putconn.assert_called_once_with(connection, close=False)
    assert pool.getconn.call_count == 1


@pytest.mark.parametrize("method,args", CALLS)
@pytest.mark.parametrize("cleanup", ["none", "rollback", "putconn", "both"])
def test_original_operation_error_survives_cleanup_failures(capacity, method, args, cleanup):
    import psycopg2

    db, pool, connection, cursor = capacity
    error = psycopg2.errors.QueryCanceled("query canceled")
    cursor.fetchall.side_effect = error
    cursor.fetchone.side_effect = error
    if cleanup in {"rollback", "both"}:
        connection.rollback.side_effect = [None, psycopg2.OperationalError("rollback failed")]
    if cleanup in {"putconn", "both"}:
        pool.putconn.side_effect = psycopg2.InterfaceError("return failed")
    with pytest.raises(GraphDBError) as caught:
        getattr(db, method)(*args)
    assert caught.value.__cause__ is error
    connection.commit.assert_not_called()
    pool.putconn.assert_called_once_with(connection, close=True)
    assert db._closed == (cleanup in {"putconn", "both"})
