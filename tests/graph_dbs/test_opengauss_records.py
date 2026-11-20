"""Ownership and deletion record inputs, failures and exact results."""

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity import capacity as _capacity
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


capacity, pool_case = _capacity, _pool_case
CALLS = [
    ("get_user_names_by_memory_ids", (["a"],)),
    ("exist_user_name", ("A",)),
    ("delete_node_by_mem_cube_id", ("A", "r")),
    ("recover_memory_by_mem_cube_id", ("A", "r")),
]


@pytest.mark.parametrize("method,args", CALLS)
def test_closed_record_methods_do_not_borrow(capacity, method, args):
    db, pool, _, _ = capacity
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        getattr(db, method)(*args)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize(
    "method,args",
    [
        ("get_user_names_by_memory_ids", (None,)),
        ("get_user_names_by_memory_ids", (["a\0"],)),
        ("exist_user_name", (None,)),
        ("exist_user_name", ("",)),
        ("delete_node_by_mem_cube_id", (None, "r")),
        ("delete_node_by_mem_cube_id", ("A", "")),
        ("delete_node_by_mem_cube_id", ("A", "r", 1)),
        ("delete_node_by_mem_cube_id", ("A", "r", None)),
        ("recover_memory_by_mem_cube_id", ("A", "r\0")),
    ],
)
def test_record_validation_precedes_borrow(capacity, method, args):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        getattr(db, method)(*args)
    pool.getconn.assert_not_called()


def test_ownership_empty_unique_missing_and_ambiguous(capacity):
    db, pool, _, cursor = capacity
    assert db.get_user_names_by_memory_ids([]) == {}
    pool.getconn.assert_not_called()
    cursor.fetchall.return_value = [("a", ""), ("b", "B")]
    inputs = ["b", "a", "missing", "a"]
    assert db.get_user_names_by_memory_ids(inputs) == {"b": "B", "a": "", "missing": None}
    assert inputs == ["b", "a", "missing", "a"]
    cursor.fetchall.return_value = [("a", "A"), ("a", "B")]
    with pytest.raises(GraphDBError, match="multiple"):
        db.get_user_names_by_memory_ids(["a"])


@pytest.mark.parametrize("method,args", CALLS)
@pytest.mark.parametrize("stage", ["execute", "fetch", "commit", "putconn"])
def test_record_driver_failures_are_not_empty_success(capacity, method, args, stage):
    import psycopg2

    db, pool, connection, cursor = capacity
    error = psycopg2.ProgrammingError("record injection")
    if stage == "execute":
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
    assert caught.value.__cause__ is error and db._active == 0
    assert pool.getconn.call_count == 1


def test_bad_record_properties_roll_back(capacity):
    db, _, connection, cursor = capacity
    cursor.fetchall.return_value = [("a", "memory", "{", None)]
    with pytest.raises(GraphDBError):
        db.delete_node_by_mem_cube_id("A", "r")
    connection.commit.assert_not_called()
