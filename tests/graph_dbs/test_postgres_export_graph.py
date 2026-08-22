"""
Regression tests for issue #2271:
`PostgresGraphDB.export_graph` must respect page / page_size / memory_type / status / filter
and return an accurate `total_nodes` count (matching the filter, not the returned page).

These tests exercise SQL construction only (they don't require a live Postgres). The
Postgres connection pool and cursor are mocked out; the tests assert on the SQL
fragments and parameters that the implementation passes to `cursor.execute`, plus the
shape of the returned dict.
"""

from __future__ import annotations

import sys
import types

from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest


# Make `import psycopg2` inside `memos.graph_dbs.postgres` a no-op so this test
# module can run without the real driver installed.
if "psycopg2" not in sys.modules:
    _fake_psycopg2 = types.ModuleType("psycopg2")
    _fake_pool = types.ModuleType("psycopg2.pool")
    _fake_pool.ThreadedConnectionPool = MagicMock()
    _fake_psycopg2.pool = _fake_pool
    sys.modules["psycopg2"] = _fake_psycopg2
    sys.modules["psycopg2.pool"] = _fake_pool


# --------------------------------------------------------------------------- #
# Fixtures                                                                    #
# --------------------------------------------------------------------------- #


class _FakeCursor:
    """Minimal cursor stand-in that records executed SQL and returns canned rows.

    - `execute(sql, params=None)` appends `(sql, params)` to `calls` and stores the
      next canned response in `self._next_rows` (popped from `responses`).
    - `fetchall()` returns `self._next_rows` (list of tuples).
    - `fetchone()` returns `self._next_rows[0]` if present.
    """

    def __init__(self, responses: list[Any]):
        self._responses = list(responses)
        self._next_rows: Any = []
        self.calls: list[tuple[str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False

    def execute(self, sql: str, params: Any = None):
        self.calls.append((sql, params))
        if self._responses:
            self._next_rows = self._responses.pop(0)
        else:
            self._next_rows = []

    def fetchall(self):
        rows = self._next_rows
        return rows if isinstance(rows, list) else [rows]

    def fetchone(self):
        rows = self._next_rows
        if isinstance(rows, list):
            return rows[0] if rows else None
        return rows


class _FakeConn:
    def __init__(self, cursor: _FakeCursor):
        self._cursor = cursor
        self.autocommit = True

    def cursor(self):
        return self._cursor


@pytest.fixture
def postgres_db():
    """Build a PostgresGraphDB with all IO fully mocked out."""
    from memos.configs.graph_db import PostgresGraphDBConfig
    from memos.graph_dbs.postgres import PostgresGraphDB

    config = PostgresGraphDBConfig(
        host="localhost",
        port=5432,
        user="test",
        password="test",
        db_name="test_db",
        schema_name="memos",
        user_name="alice",
        use_multi_db=False,
        embedding_dimension=3,
    )

    # Bypass real _init_schema (it runs SQL during __init__)
    with patch.object(PostgresGraphDB, "_init_schema", return_value=None):
        db = PostgresGraphDB(config)

    yield db


def _install_cursor(db, responses: list[Any]) -> _FakeCursor:
    """Attach a fake cursor + connection to the mocked pool so SQL calls are captured."""
    cursor = _FakeCursor(responses)
    conn = _FakeConn(cursor)
    db._get_conn = MagicMock(return_value=conn)  # type: ignore[method-assign]
    db._put_conn = MagicMock()  # type: ignore[method-assign]
    return cursor


def _mk_row(node_id: str, memory: str = "m", props: dict | None = None):
    """Build a row tuple in the shape `_parse_row` expects."""
    now = datetime(2026, 8, 22, 12, 0, 0)
    return (node_id, memory, props or {}, now, now)


# --------------------------------------------------------------------------- #
# Tests                                                                       #
# --------------------------------------------------------------------------- #


class TestPostgresExportGraphPagination:
    """LIMIT/OFFSET must be applied when page + page_size are supplied."""

    def test_pagination_applies_limit_and_offset(self, postgres_db):
        # Page 2, size 3 -> LIMIT 3 OFFSET 3
        page_rows = [_mk_row(f"n{i}") for i in range(3)]
        cursor = _install_cursor(
            postgres_db,
            responses=[
                [(42,)],  # count query -> 42 matching nodes
                page_rows,  # data page
                [],  # edges (no edges relevant)
            ],
        )

        result = postgres_db.export_graph(page=2, page_size=3)

        # Assert nodes come from the mocked page and total is the filtered count,
        # NOT `len(nodes)`.
        assert [n["id"] for n in result["nodes"]] == ["n0", "n1", "n2"]
        assert result["total_nodes"] == 42

        # At least one query must contain LIMIT + OFFSET.
        data_sql = " ".join(sql for sql, _ in cursor.calls)
        assert "LIMIT" in data_sql.upper()
        assert "OFFSET" in data_sql.upper()

    def test_no_pagination_returns_all(self, postgres_db):
        rows = [_mk_row(f"n{i}") for i in range(5)]
        cursor = _install_cursor(
            postgres_db,
            responses=[
                [(5,)],  # count
                rows,  # data
                [],  # edges
            ],
        )

        result = postgres_db.export_graph()
        assert result["total_nodes"] == 5
        assert len(result["nodes"]) == 5

        data_sql = " ".join(sql for sql, _ in cursor.calls)
        # Without page/page_size, no LIMIT/OFFSET must appear on the node query.
        # (Count query never has LIMIT, so absence across all calls is a strong
        # signal.)
        assert "LIMIT" not in data_sql.upper()
        assert "OFFSET" not in data_sql.upper()


class TestPostgresExportGraphFilters:
    """memory_type / status / filter must reach the WHERE clause."""

    def test_memory_type_filter(self, postgres_db):
        cursor = _install_cursor(
            postgres_db,
            responses=[
                [(1,)],
                [_mk_row("n1", props={"memory_type": "LongTermMemory"})],
                [],
            ],
        )

        postgres_db.export_graph(memory_type=["LongTermMemory"])

        # Params of the count and data queries must contain the memory_type value
        # (either directly or inside an "= ANY(list)" list parameter).
        flat: list[Any] = []
        for _sql, params in cursor.calls:
            if not params:
                continue
            for p in params:
                if isinstance(p, list):
                    flat.extend(p)
                else:
                    flat.append(p)
        assert "LongTermMemory" in flat

    def test_status_default_excludes_deleted(self, postgres_db):
        cursor = _install_cursor(
            postgres_db,
            responses=[
                [(1,)],
                [_mk_row("n1")],
                [],
            ],
        )

        postgres_db.export_graph()

        # Default (status=None) must add a "not deleted" predicate to align with
        # neo4j.export_graph.
        combined_sql = " ".join(sql for sql, _ in cursor.calls).lower()
        assert "deleted" in combined_sql

    def test_status_explicit_list(self, postgres_db):
        cursor = _install_cursor(
            postgres_db,
            responses=[
                [(1,)],
                [_mk_row("n1")],
                [],
            ],
        )

        postgres_db.export_graph(status=["activated"])

        flat: list[Any] = []
        for _sql, params in cursor.calls:
            if not params:
                continue
            for p in params:
                if isinstance(p, list):
                    flat.extend(p)
                else:
                    flat.append(p)
        assert "activated" in flat

    def test_filter_tags_reach_sql(self, postgres_db):
        cursor = _install_cursor(
            postgres_db,
            responses=[
                [(2,)],
                [_mk_row("n1"), _mk_row("n2")],
                [],
            ],
        )

        postgres_db.export_graph(filter={"and": [{"tags": "urgent"}]})

        # `tags` is treated as a JSON array; PostgresGraphDB's
        # `_build_single_filter_condition` renders that as `... @> %s::jsonb`
        # with the value JSON-encoded.
        combined_sql = " ".join(sql for sql, _ in cursor.calls)
        assert "@>" in combined_sql
        # The urgent tag must appear (JSON-encoded) somewhere in the params.
        joined_param_strs = []
        for _sql, params in cursor.calls:
            if params:
                joined_param_strs.extend(str(p) for p in params)
        assert any("urgent" in p for p in joined_param_strs)


class TestPostgresExportGraphResultShape:
    def test_total_nodes_is_full_count_not_page_len(self, postgres_db):
        """The bug: total_nodes used to == len(page). Assert it's the filtered count."""
        page_rows = [_mk_row(f"n{i}") for i in range(2)]  # page size 2
        _install_cursor(
            postgres_db,
            responses=[
                [(17,)],  # full filtered count
                page_rows,
                [],
            ],
        )

        result = postgres_db.export_graph(page=1, page_size=2)
        assert result["total_nodes"] == 17
        assert len(result["nodes"]) == 2
        assert result["total_nodes"] != len(result["nodes"])
