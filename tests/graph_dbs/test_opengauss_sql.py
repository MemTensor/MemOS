"""Shared cursor lifetime and independently composable named SQL fragments."""

import re

from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


pool_case = _pool_case


@pytest.mark.parametrize(
    "utc,lock", [(False, None), (True, None), (False, 1), (True, 2), (False, 0)]
)
def test_cursor_owns_one_transaction_and_orders_optional_setup(pool_case, utc, lock):
    _, db, pool, connection, _ = pool_case
    cursor = connection.cursor.return_value.__enter__.return_value
    with db._cursor(utc=utc, lock=lock) as yielded:
        assert yielded is cursor
        yielded.execute("SELECT 1")
        connection.commit.assert_not_called()
    statements = [call.args for call in cursor.execute.call_args_list][3:]
    expected = []
    if utc:
        expected.append(("SET LOCAL TIME ZONE 'UTC'",))
    if lock is not None:
        expected.append(("SELECT pg_advisory_xact_lock(621503, %(lock)s)", {"lock": lock}))
    assert statements == [*expected, ("SELECT 1",)]
    pool.getconn.assert_called_once()
    connection.commit.assert_called_once()
    pool.putconn.assert_called_once_with(connection, close=False)


@pytest.mark.parametrize("stage", ["cursor", "utc", "lock", "body", "close"])
def test_cursor_setup_body_and_close_errors_use_existing_rollback(pool_case, stage):
    module, db, pool, connection, _ = pool_case
    manager = MagicMock()
    cursor = manager.__enter__.return_value
    error = module.psycopg2.ProgrammingError("shared cursor failure")
    connection.cursor.side_effect = [
        connection.cursor.return_value,
        error if stage == "cursor" else manager,
    ]

    def execute(statement, params=None):
        if (stage == "utc" and "TIME ZONE" in statement) or (
            stage == "lock" and "advisory" in statement
        ):
            raise error

    cursor.execute.side_effect = execute
    if stage == "close":
        manager.__exit__.side_effect = error
    with pytest.raises(GraphDBError) as caught, db._cursor(utc=True, lock=2):
        if stage == "body":
            raise error
    assert caught.value.__cause__ is error
    connection.commit.assert_not_called()
    assert connection.rollback.call_count == 2
    pool.putconn.assert_called_once_with(connection, close=False)


def test_cursor_closed_store_does_not_borrow(pool_case):
    _, db, pool, _, _ = pool_case
    db.close()
    with pytest.raises(GraphDBError, match="closed"), db._cursor():
        pytest.fail("Closed cursor yielded")
    pool.getconn.assert_not_called()


def test_fragment_field_reuses_bindings_without_mutating_inputs(pool_case):
    _, db, _, _, _ = pool_case
    path = ["info", "department"]
    sql, params = db._text_field_expr(path, prefix="memos_field")
    assert path == ["info", "department"]
    assert len(params) == 2
    assert set(params.values()) == {'"info"', '"department"'}
    assert set(re.findall(r"%\((\w+)\)s", sql)) == set(params)
    assert len(re.findall(r"%\((\w+)\)s", sql)) > len(params)
    params["memos_field_root"] = "modified"
    assert db._text_field_expr(path, prefix="memos_field")[1]["memos_field_root"] == '"info"'


def test_binding_merge_rejects_collisions_without_touching_inputs(pool_case):
    _, db, _, _, _ = pool_case
    left, right = {"limit": 18}, {"limit": 65}
    with pytest.raises(ValueError, match="Duplicate"):
        db._merge_bindings(left, right)
    assert left == {"limit": 18} and right == {"limit": 65}
    assert db._merge_bindings(left, {"other": 65}) == {"limit": 18, "other": 65}
    assert db._merge_bindings() == {}


def test_nested_repeated_field_conditions_have_distinct_parameters(pool_case):
    _, db, _, _, _ = pool_case
    condition = {
        "and": [
            {"confidence": {"gt": 18, "lt": 65}},
            {"or": [{"confidence": 21}, {"confidence": 42}]},
        ]
    }
    before = deepcopy(condition)
    sql, params = db._build_filter_where_clause(condition, prefix="memos_filter")
    assert condition == before
    values = list(params.values())
    for value in [18, 65, "21", "42"]:
        assert value in values
    assert "%s" not in sql
    assert set(re.findall(r"%\((\w+)\)s", sql)) == set(params)
    other_sql, other_params = db._build_filter_where_clause(condition, prefix="memos_other")
    assert not set(params) & set(other_params)
    assert sql != other_sql


def test_grouping_helpers_validate_before_borrow_and_decode_before_commit(pool_case, monkeypatch):
    _, db, pool, connection, _ = pool_case
    predicate, params = db._validate_grouping(["info.v"], " WHERE business_id=%(id)s ", {"id": "x"})
    assert predicate == "business_id=%(id)s" and params == {"id": "x"}
    query, bound = db._build_grouping_query(["info.v"], predicate, params, "A")
    assert "GROUP BY" in query and bound["memos_scope"] == "A"
    assert params == {"id": "x"}
    pool.getconn.assert_not_called()
    original = db._decode_grouped_rows

    def decode(fields, rows):
        connection.commit.assert_not_called()
        return original(fields, rows)

    monkeypatch.setattr(db, "_decode_grouped_rows", decode)
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = [('"value"', 2)]
    assert db.get_grouped_counts(["info.v"]) == [{"info.v": "value", "count": 2}]
    connection.commit.assert_called_once()
