"""Native BM25 contracts, including bounded recovery of a failed write index."""

import importlib
import json

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import GraphDBError
from tests.graph_dbs.opengauss_test_support import PartialOpenGaussGraphDB


@pytest.fixture
def fulltext_store(monkeypatch):
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


def _hit(node_id="one", score=2.5, scope="A", vector=None, **metadata):
    return (
        node_id,
        "fixture",
        json.dumps({"id": node_id, "memory": "fixture", "user_name": scope, **metadata}),
        vector,
        scope,
        score,
    )


def test_fulltext_raw_scores_threshold_and_projection(fulltext_store):
    db, _, cursor = fulltext_store
    cursor.fetchall.return_value = [
        _hit("low", 1),
        _hit("high", 2.5, vector="[1,0,0]", tags=["x"], score_shadow=99),
    ]
    hits = db.search_by_fulltext(
        ["星港"],
        threshold=2.5,
        return_fields=["memory", "tags", "absent", "id", "score", "memory"],
        include_embedding=True,
    )
    assert hits == [
        {
            "id": "high",
            "score": 2.5,
            "memory": "fixture",
            "tags": ["x"],
            "absent": None,
            "embedding": [1, 0, 0],
        }
    ]


def test_fulltext_terms_filters_and_scope_are_bound_and_input_is_unchanged(fulltext_store):
    db, _, cursor = fulltext_store
    cursor.fetchall.return_value = []
    kwargs = {
        "query_words": ["  '星港' ", '"回归"', "星港", "'it''s'", "  ", "x'; DROP TABLE y; --"],
        "user_name": "B",
        "cube_name": "A'",
        "knowledgebase_ids": ["K", "K"],
        "scope": "LongTermMemory",
        "status": "archived",
        "filter": {"project": "星港"},
        "search_filter": {"session_id": "bound-session'"},
    }
    before = deepcopy(kwargs)
    db.search_by_fulltext(**kwargs)
    statement, params = cursor.execute.call_args.args
    assert params["query"] == "星港 回归 it's x'; DROP TABLE y; --"
    assert ["A'", "K"] in params.values()
    assert (
        "scope = ANY(%(scopes)s)" in statement
        and "ORDER BY memory <&> %(query)s DESC LIMIT %(top_k)s" in statement
    )
    for value in ("星港", "bound-session'", "DROP TABLE", "LongTermMemory", "archived"):
        assert value not in statement
    assert kwargs == before


@pytest.mark.parametrize("top_k", [1, 5, 200, 201, 210])
def test_fulltext_uses_taat_without_clamping_sql_limit(fulltext_store, top_k):
    db, _, cursor = fulltext_store
    cursor.fetchall.return_value = [_hit()]
    assert db.search_by_fulltext(["星港"], top_k=top_k) == [{"id": "one", "score": 2.5}]
    cursor.execute.assert_any_call("SET LOCAL enable_bm25_taat = on")
    assert cursor.execute.call_args.args[1]["top_k"] == top_k


@pytest.mark.parametrize("words", [[], ["", "  ", "''", '""']])
def test_fulltext_empty_words_do_not_borrow(fulltext_store, words):
    db, transaction, _ = fulltext_store
    assert db.search_by_fulltext(words) == []
    transaction.assert_not_called()


@pytest.mark.parametrize("words", [None, "星港", ("星港",), [1], [None], [True]])
def test_fulltext_bad_word_types_are_not_stringified(fulltext_store, words):
    db, transaction, _ = fulltext_store
    with pytest.raises(ValueError):
        db.search_by_fulltext(words)
    transaction.assert_not_called()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"top_k": -1},
        {"top_k": True},
        {"top_k": 1.5},
        {"threshold": -1},
        {"threshold": True},
        {"threshold": "1"},
        {"threshold": float("nan")},
        {"threshold": float("inf")},
        {"threshold": 10**400},
        {"scope": ""},
        {"cube_name": " "},
        {"status": False},
        {"search_filter": []},
        {"filter": {"or": []}},
        {"return_fields": "memory"},
        {"return_fields": [None]},
        {"return_fields": ["bad; field"]},
        {"include_embedding": 1},
        {"tsquery_config": "custom"},
        {"tsvector_field": "bad;"},
    ],
)
def test_fulltext_invalid_options_fail_even_for_empty_query(fulltext_store, kwargs):
    db, transaction, _ = fulltext_store
    with pytest.raises(ValueError):
        db.search_by_fulltext([], **kwargs)
    transaction.assert_not_called()


@pytest.mark.parametrize("config", [None, "jiebacfg", "jiebaqry"])
def test_fulltext_accepts_only_documented_consumer_aliases(fulltext_store, config):
    db, _, cursor = fulltext_store
    cursor.fetchall.return_value = [_hit()]
    assert db.search_by_fulltext(["星港"], tsvector_field="memory", tsquery_config=config)


def test_fulltext_zero_limit_and_closed_store(fulltext_store):
    db, transaction, _ = fulltext_store
    assert db.search_by_fulltext(["星港"], top_k=0) == []
    transaction.assert_not_called()
    db.close()
    with pytest.raises(GraphDBError, match="closed"):
        db.search_by_fulltext([])


@pytest.mark.parametrize("score", [None, "bad", -1, float("nan"), float("inf"), 10**400])
def test_fulltext_corrupt_scores_fail_explicitly(fulltext_store, score):
    db, _, cursor = fulltext_store
    cursor.fetchall.return_value = [_hit(score=score)]
    with pytest.raises(GraphDBError):
        db.search_by_fulltext(["星港"])


def test_fulltext_same_id_scope_ties_and_embedding_field(fulltext_store):
    db, _, cursor = fulltext_store
    cursor.fetchall.return_value = [
        _hit("same", scope="K", vector="[1,0,0]"),
        _hit("same", vector="[0,1,0]"),
    ]
    hits = db.search_by_fulltext(
        ["星港"], knowledgebase_ids=["K"], return_fields=["user_name", "embedding"]
    )
    assert [(h["id"], h["user_name"], h["embedding"]) for h in hits] == [
        ("same", "A", [0, 1, 0]),
        ("same", "K", [1, 0, 0]),
    ]


REBUILD_MESSAGE = "Last batch insert document failed, scanned score maybe affected, please reindex or recreate bm25 index [memory_fulltext_bm25]."


def _failure(code, message):
    psycopg2 = pytest.importorskip("psycopg2")

    class DriverFailure(psycopg2.Error):
        @property
        def pgcode(self):
            return code

        @property
        def diag(self):
            return SimpleNamespace(message_primary=message)

    error = GraphDBError("query failed")
    error.__cause__ = DriverFailure()
    return error


def test_fulltext_known_rollback_error_repairs_once_then_retries_read(fulltext_store, monkeypatch):
    db, transaction, cursor = fulltext_store
    repair = MagicMock()
    monkeypatch.setattr(db, "_rebuild_fulltext_index", repair)
    cursor.fetchall.side_effect = [_failure("42809", REBUILD_MESSAGE), [_hit()]]
    assert db.search_by_fulltext(["星港"]) == [{"id": "one", "score": 2.5}]
    repair.assert_called_once_with()
    assert transaction.call_count == 2


@pytest.mark.parametrize(
    "code,message",
    [
        (None, None),
        ("42501", REBUILD_MESSAGE),
        ("42809", "No BM25 index is used to the scan, please check the plan."),
    ],
)
def test_fulltext_unrelated_errors_do_not_rebuild(fulltext_store, monkeypatch, code, message):
    pytest.importorskip("psycopg2")
    failure = GraphDBError("no cause") if code is None else _failure(code, message)
    db, transaction, cursor = fulltext_store
    repair = MagicMock()
    monkeypatch.setattr(db, "_rebuild_fulltext_index", repair)
    cursor.fetchall.side_effect = failure
    with pytest.raises(GraphDBError) as caught:
        db.search_by_fulltext(["星港"])
    assert caught.value is failure
    repair.assert_not_called()
    assert transaction.call_count == 1


@pytest.mark.parametrize("repair_fails", [False, True])
def test_fulltext_recovery_failure_is_not_empty_or_infinite(
    fulltext_store, monkeypatch, repair_fails
):
    db, _, cursor = fulltext_store
    failure = _failure("42809", REBUILD_MESSAGE)
    cursor.fetchall.side_effect = failure
    repair = MagicMock(side_effect=GraphDBError("repair failed") if repair_fails else None)
    monkeypatch.setattr(db, "_rebuild_fulltext_index", repair)
    with pytest.raises(GraphDBError):
        db.search_by_fulltext(["星港"])
    repair.assert_called_once_with()
    assert cursor.fetchall.call_count == (1 if repair_fails else 2)


INDEX_ROW = (
    "memos_graph",
    "Memory",
    "bm25",
    "bm25_text_ops",
    "5",
    True,
    True,
    None,
    None,
    ["dict_path=DEFAULT"],
)


@pytest.mark.parametrize("existing", [None, INDEX_ROW])
def test_fulltext_index_creation_and_compatible_reuse(fulltext_store, existing):
    db, _, cursor = fulltext_store
    cursor.fetchone.side_effect = [None, INDEX_ROW] if existing is None else [existing]
    db._init_fulltext_index(cursor)
    queries = [call.args[0] for call in cursor.execute.call_args_list]
    assert sum("CREATE INDEX" in query for query in queries) == (existing is None)
    assert not any("DROP" in query for query in queries)


@pytest.mark.parametrize(
    "offset,value",
    [
        (0, "other"),
        (1, "Other"),
        (2, "btree"),
        (3, "text_ops"),
        (4, "6"),
        (5, False),
        (6, False),
        (7, "predicate"),
        (8, "expression"),
        (9, ["dict_path=/custom"]),
    ],
)
def test_fulltext_incompatible_index_is_not_replaced(fulltext_store, offset, value):
    db, _, cursor = fulltext_store
    row = list(INDEX_ROW)
    row[offset] = value
    cursor.fetchone.return_value = tuple(row)
    with pytest.raises(GraphDBError):
        db._init_fulltext_index(cursor)
    assert not any(
        "CREATE" in call.args[0] or "DROP" in call.args[0] for call in cursor.execute.call_args_list
    )


@pytest.mark.parametrize("present", [False, True])
def test_fulltext_rebuild_locks_and_only_repairs_the_owned_index(fulltext_store, present):
    db, _, cursor = fulltext_store
    cursor.fetchone.return_value = INDEX_ROW if present else None
    if present:
        db._rebuild_fulltext_index()
        cursor.execute.assert_any_call("REINDEX INDEX memos_graph.memory_fulltext_bm25")
    else:
        with pytest.raises(GraphDBError):
            db._rebuild_fulltext_index()
        assert not any("REINDEX" in call.args[0] for call in cursor.execute.call_args_list)
    cursor.execute.assert_any_call("SELECT pg_advisory_xact_lock(621503, %(lock)s)", {"lock": 1})


@pytest.mark.parametrize("failure", ["none", "one_deadlock", "two_deadlocks", "permission"])
def test_owned_test_graph_cleanup_only_retries_one_deadlock(monkeypatch, failure):
    psycopg2 = pytest.importorskip("psycopg2")

    from tests.graph_dbs import test_opengauss_integration as integration

    query = MagicMock()
    monkeypatch.setattr(integration, "_query", query)
    if failure == "one_deadlock":
        query.side_effect = [psycopg2.errors.DeadlockDetected(), []]
    elif failure == "two_deadlocks":
        query.side_effect = psycopg2.errors.DeadlockDetected()
    elif failure == "permission":
        query.side_effect = psycopg2.errors.InsufficientPrivilege()
    if failure in ("two_deadlocks", "permission"):
        with pytest.raises(psycopg2.Error):
            integration._drop_test_graph(None)
    else:
        integration._drop_test_graph(None)
    assert query.call_count == (2 if "deadlock" in failure else 1)
    assert all(
        call.args[1] == "SELECT ag_catalog.drop_graph('memos_graph',true)"
        for call in query.call_args_list
    )
