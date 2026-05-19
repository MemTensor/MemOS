"""
Tests for CWE-89 fix: Cypher injection in PolarDBGraphDB.edge_exists()

Validates that source_id, target_id, user_name, and type parameters are
escaped via escape_sql_string() before being interpolated into the Cypher
query, preventing injection attacks.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def polardb_instance():
    """Create a PolarDBGraphDB instance with mocked dependencies."""
    with patch("memos.graph_dbs.polardb.PolarDBGraphDB.__init__", return_value=None):
        from memos.graph_dbs.polardb import PolarDBGraphDB

        db = PolarDBGraphDB.__new__(PolarDBGraphDB)
        db.db_name = "test_db"
        db.user_name = "default_user"
        db.config = MagicMock()
        db.config.user_name = "default_user"
        yield db


def _make_mock_conn_cursor():
    """Create mocked connection and cursor with context-manager support."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=False)
    mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
    mock_cursor.__exit__ = MagicMock(return_value=False)
    mock_conn.cursor.return_value = mock_cursor
    mock_cursor.fetchone.return_value = None  # no edge found
    return mock_conn, mock_cursor


class TestEdgeExistsCWE89Fix:
    """Tests that edge_exists() escapes user-supplied values to prevent injection."""

    def test_source_id_injection_escaped(self, polardb_instance):
        """A single-quote in source_id must be doubled, not passed raw."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()
        malicious_source = "x' OR 1=1 --"

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id=malicious_source,
                target_id="legit_target",
                user_name="user1",
            )

            query = mock_cursor.execute.call_args[0][0]
            # The raw injection payload should NOT appear unescaped
            assert "x' OR 1=1 --" not in query, (
                "Raw injection payload in source_id must not appear in query"
            )
            # The escaped form (doubled single quotes) should be present
            assert "x'' OR 1=1 --" in query, (
                "source_id single quotes must be doubled via escape_sql_string()"
            )

    def test_target_id_injection_escaped(self, polardb_instance):
        """A single-quote in target_id must be doubled, not passed raw."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()
        malicious_target = "y' RETURN n //"

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id="legit_source",
                target_id=malicious_target,
                user_name="user1",
            )

            query = mock_cursor.execute.call_args[0][0]
            assert "y' RETURN" not in query, (
                "Raw injection payload in target_id must not appear in query"
            )
            assert "y'' RETURN" in query

    def test_user_name_injection_escaped(self, polardb_instance):
        """A single-quote in user_name must be doubled, not passed raw."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()
        malicious_user = "admin' OR 1=1 --"

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id="src",
                target_id="tgt",
                user_name=malicious_user,
            )

            query = mock_cursor.execute.call_args[0][0]
            assert "admin' OR 1=1 --" not in query, (
                "Raw injection payload in user_name must not appear in query"
            )
            assert "admin'' OR 1=1 --" in query

    def test_type_injection_escaped(self, polardb_instance):
        """A single-quote in type must be doubled, not passed raw."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()
        malicious_type = "PARENT' OR 1=1 --"

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id="src",
                target_id="tgt",
                type=malicious_type,
                user_name="user1",
            )

            query = mock_cursor.execute.call_args[0][0]
            assert "PARENT' OR 1=1 --" not in query, (
                "Raw injection payload in type must not appear in query"
            )
            assert "PARENT'' OR 1=1 --" in query

    def test_clean_values_no_double_escaping(self, polardb_instance):
        """Clean values without quotes should pass through unchanged."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id="abc-123",
                target_id="def-456",
                type="PARENT",
                user_name="test_user",
            )

            query = mock_cursor.execute.call_args[0][0]
            assert "a.id = 'abc-123'" in query
            assert "b.id = 'def-456'" in query
            assert "a.user_name = 'test_user'" in query
            assert "type(r) = 'PARENT'" in query

    def test_direction_any_works(self, polardb_instance):
        """Direction=ANY should use undirected match pattern."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id="src",
                target_id="tgt",
                direction="ANY",
                user_name="user1",
            )

            query = mock_cursor.execute.call_args[0][0]
            assert "(a:Memory)-[r]-(b:Memory)" in query

    def test_direction_incoming_works(self, polardb_instance):
        """Direction=INCOMING should use incoming pattern."""
        mock_conn, mock_cursor = _make_mock_conn_cursor()

        with patch.object(polardb_instance, "_get_connection") as mock_get_conn:
            mock_get_conn.return_value = mock_conn

            polardb_instance.edge_exists(
                source_id="src",
                target_id="tgt",
                direction="INCOMING",
                user_name="user1",
            )

            query = mock_cursor.execute.call_args[0][0]
            assert "(a:Memory)<-[r]-(b:Memory)" in query


class TestEdgeExistsSourceCodeSafety:
    """Verify the source code of edge_exists() directly to confirm no raw injection patterns."""

    def _get_method_source(self) -> str:
        """Read the edge_exists() method source directly from the file.

        Finds the @timed-decorated edge_exists (not edge_exists_old).
        """
        polardb_path = (
            Path(__file__).resolve().parents[2]
            / "src"
            / "memos"
            / "graph_dbs"
            / "polardb.py"
        )
        source = polardb_path.read_text()
        lines = source.split("\n")
        in_method = False
        method_lines = []
        indent = None
        for i, line in enumerate(lines):
            # Match the @timed edge_exists, not edge_exists_old
            if (
                "def edge_exists(" in line
                and "edge_exists_old" not in line
                and i > 0
                and "@timed" in lines[i - 1]
            ):
                in_method = True
                indent = len(line) - len(line.lstrip())
                method_lines.append(line)
                continue
            if in_method:
                stripped = line.lstrip()
                current_indent = len(line) - len(line.lstrip()) if stripped else indent + 4
                if stripped.startswith("def ") and current_indent <= indent:
                    break
                if stripped.startswith("@") and current_indent <= indent:
                    break
                method_lines.append(line)
        return "\n".join(method_lines)

    def test_no_raw_user_name_interpolation(self):
        """edge_exists() should not have raw {user_name} in f-string."""
        source = self._get_method_source()
        assert source, "Should have found edge_exists() method source"
        assert "'{user_name}'" not in source, (
            "edge_exists() should NOT have raw f-string '{user_name}' interpolation"
        )

    def test_no_raw_source_id_interpolation(self):
        """edge_exists() should not have raw {source_id} in f-string."""
        source = self._get_method_source()
        assert source, "Should have found edge_exists() method source"
        assert "'{source_id}'" not in source, (
            "edge_exists() should NOT have raw f-string '{source_id}' interpolation"
        )

    def test_no_raw_target_id_interpolation(self):
        """edge_exists() should not have raw {target_id} in f-string."""
        source = self._get_method_source()
        assert source, "Should have found edge_exists() method source"
        assert "'{target_id}'" not in source, (
            "edge_exists() should NOT have raw f-string '{target_id}' interpolation"
        )

    def test_uses_escape_sql_string(self):
        """edge_exists() should call escape_sql_string for user-supplied values."""
        source = self._get_method_source()
        assert source, "Should have found edge_exists() method source"
        assert "escape_sql_string" in source, (
            "edge_exists() should use escape_sql_string() for escaping"
        )
