"""Explicit one-hop context support and semantic capability refusals."""

from unittest.mock import MagicMock

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity import capacity as _capacity
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


capacity, pool_case = _capacity, _pool_case


def test_context_uses_outgoing_scoped_neighbors(capacity, monkeypatch):
    db, _, _, _ = capacity
    neighbors = MagicMock(return_value=["a", "b"])
    monkeypatch.setattr(db, "get_neighbors", neighbors)
    assert db.get_context_chain("start", "FOLLOWS", user_name="B") == ["a", "b"]
    neighbors.assert_called_once_with("start", type="FOLLOWS", direction="out", user_name="B")


@pytest.mark.parametrize(
    "method,args",
    [
        ("deduplicate_nodes", ()),
        ("detect_conflicts", ()),
        ("merge_nodes", ("a", "b")),
    ],
)
def test_semantic_methods_refuse_explicitly_without_borrowing(capacity, method, args):
    db, pool, _, _ = capacity
    with pytest.raises(NotImplementedError, match=method):
        getattr(db, method)(*args)
    pool.getconn.assert_not_called()
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        getattr(db, method)(*args)


def test_closed_context_and_invalid_type(capacity):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.get_context_chain("a", "bad-type")
    pool.getconn.assert_not_called()
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        db.get_context_chain("a")
