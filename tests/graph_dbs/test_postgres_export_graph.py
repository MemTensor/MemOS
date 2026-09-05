"""Unit tests for PostgresGraphDB.export_graph pagination and filtering."""

from __future__ import annotations

import json

from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

from memos.graph_dbs.postgres import PostgresGraphDB


SCHEMA = "test_schema"
USER_NAME = "user-1"


def _row(node_id: str, memory: str, memory_type: str = "UserMemory"):
    props = {"memory_type": memory_type, "tags": ["写作风格"]}
    return (
        node_id,
        memory,
        json.dumps(props),
        datetime(2026, 8, 22, 12, 0, 0),
        datetime(2026, 8, 22, 12, 0, 0),
    )


class _FakeCursor:
    """Cursor that serves queued results in order and records executed SQL."""

    def __init__(self, results: list[Any]):
        self.results = list(results)
        self.executed: list[tuple[str, list]] = []

    def execute(self, query: str, params=None):
        self.executed.append((query, list(params or [])))
        self._current = self.results.pop(0)

    def fetchone(self):
        return self._current

    def fetchall(self):
        return self._current

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeConn:
    def __init__(self, results: list[Any]):
        self.cursor_obj = _FakeCursor(results)

    def cursor(self):
        return self.cursor_obj


def _build_db(results: list[Any]) -> tuple[PostgresGraphDB, _FakeCursor]:
    with (
        patch("memos.graph_dbs.postgres.require_python_package", lambda **kwargs: lambda fn: fn),
        patch("psycopg2.pool.ThreadedConnectionPool", MagicMock()),
        patch.object(PostgresGraphDB, "_init_schema", lambda self: None),
    ):
        config = MagicMock()
        config.schema_name = SCHEMA
        config.user_name = USER_NAME
        db = PostgresGraphDB(config)
    conn = _FakeConn(results)
    db._get_conn = lambda: conn
    return db, conn.cursor_obj


def test_export_graph_paginates_with_total_count() -> None:
    """page/page_size must translate to LIMIT/OFFSET and total comes from COUNT, not page size."""
    db, cursor = _build_db(
        results=[[9], [_row("n7", "m7"), _row("n8", "m8"), _row("n9", "m9")], []]
    )

    result = db.export_graph(page=2, page_size=6)

    count_sql, _count_params = cursor.executed[0]
    assert "COUNT(*)" in count_sql

    select_sql, select_params = cursor.executed[1]
    assert "LIMIT %s OFFSET %s" in select_sql
    assert select_params[-2:] == [6, 6]

    assert result["total_nodes"] == 9
    assert len(result["nodes"]) == 3


def test_export_graph_edges_resolve_against_full_filtered_set() -> None:
    """Edges must resolve via subqueries over the full filtered node set, not page-local ids."""
    db, cursor = _build_db(
        results=[
            [9],
            [_row("n7", "m7"), _row("n8", "m8"), _row("n9", "m9")],
            [("n7", "n1", "rel")],
        ]
    )

    result = db.export_graph(page=2, page_size=6, filter={"tags": {"contains": "写作风格"}})

    edges_sql, edges_params = cursor.executed[2]
    assert edges_sql.count("SELECT id FROM test_schema.memories WHERE") == 2
    assert "source_id IN" in edges_sql and "target_id IN" in edges_sql
    # filter params are applied to both subqueries (user_name + tags containment, twice)
    assert edges_params.count(json.dumps(["写作风格"])) == 2
    assert result["edges"] == [{"source": "n7", "target": "n1", "type": "rel"}]
    assert result["total_edges"] == 1


def test_export_graph_without_pagination_returns_all() -> None:
    db, cursor = _build_db(results=[[2], [_row("n1", "m1"), _row("n2", "m2")], []])

    result = db.export_graph()

    select_sql, _select_params = cursor.executed[1]
    assert "LIMIT" not in select_sql
    assert result["total_nodes"] == 2
    assert len(result["nodes"]) == 2


def test_export_graph_applies_memory_type_and_status_filters() -> None:
    db, cursor = _build_db(results=[[0], [], []])

    db.export_graph(memory_type=["UserMemory", "LongTermMemory"])

    count_sql, count_params = cursor.executed[0]
    assert "properties->>'memory_type' = ANY(%s)" in count_sql
    assert ["UserMemory", "LongTermMemory"] in count_params
    assert "properties->>'status' <> 'deleted'" in count_sql


def test_export_graph_applies_tag_filter() -> None:
    """Tag filter (contains) must reach the SQL WHERE clause as a jsonb containment check."""
    db, cursor = _build_db(results=[[1], [_row("n1", "m1")], []])

    db.export_graph(filter={"tags": {"contains": "写作风格"}})

    count_sql, count_params = cursor.executed[0]
    assert "properties->'tags' @> %s::jsonb" in count_sql
    assert json.dumps(["写作风格"]) in count_params


def test_export_graph_invalid_pagination_inputs_are_normalized() -> None:
    db, cursor = _build_db(results=[[0], [], []])

    db.export_graph(page=0, page_size=-3)

    select_sql, select_params = cursor.executed[1]
    assert "LIMIT %s OFFSET %s" in select_sql
    assert select_params[-2:] == [10, 0]
