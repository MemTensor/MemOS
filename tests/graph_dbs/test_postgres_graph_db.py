"""Unit tests for PostgresGraphDB reorganizer/handler-facing methods.

These tests exercise the graph-store interface used by the tree text memory
reorganizer and handler without requiring a live PostgreSQL server.  The
psycopg2 module is patched with a lightweight fake so the SQL that would run
against PostgreSQL can be asserted directly.
"""

import sys
import types

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest


_PSYCOPG2 = sys.modules.setdefault("psycopg2", types.ModuleType("psycopg2"))
_PSYCOPG2_POOL = sys.modules.setdefault("psycopg2.pool", types.ModuleType("psycopg2.pool"))
_PSYCOPG2.pool = _PSYCOPG2_POOL

from memos.configs.graph_db import PostgresGraphDBConfig  # noqa: E402  (stubs above)
from memos.graph_dbs.postgres import PostgresGraphDB  # noqa: E402  (stubs above)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_fake_pool():
    """Return (fake_pool, conn_mock, cursor_mock) wired like ThreadedConnectionPool."""
    pool = MagicMock()
    conn = MagicMock()
    conn.closed = 0
    cursor = MagicMock()
    cursor.fetchone.return_value = None
    cursor.fetchall.return_value = []
    # `_get_conn` health check calls conn.cursor() without a context manager,
    # while query methods use `with conn.cursor() as cur`. Make both return the
    # same cursor object so the configured results are seen everywhere.
    conn.cursor.return_value = cursor
    cursor.__enter__.return_value = cursor
    cursor.__exit__.return_value = False
    pool.getconn.return_value = conn
    return pool, conn, cursor


def _make_graph_db():
    config = PostgresGraphDBConfig(
        host="localhost",
        port=5432,
        user="test",
        password="test",
        db_name="test_db",
        schema_name="memos",
        user_name="alice",
        embedding_dimension=3,
        maxconn=5,
    )
    return PostgresGraphDB(config)


@pytest.fixture
def graph_db():
    with patch.object(_PSYCOPG2_POOL, "ThreadedConnectionPool", create=True) as mock_pool_cls:
        pool, _conn, cursor = _make_fake_pool()
        mock_pool_cls.return_value = pool
        yield _make_graph_db(), cursor


# ---------------------------------------------------------------------------
# node_not_exist / get_memory_count
# ---------------------------------------------------------------------------


def test_node_not_exist_returns_true_when_scope_missing(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = None

    assert db.node_not_exist("WorkingMemory", user_name="alice") is True
    sql = cursor.execute.call_args[0][0]
    assert "FROM memos.memories" in sql
    assert "memory_type" in sql


def test_node_not_exist_returns_false_when_scope_has_nodes(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = ("some-id",)

    assert db.node_not_exist("WorkingMemory", user_name="alice") is False


def test_node_not_exist_falls_back_to_config_user(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = None

    assert db.node_not_exist("WorkingMemory") is True
    params = cursor.execute.call_args[0][1]
    assert "alice" in params


def test_get_memory_count(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = (7,)

    assert db.get_memory_count("WorkingMemory", user_name="alice") == 7
    sql = cursor.execute.call_args[0][0]
    assert "COUNT" in sql.upper()
    params = cursor.execute.call_args[0][1]
    assert "WorkingMemory" in params
    assert "alice" in params


def test_get_memory_count_zero_when_no_rows(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = None

    assert db.get_memory_count("WorkingMemory", user_name="alice") == 0


# ---------------------------------------------------------------------------
# get_edges
# ---------------------------------------------------------------------------


def test_get_edges_any_direction(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = [("a", "b", "PARENT"), ("c", "a", "MERGED_TO")]

    edges = db.get_edges("a", type="ANY", direction="ANY", user_name="alice")

    assert edges == [
        {"from": "a", "to": "b", "type": "PARENT"},
        {"from": "c", "to": "a", "type": "MERGED_TO"},
    ]
    sql = cursor.execute.call_args[0][0]
    assert "FROM memos.edges" in sql
    assert "source_id = %s OR target_id = %s" in sql


def test_get_edges_outgoing(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = [("a", "b", "PARENT")]

    edges = db.get_edges("a", type="PARENT", direction="OUTGOING", user_name="alice")

    assert edges == [{"from": "a", "to": "b", "type": "PARENT"}]
    sql = cursor.execute.call_args[0][0]
    assert "source_id = %s" in sql
    params = cursor.execute.call_args[0][1]
    assert "a" in params


def test_get_edges_accepts_out_alias(graph_db):
    """The scheduler handler calls get_edges(..., direction='OUT')."""
    db, cursor = graph_db
    cursor.fetchall.return_value = [("a", "b", "MERGED_TO")]

    edges = db.get_edges("a", type="MERGED_TO", direction="OUT")

    assert edges == [{"from": "a", "to": "b", "type": "MERGED_TO"}]


def test_get_edges_filters_by_type(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = []

    db.get_edges("a", type="FOLLOWS", direction="ANY", user_name="alice")

    sql = cursor.execute.call_args[0][0]
    assert "edge_type" in sql
    params = cursor.execute.call_args[0][1]
    assert "FOLLOWS" in params


def test_get_edges_raises_on_invalid_direction(graph_db):
    _db, _cursor = graph_db
    with pytest.raises(ValueError):
        _db.get_edges("a", type="ANY", direction="SIDEWAYS")


# ---------------------------------------------------------------------------
# edge_exists
# ---------------------------------------------------------------------------


def test_edge_exists_directed(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = (1,)

    assert db.edge_exists("a", "b", "PARENT", direction="OUTGOING", user_name="alice") is True
    sql = cursor.execute.call_args[0][0]
    assert "source_id = %s" in sql
    assert "target_id = %s" in sql
    assert "edge_type = %s" in sql


def test_edge_exists_any_direction(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = (1,)

    assert db.edge_exists("a", "b", "PARENT", direction="ANY", user_name="alice") is True
    sql = cursor.execute.call_args[0][0]
    assert "source_id = %s AND target_id = %s" in sql
    assert "edge_type = %s" in sql
    params = cursor.execute.call_args[0][1]
    assert params == ["a", "b", "b", "a", "PARENT"]


def test_edge_exists_false_when_missing(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = None

    assert db.edge_exists("a", "b", "PARENT", direction="ANY", user_name="alice") is False


def test_edge_exists_default_any_type(graph_db):
    db, cursor = graph_db
    cursor.fetchone.return_value = (1,)

    assert db.edge_exists("a", "b") is True
    sql = cursor.execute.call_args[0][0]
    assert "edge_type" not in sql


def test_edge_exists_keeps_old_three_arg_call(graph_db):
    """Backwards compatibility: old callers pass type positionally."""
    db, cursor = graph_db
    cursor.fetchone.return_value = (1,)

    assert db.edge_exists("a", "b", "PARENT") is True


# ---------------------------------------------------------------------------
# get_structure_optimization_candidates
# ---------------------------------------------------------------------------


def test_get_structure_optimization_candidates_respects_user_name(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = [
        (
            "n1",
            "mem one",
            {"memory_type": "LongTermMemory"},
            datetime(2026, 1, 1),
            datetime(2026, 1, 1),
        ),
    ]

    nodes = db.get_structure_optimization_candidates(
        "LongTermMemory", user_name="bob", include_embedding=False
    )

    assert len(nodes) == 1
    assert nodes[0]["id"] == "n1"
    assert nodes[0]["memory"] == "mem one"
    assert nodes[0]["metadata"]["memory_type"] == "LongTermMemory"
    # per-user scope must be honored, not the config default
    params = cursor.execute.call_args[0][1]
    # params layout: (scope, user_name) — pin both the positive and negative
    # expectations so a config-default leak (alice) cannot slip through
    assert params[1] == "bob"
    assert "alice" not in params


# ---------------------------------------------------------------------------
# search_by_fulltext
# ---------------------------------------------------------------------------


def test_search_by_fulltext_basic(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = [("n1", 0.85), ("n2", 0.6)]

    results = db.search_by_fulltext(
        query_words=["hello", "world"],
        top_k=10,
        scope="LongTermMemory",
        status="activated",
        user_name="alice",
    )

    assert results == [{"id": "n1", "score": 0.85}, {"id": "n2", "score": 0.6}]
    sql = cursor.execute.call_args[0][0]
    assert "ts_rank" in sql
    assert "memory_type" in sql
    params = cursor.execute.call_args[0][1]
    assert "hello" in " ".join(str(p) for p in params)


def test_search_by_fulltext_applies_threshold(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = [("n1", 0.3)]

    results = db.search_by_fulltext(
        query_words=["hello"], top_k=10, user_name="alice", threshold=0.5
    )

    assert results == []


def test_search_by_fulltext_quotes_words_for_tsquery(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = []

    db.search_by_fulltext(query_words=["it's", "foo"], top_k=10, user_name="alice")

    # single quotes inside the term must be escaped to avoid breaking to_tsquery
    # execute params layout: (user_name, [scope, status, ...filters], tsquery_string,
    # tsquery_string, top_k) — the two tsquery_string slots feed the SELECT ts_rank()
    # and the WHERE @@ to_tsquery(); pick the first one via [-3]
    tsquery_param = str(cursor.execute.call_args[0][1][-3])
    assert "it''s" in tsquery_param
    assert "'foo'" in tsquery_param
    assert "|" in tsquery_param


def test_search_by_fulltext_no_results(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = []

    assert db.search_by_fulltext(query_words=["nothing"], top_k=10, user_name="alice") == []


def test_search_by_fulltext_handles_search_filter(graph_db):
    db, cursor = graph_db
    cursor.fetchall.return_value = [("n1", 0.9)]

    results = db.search_by_fulltext(
        query_words=["hello"],
        top_k=10,
        user_name="alice",
        search_filter={"importance": "2"},
    )

    assert len(results) == 1
    sql = cursor.execute.call_args[0][0]
    assert "importance" in sql


def test_search_by_fulltext_accepts_kwargs_from_recall_path(graph_db):
    """recall.py passes cube_name / knowledgebase_ids which must not blow up."""
    db, cursor = graph_db
    cursor.fetchall.return_value = []

    results = db.search_by_fulltext(
        query_words=["hello"],
        top_k=10,
        status="activated",
        scope="LongTermMemory",
        search_filter=None,
        filter=None,
        user_name="alice",
        cube_name="cube-a",
        knowledgebase_ids=["kb1"],
        tsquery_config="jiebaqry",
    )

    assert results == []
