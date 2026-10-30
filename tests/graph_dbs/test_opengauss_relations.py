"""Scoped AGE adjacency and hard-delete contracts, including query failures."""

import json

from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import GraphDBError
from memos.graph_dbs import opengauss as module
from tests.graph_dbs.opengauss_test_support import PartialOpenGaussGraphDB


@pytest.fixture
def store(monkeypatch):
    pool = MagicMock()
    cursor = pool.transaction.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
    monkeypatch.setattr(module, "ThreadedConnectionPool", MagicMock())
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_get_connection", pool.transaction)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_ensure_open", pool.ensure_open)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "close", pool.close)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_init_schema", lambda self: None)
    config = OpenGaussGraphDBConfig(
        host="localhost",
        user="memos",
        password="synthetic",
        db_name="test",
        user_name="A",
        embedding_dimension=3,
    )
    return PartialOpenGaussGraphDB(config), pool, cursor


@pytest.mark.parametrize("method", ["add_edge", "delete_edge"])
def test_mutations_bind_scoped_endpoints_and_serialize(store, method):
    db, pool, cursor = store
    source, target, scope = "中文 ' $$ ; --", 'two\\n"', " B $$ ' "
    cursor.fetchall.return_value = [(source,), (target,)]
    getattr(db, method)(source, target, "RELATE_TO", user_name=scope)
    calls = cursor.execute.call_args_list
    assert "pg_advisory_xact_lock" in calls[0].args[0]
    assert "ORDER BY business_id FOR UPDATE" in calls[1].args[0]
    assert calls[1].args[1] == (scope, sorted([source, target]))
    prepare = next(call.args[0] for call in calls if call.args[0].startswith("PREPARE"))
    assert ("MERGE" if method == "add_edge" else "DELETE r") in prepare
    assert "a.user_name = $scope" in prepare and "b.user_name = $scope" in prepare
    execute = next(call for call in calls if call.args[0].startswith("EXECUTE"))
    expected = {"scope": scope, "source": source, "target": target}
    if method == "delete_edge":
        expected["type"] = "RELATE_TO"
    assert json.loads(execute.args[1][0]) == expected
    assert source not in prepare and scope not in prepare
    assert calls[-1].args[0] == "DEALLOCATE memos_age"
    pool.transaction.assert_called_once()


@pytest.mark.parametrize("method", ["add_edge", "delete_edge", "delete_node"])
def test_missing_endpoints_are_noops(store, method):
    db, _, cursor = store
    cursor.fetchall.return_value = []
    args = ("missing",) if method == "delete_node" else ("missing", "two", "RELATE_TO")
    getattr(db, method)(*args)
    assert not any(call.args[0].startswith("PREPARE") for call in cursor.execute.call_args_list)


def test_hard_delete_removes_native_edges_then_sql_label_row(store):
    db, _, cursor = store
    cursor.fetchall.return_value = [("one",)]
    db.delete_node("one", user_name="B")
    calls = cursor.execute.call_args_list
    assert "DELETE r" in next(call.args[0] for call in calls if call.args[0].startswith("PREPARE"))
    bound = next(call.args[1][0] for call in calls if call.args[0].startswith("EXECUTE"))
    assert json.loads(bound) == {"id": "one", "scope": "B"}
    assert calls[-1].args == (
        'DELETE FROM ONLY "memos_graph"."Memory" WHERE scope = %s AND business_id = %s',
        ("B", "one"),
    )


@pytest.mark.parametrize(
    "method", ["add_edge", "delete_edge", "edge_exists", "get_edges", "get_neighbors"]
)
@pytest.mark.parametrize("bad_type", [None, 7, "", " ", "x`]->(n) DELETE n //", "A" * 64, "中文"])
def test_invalid_types_reject_before_borrowing(store, method, bad_type):
    db, pool, _ = store
    args = (
        ("one", "two", bad_type)
        if method in ("add_edge", "delete_edge", "edge_exists")
        else ("one", bad_type)
    )
    with pytest.raises(ValueError, match="type"):
        getattr(db, method)(*args)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("method", ["add_edge", "delete_edge"])
def test_any_is_read_only(store, method):
    db, pool, _ = store
    with pytest.raises(ValueError, match="type"):
        getattr(db, method)("one", "two", "ANY")
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "method,args",
    [
        ("delete_node", ("",)),
        ("add_edge", (" ", "two", "R")),
        ("delete_edge", ("one", None, "R")),
        ("edge_exists", ("one", 3)),
        ("get_edges", (None,)),
        ("get_neighbors", ("", "R")),
    ],
)
def test_invalid_ids_reject_before_borrowing(store, method, args):
    db, pool, _ = store
    with pytest.raises(ValueError, match="id"):
        getattr(db, method)(*args)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "method,args",
    [
        ("get_edges", ("one", "ANY", "out")),
        ("edge_exists", ("one", "two", "ANY", "both")),
        ("get_neighbors", ("one", "ANY", "ANY")),
        ("get_edges", ("one", "ANY", None)),
        ("get_neighbors", ("one", "ANY", [])),
    ],
)
def test_invalid_directions_reject_before_borrowing(store, method, args):
    db, pool, _ = store
    with pytest.raises(ValueError, match="direction"):
        getattr(db, method)(*args)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("direction", ["OUTGOING", "INCOMING", "ANY"])
@pytest.mark.parametrize("edge_type", ["ANY", "RELATE_TO"])
def test_projection_is_sorted_unique_and_scoped(store, direction, edge_type):
    db, _, cursor = store
    cursor.fetchall.return_value = [
        ('"two"', '"one"', '"PARENT"'),
        ('"one"', '"two"', '"RELATE_TO"'),
        ('"one"', '"two"', '"RELATE_TO"'),
    ]
    assert db.get_edges("one", edge_type, direction, user_name="B") == [
        {"from": "one", "to": "two", "type": "RELATE_TO"},
        {"from": "two", "to": "one", "type": "PARENT"},
    ]
    calls = cursor.execute.call_args_list
    prepare = next(call.args[0] for call in calls if call.args[0].startswith("PREPARE"))
    assert "a.user_name = $scope" in prepare and "b.user_name = $scope" in prepare
    assert ("type(r) = $type" in prepare) == (edge_type != "ANY")
    bound = next(call.args[1][0] for call in calls if call.args[0].startswith("EXECUTE"))
    assert json.loads(bound)["scope"] == "B"


@pytest.mark.parametrize(
    "rows", [[("bad-json", '"two"', '"R"')], [("null", '"two"', '"R"')], [('"one"',)]]
)
def test_bad_projection_is_an_explicit_error(store, rows):
    db, _, cursor = store
    cursor.fetchall.return_value = rows
    with pytest.raises(GraphDBError, match="edge"):
        db.get_edges("one")


@pytest.mark.parametrize(
    "method,args",
    [
        ("delete_node", ("one",)),
        ("add_edge", ("one", "two", "R")),
        ("delete_edge", ("one", "two", "R")),
        ("edge_exists", ("one", "two")),
        ("get_edges", ("one",)),
        ("get_neighbors", ("one", "ANY")),
    ],
)
def test_closed_store_rejects_graph_operations(store, method, args):
    db, pool, _ = store
    pool.ensure_open.side_effect = GraphDBError("closed")
    with pytest.raises(GraphDBError, match="closed"):
        getattr(db, method)(*args)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("stage", ["prepare", "execute", "fetch", "deallocate"])
def test_cypher_failures_preserve_error_and_exit_transaction(store, stage):
    db, pool, cursor = store
    error = ValueError("synthetic stage failure")
    if stage == "fetch":
        cursor.fetchall.side_effect = error
    else:

        def execute(statement, *args):
            if statement.startswith(
                {"prepare": "PREPARE", "execute": "EXECUTE", "deallocate": "DEALLOCATE memos_age"}[
                    stage
                ]
            ):
                raise error

        cursor.execute.side_effect = execute
    with pytest.raises(ValueError) as caught:
        db.get_edges("one")
    assert caught.value is error
    assert pool.transaction.return_value.__exit__.call_args.args[1] is error
