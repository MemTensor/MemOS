"""Fail-closed filtering and deletion inputs; business results use real SQL in IT."""

import json

from copy import deepcopy
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
    db = PartialOpenGaussGraphDB(
        OpenGaussGraphDBConfig(
            host="localhost",
            user="memos",
            password="synthetic",
            db_name="test",
            user_name="A",
            embedding_dimension=3,
        )
    )
    return db, pool, cursor


BAD_FILTERS = [
    [],
    "bad",
    False,
    {"and": []},
    {"or": []},
    {"and": {}},
    {"or": "bad"},
    {"and": [None]},
    {"or": [{}]},
    {"and": [{"or": []}]},
    {"status": {}},
    {"status": {"unknown": "x"}},
    {"status": {"in": "x"}},
    {"confidence": {"gt": True}},
    {"confidence": {"gt": "1"}},
    {"confidence": {"lt": float("inf")}},
    {"confidence": {"gte": 10**400}},
    {"created_at": {"gte": "not-date"}},
    {"created_at": {"lt": 123}},
    {"created_at": "2026-02-30"},
    {"memory": {"like": []}},
    {"bad; DROP TABLE x": 1},
    {"info.a.b": 1},
    {"": 1},
    {12: "x"},
    {"status": float("nan")},
    {"status": ("x",)},
    {"info": {"=": {1: "x"}}},
]


@pytest.mark.parametrize("condition", BAD_FILTERS)
@pytest.mark.parametrize("method", ["read", "list", "delete"])
def test_bad_business_filters_never_borrow(store, condition, method):
    db, pool, _ = store
    with pytest.raises(ValueError):
        if method == "read":
            db.get_by_metadata([], filter=condition)
        elif method == "list":
            db.get_all_memory_items("LongTermMemory", filter=condition)
        else:
            db.delete_node_by_prams(filter=condition)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "filters",
    [
        None,
        {},
        "bad",
        [None],
        [{}],
        [{"field": "x"}],
        [{"field": "x", "value": 1, "extra": 1}],
        [{"field": "x.y", "value": 1}],
        [{"field": "x", "op": "bad", "value": 1}],
        [{"field": "x", "op": [], "value": 1}],
    ],
)
def test_bad_metadata_filters_never_borrow(store, filters):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.get_by_metadata(filters)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"user_name": ""},
        {"knowledgebase_ids": "K"},
        {"knowledgebase_ids": [""]},
        {"user_name_flag": False},
        {"user_name_flag": 1},
        {"status": 1},
        {"status": ""},
    ],
)
def test_bad_read_options_never_borrow(store, kwargs):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.get_by_metadata([], **kwargs)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("kwargs", [{"scope": ""}, {"scope": None}, {"include_embedding": 1}])
def test_bad_listing_options_never_borrow(store, kwargs):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.get_all_memory_items(**{"scope": "LongTermMemory", **kwargs})
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"memory_ids": "a"},
        {"file_ids": [None]},
        {"writable_cube_ids": [""]},
        {"writable_cube_ids": "A"},
        {"memory_ids": ["a"], "file_ids": ["f"]},
        {"memory_ids": ["a"], "filter": {"status": "deleted"}},
        {"file_ids": ["f"], "filter": {"status": "deleted"}},
    ],
)
def test_bad_delete_options_never_borrow(store, kwargs):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.delete_node_by_prams(**kwargs)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"filter": {}},
        {"memory_ids": []},
        {"file_ids": []},
        {"memory_ids": ["a"], "writable_cube_ids": []},
    ],
)
def test_empty_delete_never_borrows(store, kwargs):
    db, pool, _ = store
    assert db.delete_node_by_prams(**kwargs) == 0
    pool.transaction.assert_not_called()


def test_bound_values_scopes_and_no_input_mutation(store):
    db, _, cursor = store
    value = "中文 ' $memos$ ; -- %_\\\n"
    condition = {"or": [{"project": value}, {"memory": {"like": value}}]}
    original = deepcopy(condition)
    cursor.fetchall.return_value = [("a",), ("a",), ("k",)]
    assert db.get_by_metadata(
        [], user_name="B", knowledgebase_ids=["K", "K"], filter=condition
    ) == ["a", "a", "k"]
    statement, params = cursor.execute.call_args.args
    assert "scope = ANY(%s)" in statement and "ORDER BY scope, business_id" in statement
    assert params[0] == ["B", "K"]
    assert value not in statement and "project" not in statement
    assert condition == original


def test_multi_scope_projection_and_physical_empty_scope(store):
    db, _, cursor = store
    cursor.fetchall.return_value = [
        (
            "a",
            "memo",
            json.dumps(
                {
                    "id": "a",
                    "memory": "memo",
                    "user_name": "K",
                    "status": "deleted",
                }
            ),
            "[1,0,0]",
            "K",
        )
    ]
    assert db.get_all_memory_items(
        "InsightMemory", knowledgebase_ids=["K"], include_embedding=True
    ) == [
        {
            "id": "a",
            "memory": "memo",
            "metadata": {"status": "deleted", "embedding": [1, 0, 0], "user_name": "K"},
        }
    ]
    db.config.user_name = None
    db.config.use_multi_db = True
    cursor.fetchall.return_value = []
    assert db.get_by_metadata([]) == []
    assert cursor.execute.call_args.args[1][0] == [""]


@pytest.mark.parametrize(
    "operation",
    [
        lambda db: db.get_by_metadata([]),
        lambda db: db.get_all_memory_items("LongTermMemory"),
        lambda db: db.delete_node_by_prams(),
    ],
)
def test_closed_store_rejects_even_empty_operations(store, operation):
    db, pool, _ = store
    pool.ensure_open.side_effect = GraphDBError("closed")
    with pytest.raises(GraphDBError, match="closed"):
        operation(db)
    pool.transaction.assert_not_called()
