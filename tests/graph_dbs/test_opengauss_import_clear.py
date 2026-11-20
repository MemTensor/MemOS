"""Atomic import and Cube clearing validation and failure contracts."""

from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity import capacity as _capacity
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


capacity, pool_case = _capacity, _pool_case
CALLS = [
    ("import_graph", ({"nodes": [{"id": "a", "memory": "text"}]},)),
    ("clear", ()),
    ("drop_database", ()),
]


@pytest.mark.parametrize(
    "data",
    [
        None,
        [],
        {"nodes": {}},
        {"edges": {}},
        {"nodes": [None]},
        {"nodes": [{"id": "a"}]},
        {"nodes": [{"id": "a", "memory": "x", "metadata": None}]},
        {"nodes": [{"id": "a", "memory": "x"}, {"id": "a", "memory": "y"}]},
        {"nodes": [{"id": "a", "memory": "x", "metadata": {"embedding": [1, 2]}}]},
        {"nodes": [{"id": "a", "memory": "x", "metadata": {"user_name": "B"}}]},
        {"nodes": [{"id": "a", "memory": "x", "metadata": {"info": {"x": ["\0"]}}}]},
        {"nodes": [{"id": "a", "memory": "x", "metadata": {"\0": 1}}]},
        {"edges": [None]},
        {"edges": [{}]},
        {"edges": [{"source": "a", "target": "b", "type": "ANY"}]},
        {"edges": [{"source": "a", "target": "b", "type": "PARENT", "user_name": "B"}]},
        {"edges": [{"source": "", "target": "b", "type": "PARENT"}]},
    ],
)
def test_import_validation_is_complete_before_borrow(capacity, data):
    db, pool, _, _ = capacity
    before = deepcopy(data)
    with pytest.raises(ValueError):
        db.import_graph(data)
    assert data == before
    pool.getconn.assert_not_called()


def test_empty_import_does_not_borrow(capacity):
    db, pool, _, _ = capacity
    assert db.import_graph({}) is None
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("method,args", CALLS)
def test_closed_maintenance_rejects_calls(capacity, method, args):
    db, pool, _, _ = capacity
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        getattr(db, method)(*args)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize("method,args", CALLS)
@pytest.mark.parametrize("stage", ["execute", "fetch", "commit", "putconn"])
def test_import_clear_transaction_failure(capacity, method, args, stage):
    import psycopg2

    db, pool, connection, cursor = capacity
    error = psycopg2.ProgrammingError("maintenance injection")
    if stage == "execute":
        cursor.execute.side_effect = error
    elif stage == "fetch":
        cursor.fetchall.side_effect = error
    elif stage == "commit":
        connection.commit.side_effect = error
    else:
        pool.putconn.side_effect = error
    with pytest.raises(GraphDBError) as caught:
        getattr(db, method)(*args)
    assert caught.value.__cause__ is error
    assert db._active == 0 and pool.getconn.call_count == 1


def test_clear_chunks_share_one_transaction(capacity, monkeypatch):
    db, _, connection, cursor = capacity
    keys = [f"x{i:04}" for i in range(1200)]
    cursor.fetchall.return_value = [(key,) for key in keys]
    monkeypatch.setattr(db, "_cypher", MagicMock())
    db.clear(user_name="B")
    deletes = [
        c.args[1] for c in cursor.execute.call_args_list if c.args[0].startswith("DELETE FROM ONLY")
    ]
    assert deletes == [
        {"scope": "B", "ids": batch} for batch in [keys[:500], keys[500:1000], keys[1000:]]
    ]
    assert db._cypher.call_count == 3
    connection.commit.assert_called_once()
