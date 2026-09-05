"""Regression tests for PostgresGraphDB embedding normalization."""

from __future__ import annotations

import json

from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from memos.graph_dbs.postgres import (
    PostgresGraphDB,
    _normalize_embedding_value,
    _prepare_node_metadata,
)


def test_normalize_embedding_value_parses_json_string() -> None:
    assert _normalize_embedding_value("[0.5, -1.0]") == [0.5, -1.0]


def test_normalize_embedding_value_coerces_numeric_list() -> None:
    assert _normalize_embedding_value([2, 3]) == [2.0, 3.0]


def test_normalize_embedding_value_rejects_invalid_string() -> None:
    assert _normalize_embedding_value("not-json") is None


@pytest.mark.parametrize(
    "embedding",
    [["a", 0.5], '["a", 0.5]'],
)
def test_normalize_embedding_value_rejects_non_numeric_elements(embedding) -> None:
    assert _normalize_embedding_value(embedding) is None


def test_prepare_node_metadata_normalizes_string_embedding() -> None:
    metadata = _prepare_node_metadata({"embedding": "[0.25, 0.75]"})
    assert metadata["embedding"] == [0.25, 0.75]


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


def test_parse_row_normalizes_string_embedding_from_vector_column() -> None:
    db = _build_db()
    row: tuple[Any, ...] = (
        "node-1",
        "memory text",
        json.dumps({"memory_type": "UserMemory"}),
        datetime(2026, 8, 22, 12, 0, 0),
        datetime(2026, 8, 22, 12, 0, 0),
        "[0.25, 0.75]",
    )

    parsed = db._parse_row(row, include_embedding=True)

    assert parsed["metadata"]["embedding"] == [0.25, 0.75]


def test_parse_row_preserves_props_embedding_when_not_requested() -> None:
    db = _build_db()
    row: tuple[Any, ...] = (
        "node-1",
        "memory text",
        json.dumps({"memory_type": "UserMemory", "embedding": "[0.1, 0.2]"}),
        datetime(2026, 8, 22, 12, 0, 0),
        datetime(2026, 8, 22, 12, 0, 0),
    )

    parsed = db._parse_row(row, include_embedding=False)

    assert parsed["metadata"]["embedding"] == "[0.1, 0.2]"
