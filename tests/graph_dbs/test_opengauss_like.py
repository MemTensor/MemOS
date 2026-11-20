"""Bound LIKE, strict inputs and projections for default Feedback."""

import json

import pytest

from memos.exceptions import GraphDBError
from tests.graph_dbs.test_opengauss_capacity import capacity as _capacity
from tests.graph_dbs.test_opengauss_connection import pool_case as _pool_case


capacity, pool_case = _capacity, _pool_case


@pytest.mark.parametrize(
    "kwargs",
    [
        {"query_word": None},
        {"query_word": 1},
        {"query_word": "a\0"},
        {"query_word": "bad\\"},
        {"scope": ""},
        {"scope": False},
        {"status": False},
        {"status": ""},
        {"user_name": ""},
        {"search_filter": []},
        {"filter": {"and": []}},
        {"knowledgebase_ids": "B"},
        {"knowledgebase_ids": [""]},
        {"return_fields": "id"},
        {"return_fields": [1]},
        {"return_fields": ["a.b"]},
        {"unknown": 1},
    ],
)
def test_like_rejects_before_borrow(capacity, kwargs):
    db, pool, _, _ = capacity
    with pytest.raises(ValueError):
        db.search_by_keywords_like(**({"query_word": "%word%"} | kwargs))
    pool.getconn.assert_not_called()


def test_closed_like_precedes_validation(capacity):
    db, pool, _, _ = capacity
    db.close()
    with pytest.raises(GraphDBError):
        db.search_by_keywords_like(None)
    pool.getconn.assert_not_called()


@pytest.mark.parametrize(
    "fields", [None, [], ["id", "memory", "user_name", "embedding", "tags", "absent", "id"]]
)
@pytest.mark.parametrize("cross", [False, True])
def test_like_bound_pattern_projection_and_stable_order(capacity, fields, cross):
    db, _, _, cursor = capacity
    cursor.fetchall.return_value = [
        (
            "id",
            "中文",
            json.dumps({"id": "id", "memory": "中文", "user_name": "A", "tags": ["x"]}),
            "[1,0,0]",
            "A",
        )
    ]
    pattern = "%' OR true --_\\%"
    result = db.search_by_keywords_like(
        pattern,
        scope="LongTermMemory",
        search_filter={"user_id": "u"},
        filter={"tag": "x"},
        knowledgebase_ids=["B"] if cross else None,
        return_fields=fields,
    )
    expected = {"id": "id"}
    if fields:
        expected.update(memory="中文", user_name="A", embedding=[1, 0, 0], tags=["x"], absent=None)
    if cross:
        expected["user_name"] = "A"
    assert result == [expected]
    query, params = cursor.execute.call_args.args
    assert pattern not in query and params["memos_like"] == pattern
    assert "LIKE %(memos_like)s" in query and "LIMIT" not in query
    assert 'ORDER BY scope COLLATE "C", business_id COLLATE "C"' in query


def test_like_empty_success_and_invalid_decode(capacity):
    db, _, _, cursor = capacity
    assert db.search_by_keywords_like("") == []
    cursor.fetchall.return_value = [("id", "text", "invalid", None, "A")]
    with pytest.raises(GraphDBError):
        db.search_by_keywords_like("%")
