"""
Regression tests for issue #2270: PostgresGraphDB embedding normalization.

Ensures `_parse_row` normalises pgvector output to `list[float] | None`
regardless of whether psycopg2 returned a Python list or the raw pgvector
text form. Prevents the pydantic ValidationError that crashed the
reorganizer consumer when `MOS_ENABLE_REORGANIZE=true` and
`GRAPH_DB_BACKEND=postgres`.
"""

from unittest.mock import patch

import pytest


NODE_UUID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def postgres_db():
    """Create a bare PostgresGraphDB instance without hitting a real DB."""
    with patch("memos.graph_dbs.postgres.PostgresGraphDB.__init__", return_value=None):
        from memos.graph_dbs.postgres import PostgresGraphDB

        db = PostgresGraphDB.__new__(PostgresGraphDB)
        db.schema = "memos"
        db.user_name = "test_user"
        yield db


class TestNormalizeEmbeddingHelper:
    """Direct unit tests for the module-level `_normalize_embedding` helper."""

    def test_none_returns_none(self):
        from memos.graph_dbs.postgres import _normalize_embedding

        assert _normalize_embedding(None) is None

    def test_list_of_floats_passthrough(self):
        from memos.graph_dbs.postgres import _normalize_embedding

        assert _normalize_embedding([0.1, 0.2, 0.3]) == [0.1, 0.2, 0.3]

    def test_list_of_ints_coerced_to_float(self):
        from memos.graph_dbs.postgres import _normalize_embedding

        result = _normalize_embedding([1, 2, 3])
        assert result == [1.0, 2.0, 3.0]
        assert all(isinstance(v, float) for v in result)

    def test_pgvector_text_form_parsed_to_list_of_floats(self):
        """
        The pgvector Postgres text form of a vector is `[0.1, 0.2, ...]`.
        psycopg2 without a type adapter returns this as a str; the helper
        must parse it into `list[float]`.
        """
        from memos.graph_dbs.postgres import _normalize_embedding

        text = "[-0.047, 0.512, 0.001]"
        result = _normalize_embedding(text)

        assert isinstance(result, list)
        assert result == [-0.047, 0.512, 0.001]
        assert all(isinstance(v, float) for v in result)

    def test_pgvector_paren_text_form_parsed(self):
        """Some drivers may render pgvector with parens instead of brackets."""
        from memos.graph_dbs.postgres import _normalize_embedding

        result = _normalize_embedding("(0.1, 0.2, 0.3)")
        assert result == [0.1, 0.2, 0.3]

    def test_empty_string_returns_none(self):
        from memos.graph_dbs.postgres import _normalize_embedding

        assert _normalize_embedding("") is None
        assert _normalize_embedding("   ") is None

    def test_invalid_string_returns_none_and_warns(self, caplog):
        from memos.graph_dbs.postgres import _normalize_embedding

        with caplog.at_level("WARNING", logger="memos.graph_dbs.postgres"):
            result = _normalize_embedding("not-a-vector")
        assert result is None
        assert any(
            r.levelname == "WARNING" and r.name == "memos.graph_dbs.postgres"
            for r in caplog.records
        ), (
            "Expected a WARNING record from memos.graph_dbs.postgres so silent"
            " no-log regressions get caught."
        )

    def test_unexpected_type_returns_none(self, caplog):
        from memos.graph_dbs.postgres import _normalize_embedding

        with caplog.at_level("WARNING", logger="memos.graph_dbs.postgres"):
            result = _normalize_embedding(12345)
        assert result is None
        assert any(
            r.levelname == "WARNING" and r.name == "memos.graph_dbs.postgres"
            for r in caplog.records
        ), (
            "Expected a WARNING record from memos.graph_dbs.postgres so silent"
            " no-log regressions get caught."
        )

    @pytest.mark.parametrize("bad_input", ["[0.1, 0.2)", "(0.1, 0.2]"])
    def test_mismatched_bracket_delimiters_return_none_and_warn(
        self, caplog, bad_input
    ):
        """
        pgvector never emits mismatched delimiters, but if any subtly
        malformed data reaches the helper it must be flagged rather than
        silently coerced into a numeric list.
        """
        from memos.graph_dbs.postgres import _normalize_embedding

        with caplog.at_level("WARNING", logger="memos.graph_dbs.postgres"):
            result = _normalize_embedding(bad_input)
        assert result is None
        assert any(
            r.levelname == "WARNING" and r.name == "memos.graph_dbs.postgres"
            for r in caplog.records
        ), (
            "Mismatched bracket delimiters must produce a WARNING record so"
            " malformed input never silently succeeds."
        )


class TestParseRowEmbedding:
    """
    Integration tests for `_parse_row` covering the string branch that
    caused issue #2270. Uses a fake row tuple to bypass psycopg2.
    """

    def _row(self, embedding_col):
        import datetime as dt

        return (
            NODE_UUID,  # id (must be a valid UUID for GraphDBNode validation)
            "hello memory",  # memory
            {"memory_type": "LongTermMemory"},  # properties (already a dict)
            dt.datetime(2026, 1, 1, 12, 0, 0),  # created_at
            dt.datetime(2026, 1, 2, 12, 0, 0),  # updated_at
            embedding_col,  # embedding column (either str or list)
        )

    def test_parse_row_with_pgvector_string_returns_list_of_floats(self, postgres_db):
        row = self._row("[-0.047, 0.512, 0.001]")
        result = postgres_db._parse_row(row, include_embedding=True)

        embedding = result["metadata"]["embedding"]
        assert isinstance(embedding, list)
        assert embedding == [-0.047, 0.512, 0.001]
        assert all(isinstance(v, float) for v in embedding)

    def test_parse_row_with_list_embedding_passthrough(self, postgres_db):
        row = self._row([0.1, 0.2, 0.3])
        result = postgres_db._parse_row(row, include_embedding=True)

        assert result["metadata"]["embedding"] == [0.1, 0.2, 0.3]

    def test_parse_row_without_include_embedding_omits_field(self, postgres_db):
        # Row without embedding column trailing (len(row) == 5).
        import datetime as dt

        row = (
            NODE_UUID,
            "hello",
            {"memory_type": "LongTermMemory"},
            dt.datetime(2026, 1, 1),
            dt.datetime(2026, 1, 2),
        )
        result = postgres_db._parse_row(row, include_embedding=False)
        assert "embedding" not in result["metadata"]

    def test_parse_row_null_embedding_yields_none(self, postgres_db):
        row = self._row(None)
        result = postgres_db._parse_row(row, include_embedding=True)
        assert result["metadata"]["embedding"] is None

    def test_parse_row_output_feeds_graphdbnode_without_validation_error(self, postgres_db):
        """
        End-to-end reproduction of the bug in issue #2270: the row from
        `get_node(include_embedding=True)` was fed into `GraphDBNode(**raw)`
        and pydantic rejected the string embedding. After the fix, this
        construction succeeds.
        """
        from memos.graph_dbs.item import GraphDBNode

        row = self._row("[-0.047, 0.512, 0.001]")
        raw = postgres_db._parse_row(row, include_embedding=True)

        # Must not raise pydantic_core.ValidationError.
        node = GraphDBNode(**raw)
        assert node.metadata.embedding == [-0.047, 0.512, 0.001]
