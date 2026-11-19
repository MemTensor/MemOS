"""Named SQL composition through public methods and real AGE/DataVec/BM25."""

import os

from copy import deepcopy

import pytest

from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


@pytest.mark.parametrize("method", ["metadata", "vector", "fulltext"])
def test_repeated_fields_combine_across_independent_predicates(stores, method):
    db = stores()
    for node_id, confidence, status in [
        ("a", 21, "activated"),
        ("b", 42, "activated"),
        ("c", 65, "activated"),
        ("d", 21, "archived"),
        ("e", 10, "activated"),
    ]:
        db.add_node(
            node_id,
            "星港 回归",
            {
                "confidence": confidence,
                "status": status,
                "embedding": [1, 0, 0],
                "memory_type": "WorkingMemory",
                "session_id": "shared",
            },
        )
    db.add_node(
        "foreign",
        "星港 回归",
        {
            "confidence": 21,
            "status": "activated",
            "embedding": [1, 0, 0],
            "memory_type": "WorkingMemory",
            "session_id": "shared",
        },
        user_name="B",
    )
    condition = {
        "and": [
            {"confidence": {"gt": 18, "lt": 65}},
            {"or": [{"confidence": 21}, {"confidence": 42}]},
        ]
    }
    original = deepcopy(condition)
    if method == "metadata":
        result = db.get_by_metadata(
            [{"field": "confidence", "op": "gte", "value": 20}],
            filter=condition,
            status="activated",
        )
    else:
        search = db.search_by_embedding if method == "vector" else db.search_by_fulltext
        result = [
            hit["id"]
            for hit in search(
                [1, 0, 0] if method == "vector" else ["星港"],
                search_filter={"session_id": "shared"},
                filter=condition,
                scope="WorkingMemory",
                status="activated",
                top_k=10,
            )
        ]
    assert result == ["a", "b"]
    assert condition == original


def test_array_like_and_repeated_nested_field_bindings(stores):
    db = stores()
    literal = "50%_\\'中文"
    for node_id, text, tags in [
        ("a", literal, ["red", "blue"]),
        ("b", "50xx中文", ["red", "blue"]),
        ("c", literal, ["green"]),
    ]:
        db.add_node(node_id, "fixture", {"info": {"label": text}, "tags": tags})
    assert db.get_by_metadata(
        [],
        filter={
            "and": [
                {"info.label": {"like": literal, "starts_with": "50%", "ends_with": "中文"}},
                {"tags": {"contains": ["red", "green"], "all": ["blue"]}},
            ]
        },
    ) == ["a"]


def test_grouping_user_bindings_are_separate_and_reusable(stores):
    db = stores()
    for scope in ("A", "B"):
        db.add_node(
            "one", "星港", {"info": {"department": "研发", "team": "存储"}}, user_name=scope
        )
    fields = ["info.department", "info.team"]
    params = {"scope": "one"}
    assert db.get_grouped_counts(
        fields,
        "(business_id=%(scope)s OR business_id=%(scope)s) AND memory LIKE '%%星港%%'",
        params,
    ) == [{"info.department": "研发", "info.team": "存储", "count": 1}]
    assert params == {"scope": "one"}
    with pytest.raises(ValueError, match="reserved"):
        db.get_grouped_counts(
            fields, "business_id=%(memos_group_0_root)s", {"memos_group_0_root": "one"}
        )
    assert db.get_memory_count("WorkingMemory") == 0
