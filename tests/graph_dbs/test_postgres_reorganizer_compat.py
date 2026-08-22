"""Regression tests for PostgresGraphDB reorganizer/handler compatibility."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from memos.graph_dbs.postgres import PostgresGraphDB


def _build_db() -> PostgresGraphDB:
    with (
        patch("memos.graph_dbs.postgres.require_python_package", lambda *args, **kwargs: lambda fn: fn),
        patch("psycopg2.pool.ThreadedConnectionPool", MagicMock()),
        patch.object(PostgresGraphDB, "_init_schema", lambda self: None),
    ):
        config = MagicMock()
        config.schema_name = "test_schema"
        config.user_name = "user-1"
        return PostgresGraphDB(config)


def _mock_cursor(fetchone=None, fetchall=None):
    cursor = MagicMock()
    cursor.fetchone.return_value = fetchone
    cursor.fetchall.return_value = [] if fetchall is None else fetchall
    return cursor


def _mock_conn(cursor: MagicMock) -> MagicMock:
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    return conn


def test_node_not_exist_returns_true_when_no_nodes() -> None:
    db = _build_db()
    cursor = _mock_cursor(fetchone=None)
    with patch.object(db, "_get_conn", return_value=_mock_conn(cursor)):
        assert db.node_not_exist("LongTermMemory", user_name="user-1") is True


def test_node_not_exist_returns_false_when_nodes_exist() -> None:
    db = _build_db()
    cursor = _mock_cursor(fetchone=(1,))
    with patch.object(db, "_get_conn", return_value=_mock_conn(cursor)):
        assert db.node_not_exist("LongTermMemory", user_name="user-1") is False


def test_get_memory_count_returns_count() -> None:
    db = _build_db()
    cursor = _mock_cursor(fetchone=(7,))
    with patch.object(db, "_get_conn", return_value=_mock_conn(cursor)):
        assert db.get_memory_count("LongTermMemory", user_name="user-1") == 7


def test_get_edges_outgoing() -> None:
    db = _build_db()
    cursor = _mock_cursor(fetchall=[("a", "b", "MERGED_TO")])
    with patch.object(db, "_get_conn", return_value=_mock_conn(cursor)):
        edges = db.get_edges("a", type="ANY", direction="OUTGOING", user_name="user-1")
    assert edges == [{"from": "a", "to": "b", "type": "MERGED_TO"}]


def test_edge_exists_any_direction() -> None:
    db = _build_db()
    cursor = _mock_cursor(fetchone=(1,))
    with patch.object(db, "_get_conn", return_value=_mock_conn(cursor)):
        assert db.edge_exists("a", "b", "MERGED_TO", direction="ANY", user_name="user-1") is True


def test_get_structure_optimization_candidates_accepts_user_name_kwarg() -> None:
    db = _build_db()
    cursor = _mock_cursor(fetchall=[])
    with patch.object(db, "_get_conn", return_value=_mock_conn(cursor)):
        result = db.get_structure_optimization_candidates("LongTermMemory", user_name="other-user")
    assert result == []
    assert cursor.execute.call_args[0][1] == ("LongTermMemory", "other-user")


def test_search_by_fulltext_stub_returns_empty_list() -> None:
    db = _build_db()
    assert db.search_by_fulltext(["hello"], user_name="user-1") == []
