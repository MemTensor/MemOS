"""
Unit tests for Neo4j fulltext search implementation.

Tests cover:
- Basic fulltext search with query words
- Filtering by scope, status, user_name
- Threshold filtering
- Empty query_words edge case
- Lucene special character escaping
- search_filter and advanced filter conditions
- Fulltext index creation (lazy)
"""

from unittest.mock import MagicMock, patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig


# ────────────────────────────────────────────────────────────────────────────
# Fixtures
# ────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def shared_db_config():
    """Shared-database multi-tenant config (use_multi_db=False)."""
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_db",
        auto_create=False,
        use_multi_db=False,
        user_name="default_user",
        embedding_dimension=3,
    )


@pytest.fixture
def multi_db_config():
    """Multi-database config — no user_name filter in queries."""
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_db",
        auto_create=False,
        use_multi_db=True,
        embedding_dimension=3,
    )


@pytest.fixture
def shared_neo4j_db(shared_db_config):
    """Shared-database Neo4j graph DB with mocked driver."""
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(shared_db_config)
        db.driver = mock_driver
        yield db


@pytest.fixture
def multi_neo4j_db(multi_db_config):
    """Multi-database Neo4j graph DB with mocked driver."""
    with patch("neo4j.GraphDatabase") as mock_gd:
        mock_driver = MagicMock()
        mock_gd.driver.return_value = mock_driver
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB(multi_db_config)
        db.driver = mock_driver
        yield db


# ────────────────────────────────────────────────────────────────────────────
# Tests: search_by_fulltext — basic functionality
# ────────────────────────────────────────────────────────────────────────────


class TestFulltextSearchBasic:
    """Basic fulltext search tests."""

    def test_search_with_single_word(self, shared_neo4j_db):
        """Search with a single query word returns scored results."""
        session_mock = _mock_session_run(shared_neo4j_db, [
            {"id": "mem-1", "score": 0.95},
            {"id": "mem-2", "score": 0.80},
        ])

        results = shared_neo4j_db.search_by_fulltext(
            query_words=["strawberry"],
            top_k=5,
        )

        assert len(results) == 2
        assert results[0] == {"id": "mem-1", "score": 0.95}
        assert results[1] == {"id": "mem-2", "score": 0.80}

        # Verify the Cypher query structure
        query = session_mock.run.call_args[0][0]
        assert "db.index.fulltext.queryNodes" in query
        assert "memory_fulltext_index" in query
        assert "$lucene_query" in query
        assert "ORDER BY score DESC" in query
        assert "LIMIT $top_k" in query

    def test_search_with_multiple_words(self, shared_neo4j_db):
        """Multiple query words are joined with OR in the Lucene query."""
        session_mock = _mock_session_run(shared_neo4j_db, [
            {"id": "mem-1", "score": 0.90},
        ])

        shared_neo4j_db.search_by_fulltext(
            query_words=["apple", "banana", "cherry"],
            top_k=10,
        )

        params = session_mock.run.call_args[0][1]
        lucene = params["lucene_query"]
        assert " OR " in lucene
        assert "apple" in lucene
        assert "banana" in lucene
        assert "cherry" in lucene

    def test_empty_query_words_returns_empty(self, shared_neo4j_db):
        """Empty query_words should return [] without running a query."""
        session_mock = _mock_session_run(shared_neo4j_db, [])

        results = shared_neo4j_db.search_by_fulltext(query_words=[])

        assert results == []
        # Should not have called session.run
        session_mock.run.assert_not_called()

    def test_whitespace_only_words_returns_empty(self, shared_neo4j_db):
        """Whitespace-only query words should be filtered out."""
        session_mock = _mock_session_run(shared_neo4j_db, [])

        results = shared_neo4j_db.search_by_fulltext(query_words=["   ", "\t"])

        assert results == []
        session_mock.run.assert_not_called()

    def test_top_k_limits_results(self, shared_neo4j_db):
        """top_k parameter is passed correctly."""
        session_mock = _mock_session_run(shared_neo4j_db, [{"id": "x", "score": 1.0}])

        shared_neo4j_db.search_by_fulltext(query_words=["test"], top_k=3)

        params = session_mock.run.call_args[0][1]
        assert params["top_k"] == 3


# ────────────────────────────────────────────────────────────────────────────
# Tests: search_by_fulltext — filtering
# ────────────────────────────────────────────────────────────────────────────


class TestFulltextSearchFiltering:
    """Tests for scope, status, user_name, and other filters."""

    def test_scope_filter(self, shared_neo4j_db):
        """scope filter adds 'node.memory_type = $scope' in WHERE."""
        session_mock = _mock_session_run(shared_neo4j_db, [{"id": "a", "score": 0.9}])

        shared_neo4j_db.search_by_fulltext(
            query_words=["test"],
            scope="WorkingMemory",
        )

        query = session_mock.run.call_args[0][0]
        params = session_mock.run.call_args[0][1]
        assert "node.memory_type = $scope" in query
        assert params["scope"] == "WorkingMemory"

    def test_status_filter(self, shared_neo4j_db):
        """status filter adds 'node.status = $status' in WHERE."""
        session_mock = _mock_session_run(shared_neo4j_db, [{"id": "a", "score": 0.9}])

        shared_neo4j_db.search_by_fulltext(
            query_words=["test"],
            status="activated",
        )

        query = session_mock.run.call_args[0][0]
        params = session_mock.run.call_args[0][1]
        assert "node.status = $status" in query
        assert params["status"] == "activated"

    def test_user_name_filter_shared_db(self, shared_neo4j_db):
        """User name filter is added in shared-database mode."""
        session_mock = _mock_session_run(shared_neo4j_db, [{"id": "a", "score": 0.9}])

        shared_neo4j_db.search_by_fulltext(
            query_words=["test"],
            user_name="alice",
        )

        query = session_mock.run.call_args[0][0]
        assert "user_name" in _get_where_clause(query)

    def test_no_user_name_filter_multi_db(self, multi_neo4j_db):
        """No user_name filter in multi-database mode."""
        session_mock = _mock_session_run(multi_neo4j_db, [{"id": "a", "score": 0.9}])

        multi_neo4j_db.search_by_fulltext(
            query_words=["test"],
        )

        query = session_mock.run.call_args[0][0]
        where = _get_where_clause(query)
        assert "user_name" not in where

    def test_search_filter(self, shared_neo4j_db):
        """search_filter adds equality constraints."""
        session_mock = _mock_session_run(shared_neo4j_db, [{"id": "a", "score": 0.9}])

        shared_neo4j_db.search_by_fulltext(
            query_words=["test"],
            search_filter={"tags": "important"},
        )

        query = session_mock.run.call_args[0][0]
        params = session_mock.run.call_args[0][1]
        assert "node.tags = $filter_tags" in query
        assert params["filter_tags"] == "important"

    def test_search_filter_rejects_invalid_key(self, shared_neo4j_db):
        """Invalid filter keys (Cypher injection attempt) are skipped."""
        session_mock = _mock_session_run(shared_neo4j_db, [{"id": "a", "score": 0.9}])

        shared_neo4j_db.search_by_fulltext(
            query_words=["test"],
            search_filter={"x} DETACH DELETE n //": "evil"},
        )

        query = session_mock.run.call_args[0][0]
        assert "DETACH DELETE" not in query


# ────────────────────────────────────────────────────────────────────────────
# Tests: search_by_fulltext — threshold
# ────────────────────────────────────────────────────────────────────────────


class TestFulltextSearchThreshold:
    """Threshold filtering tests (applied in Cypher, not Python)."""

    def test_threshold_added_to_cypher_query(self, shared_neo4j_db):
        """When threshold is set, it's pushed into the Cypher WHERE clause."""
        session_mock = _mock_session_run(shared_neo4j_db, [
            {"id": "a", "score": 0.90},
        ])

        shared_neo4j_db.search_by_fulltext(
            query_words=["test"],
            threshold=0.50,
        )

        query = session_mock.run.call_args[0][0]
        params = session_mock.run.call_args[0][1]
        assert "score >= $threshold" in query
        assert params["threshold"] == 0.50

    def test_no_threshold_returns_all(self, shared_neo4j_db):
        """Without threshold, no score filter in query."""
        session_mock = _mock_session_run(shared_neo4j_db, [
            {"id": "a", "score": 0.10},
        ])

        shared_neo4j_db.search_by_fulltext(query_words=["test"])

        query = session_mock.run.call_args[0][0]
        assert "score >= $threshold" not in query


# ────────────────────────────────────────────────────────────────────────────
# Tests: Lucene escaping
# ────────────────────────────────────────────────────────────────────────────


class TestLuceneEscaping:
    """Tests for _escape_lucene_query static method."""

    @staticmethod
    def _escape(term):
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        return Neo4jGraphDB._escape_lucene_query(term)

    def test_plain_word_passes_through(self):
        """Plain word is returned unchanged."""
        assert self._escape("hello") == "hello"

    def test_plus_sign_escaped(self):
        """'+' is escaped."""
        assert self._escape("C++") == "C\\+\\+"

    def test_parentheses_escaped(self):
        """Parentheses are escaped."""
        escaped = self._escape("func(arg)")
        assert "\\(" in escaped
        assert "\\)" in escaped

    def test_colon_escaped(self):
        """Colon is escaped."""
        assert self._escape("key:value") == "key\\:value"

    def test_bracket_escaped(self):
        """Brackets are escaped."""
        escaped = self._escape("[test]")
        assert "\\[" in escaped
        assert "\\]" in escaped

    def test_empty_string(self):
        """Empty string is returned as-is."""
        assert self._escape("") == ""

    def test_special_chars_only_wildcard_not_escaped(self):
        """A lone wildcard '*' is preserved for prefix queries."""
        escaped = self._escape("*")
        assert escaped == "*"

    def test_wildcard_in_mixed_term_is_escaped(self):
        """Wildcard '*' within a regular term should be escaped."""
        escaped = self._escape("foo*")
        assert escaped == "foo\\*"


# ────────────────────────────────────────────────────────────────────────────
# Tests: Fulltext index creation
# ────────────────────────────────────────────────────────────────────────────


class TestFulltextIndexCreation:
    """Tests for _ensure_fulltext_index and related methods."""

    def test_index_creation_called_on_first_search(self, shared_neo4j_db):
        """First fulltext search triggers index creation."""
        session_mock = shared_neo4j_db.driver.session.return_value
        session_mock.__enter__.return_value = session_mock

        # Override run return values for the search call
        def run_side_effect(query, *args, **kwargs):
            mock_result = MagicMock()
            if "SHOW FULLTEXT" in query:
                mock_result.single.return_value = None
            elif "CREATE FULLTEXT" in query:
                mock_result.single.return_value = None
            else:
                mock_result.__iter__.return_value = iter([])
            return mock_result

        session_mock.run.side_effect = run_side_effect

        shared_neo4j_db.search_by_fulltext(query_words=["hello"])

        # Verify CREATE FULLTEXT INDEX was called
        create_calls = [
            c for c in session_mock.run.call_args_list
            if "CREATE FULLTEXT" in str(c)
        ]
        assert len(create_calls) >= 1


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────


def _mock_session_run(db, return_rows):
    """Set up a mocked session.run that dispatches by query content.

    Index-related calls (SHOW/CREATE FULLTEXT INDEX) return appropriate
    stubs so they don't interfere with the search query assertions.
    """
    session_mock = db.driver.session.return_value
    session_mock.__enter__.return_value = session_mock

    def _make_record(row):
        mock_record = MagicMock()
        mock_record.__getitem__.side_effect = row.__getitem__
        mock_record.keys.return_value = row.keys()
        return mock_record

    search_records = [_make_record(r) for r in return_rows]

    def _run_side_effect(query, *args, **kwargs):
        mock_result = MagicMock()
        if "SHOW FULLTEXT" in query:
            mock_result.single.return_value = None  # index doesn't exist
        elif "CREATE FULLTEXT" in query:
            mock_result.single.return_value = None
        else:
            # Search query — return the test data
            mock_result.__iter__.return_value = iter(search_records)
        return mock_result

    session_mock.run.side_effect = _run_side_effect
    return session_mock


def _get_where_clause(query: str) -> str:
    """Extract the WHERE clause from a Cypher query."""
    idx = query.find("WHERE ")
    if idx == -1:
        return ""
    limit_idx = query.find("RETURN", idx)
    if limit_idx == -1:
        limit_idx = query.find("ORDER BY", idx)
    if limit_idx == -1:
        return query[idx:]
    return query[idx:limit_idx]
