"""DataVec score, scope, projection and bounded candidate recovery contracts."""

import importlib
import json

from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import GraphDBError
from tests.graph_dbs.opengauss_test_support import PartialOpenGaussGraphDB


@pytest.fixture
def vector_store(monkeypatch):
    module = importlib.import_module("memos.graph_dbs.opengauss")
    transaction = MagicMock()
    cursor = (
        transaction.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
    )
    monkeypatch.setattr(module, "ThreadedConnectionPool", MagicMock())
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_init_schema", lambda self: None)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_get_connection", transaction)
    config = OpenGaussGraphDBConfig(
        host="localhost",
        user="fixture",
        password="synthetic-password",
        db_name="fixture",
        user_name="A",
        embedding_dimension=3,
    )
    return PartialOpenGaussGraphDB(config), transaction, cursor


def _hit(node_id="one", distance=0.0, scope="A", vector=None, **metadata):
    return (
        node_id,
        "fixture",
        json.dumps({"id": node_id, "memory": "fixture", "user_name": scope, **metadata}),
        vector,
        scope,
        distance,
    )


def test_vector_math_and_score_order_are_independent_of_driver_order(vector_store):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [
        _hit("opposite", 2),
        _hit("near", 0.2),
        _hit("same", 0),
        _hit("orthogonal", 1),
    ]
    hits = db.search_by_embedding([1, 0, 0], top_k=4)
    assert [hit["id"] for hit in hits] == ["same", "near", "orthogonal", "opposite"]
    assert [hit["score"] for hit in hits] == pytest.approx([1, 0.9, 0.5, 0])
    assert all(set(hit) == {"id", "score"} for hit in hits)
    assert cursor.fetchall.call_count == 1


@pytest.mark.parametrize(
    "threshold,expected",
    [(None, ["a", "b"]), (0, ["a", "b"]), (0.5, ["a", "b"]), (0.500001, ["a"]), (1, ["a"])],
)
def test_threshold_is_inclusive_and_has_no_hidden_distance_cutoff(
    vector_store, threshold, expected
):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit("a", 0), _hit("b", 1)]
    assert [
        hit["id"] for hit in db.search_by_embedding([1, 0, 0], top_k=2, threshold=threshold)
    ] == expected


def test_underfilled_ann_is_replaced_by_one_same_scope_exact_query(vector_store):
    db, transaction, cursor = vector_store
    cursor.fetchall.side_effect = [
        [_hit("old", scope="B")],
        [_hit("new", 0.2, scope="B"), _hit("other", 1, scope="B")],
    ]
    hits = db.search_by_embedding([1, 0, 0], top_k=2, user_name="B", filter={"project": "星港"})
    assert [hit["id"] for hit in hits] == ["new", "other"]
    queries = [
        call for call in cursor.execute.call_args_list if "SELECT business_id" in call.args[0]
    ]
    assert len(queries) == 2
    assert " + 0" not in queries[0].args[0]
    assert " + 0" in queries[1].args[0]
    assert queries[0].args[1] == queries[1].args[1]
    assert ["B"] in queries[0].args[1].values()
    transaction.assert_called_once()


def test_zero_hits_are_bounded_and_high_dimensions_use_exact_only(vector_store):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = []
    assert db.search_by_embedding([1, 0, 0]) == []
    assert cursor.fetchall.call_count == 2
    cursor.reset_mock()
    db.config.embedding_dimension = 2001
    assert db.search_by_embedding([1] + [0] * 2000) == []
    assert cursor.fetchall.call_count == 1
    assert " + 0" in cursor.execute.call_args.args[0]


def test_scopes_filters_and_values_are_bound_without_mutating_inputs(vector_store):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = []
    arguments = {
        "user_name": "B",
        "cube_name": "A'中文",
        "knowledgebase_ids": ["K", "K"],
        "scope": "LongTermMemory",
        "status": "archived",
        "search_filter": {"session_id": "bound-session'"},
        "filter": {"project": "中文'; DROP TABLE Memory; --"},
    }
    before = deepcopy(arguments)
    db.search_by_embedding([1, 0, 0], **arguments)
    statement, params = cursor.execute.call_args.args
    assert "scope = ANY(%(scopes)s)" in statement
    assert "vector_norm(embedding) > 0" in statement
    assert ["A'中文", "K"] in params.values()
    for literal in ("LongTermMemory", "archived", "bound-session'", "中文'; DROP TABLE Memory; --"):
        assert literal not in statement
        assert (
            json.dumps(literal, ensure_ascii=False) in params.values()
            or json.dumps(literal) in params.values()
        )
    assert arguments == before


@pytest.mark.parametrize(
    "fields,include,keys",
    [
        (None, False, []),
        ([], False, []),
        (["id", "score", "tags", "tags", "absent"], False, ["tags", "absent"]),
        (["embedding"], False, ["embedding"]),
        (None, True, ["embedding"]),
    ],
)
def test_projection_deduplicates_and_protects_identity_score(vector_store, fields, include, keys):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit(vector="[1,0,0]", tags=["x"], score=99)]
    hit = db.search_by_embedding(
        [1, 0, 0], top_k=1, return_fields=fields, include_embedding=include
    )[0]
    assert hit["id"] == "one" and hit["score"] == 1
    assert set(hit) == {"id", "score", *keys}
    if "embedding" in keys:
        assert hit["embedding"] == [1, 0, 0]
    if "absent" in keys:
        assert hit["absent"] is None


def test_projected_payload_keeps_json_types_and_scope(vector_store):
    db, _, cursor = vector_store
    metadata = {
        "info": {"fraction": 0.8},
        "sources": [{"content": "fixture"}],
        "memory_type": "Context",
    }
    cursor.fetchall.return_value = [_hit(scope="K", **metadata)]
    hit = db.search_by_embedding(
        [1, 0, 0],
        top_k=1,
        knowledgebase_ids=["K"],
        return_fields=["memory", "user_name", *metadata],
    )[0]
    assert hit == {"id": "one", "score": 1, "memory": "fixture", "user_name": "K", **metadata}


@pytest.mark.parametrize(
    "vector",
    [
        None,
        [],
        (1, 0, 0),
        "[1,0,0]",
        [1, 0],
        [1, 0, 0, 0],
        [0, 0, 0],
        [True, 0, 0],
        ["1", 0, 0],
        [float("nan"), 0, 0],
        [float("inf"), 0, 0],
        [10**400, 0, 0],
    ],
)
def test_invalid_query_vectors_fail_before_borrowing(vector_store, vector):
    db, transaction, _ = vector_store
    with pytest.raises(ValueError):
        db.search_by_embedding(vector)
    transaction.assert_not_called()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"top_k": -1},
        {"top_k": True},
        {"top_k": 1.5},
        {"threshold": -0.1},
        {"threshold": 1.1},
        {"threshold": float("nan")},
        {"threshold": float("inf")},
        {"threshold": "0.5"},
        {"threshold": True},
        {"scope": ""},
        {"scope": False},
        {"status": ""},
        {"user_name": ""},
        {"cube_name": " "},
        {"knowledgebase_ids": "K"},
        {"search_filter": []},
        {"search_filter": {"bad;": 1}},
        {"filter": {"or": []}},
        {"return_fields": "memory"},
        {"return_fields": [None]},
        {"return_fields": ["memory; DROP TABLE x"]},
        {"include_embedding": "false"},
    ],
)
def test_invalid_arguments_even_with_zero_limit_fail_before_borrowing(vector_store, kwargs):
    db, transaction, _ = vector_store
    with pytest.raises(ValueError):
        db.search_by_embedding([1, 0, 0], **{"top_k": 0, **kwargs})
    transaction.assert_not_called()


@pytest.mark.parametrize("scale", [1e-300, 1e300])
def test_finite_extreme_query_is_scaled_without_mutation(vector_store, scale):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit()]
    vector = [scale, 0, 0]
    assert db.search_by_embedding(vector, top_k=1) == [{"id": "one", "score": 1}]
    assert vector == [scale, 0, 0]
    assert json.loads(cursor.execute.call_args.args[1]["vector"]) == [1, 0, 0]


def test_zero_limit_and_closed_store(vector_store):
    db, transaction, _ = vector_store
    assert db.search_by_embedding([1, 0, 0], top_k=0) == []
    transaction.assert_not_called()
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        db.search_by_embedding([1, 0, 0], top_k=0)


@pytest.mark.parametrize("distance", [None, "bad", float("nan"), float("inf"), -1, 3])
def test_corrupt_distance_is_not_a_successful_empty_result(vector_store, distance):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit(distance=distance)]
    with pytest.raises(GraphDBError):
        db.search_by_embedding([1, 0, 0], top_k=1)


@pytest.mark.parametrize(
    "vector", ["broken", "{}", "null", [True, 0, 0], [float("nan"), 0, 0], [10**400, 0, 0], 3]
)
def test_corrupt_projected_vector_is_explicit_error(vector_store, vector):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit(vector=vector)]
    with pytest.raises(GraphDBError):
        db.search_by_embedding([1, 0, 0], top_k=1, include_embedding=True)


@pytest.mark.parametrize(
    "vector,expected",
    [("[1,0,0]", [1, 0, 0]), ([1, 0, 0], [1, 0, 0]), ((1, 0, 0), [1, 0, 0]), (None, None)],
)
def test_supported_vector_shapes_are_decoded(vector_store, vector, expected):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit(vector=vector)]
    assert (
        db.search_by_embedding([1, 0, 0], top_k=1, include_embedding=True)[0]["embedding"]
        == expected
    )


def test_candidate_ties_keep_distinct_cube_identities(vector_store):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit("same", scope="K"), _hit("same", scope="A")]
    hits = db.search_by_embedding(
        [1, 0, 0], top_k=2, knowledgebase_ids=["K"], return_fields=["user_name"]
    )
    assert [hit["user_name"] for hit in hits] == ["A", "K"]


@pytest.mark.parametrize("cube,expected", [(None, "B"), ("K", "K")])
def test_node_completion_uses_the_same_cube_alias(vector_store, cube, expected):
    db, _, cursor = vector_store
    cursor.fetchall.return_value = [_hit(scope=expected)[:4]]
    assert db.get_node("one", user_name="B", cube_name=cube)["id"] == "one"
    assert cursor.execute.call_args.args[1]["scope"] == expected


INDEX_ROW = ("memos_graph", "Memory", "hnsw", "vector_cosine_ops", "6", True, True, None, None)


@pytest.mark.parametrize("existing", [None, INDEX_ROW])
def test_vector_index_is_created_or_verified(vector_store, existing):
    db, _, cursor = vector_store
    cursor.fetchone.side_effect = [existing, INDEX_ROW] if existing is None else [existing]
    db._init_vector_index(cursor)
    queries = [call.args[0] for call in cursor.execute.call_args_list]
    assert sum("CREATE INDEX" in query for query in queries) == (existing is None)
    assert not any("DROP" in query for query in queries)


@pytest.mark.parametrize(
    "offset,value",
    [
        (0, "other"),
        (1, "Other"),
        (2, "btree"),
        (3, "vector_l2_ops"),
        (4, "5"),
        (5, False),
        (6, False),
        (7, "predicate"),
        (8, "expression"),
    ],
)
def test_incompatible_vector_index_is_rejected_without_replacement(vector_store, offset, value):
    db, _, cursor = vector_store
    row = list(INDEX_ROW)
    row[offset] = value
    cursor.fetchone.return_value = tuple(row)
    with pytest.raises(GraphDBError, match="index"):
        db._init_vector_index(cursor)
    assert not any(
        "CREATE" in call.args[0] or "DROP" in call.args[0] for call in cursor.execute.call_args_list
    )


def test_high_dimension_storage_does_not_attempt_unsupported_hnsw(vector_store):
    db, _, cursor = vector_store
    db.config.embedding_dimension = 3072
    db._init_vector_index(cursor)
    cursor.execute.assert_not_called()
