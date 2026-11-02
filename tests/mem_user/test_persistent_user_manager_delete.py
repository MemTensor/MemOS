"""
Regression tests for PersistentUserManager configuration/deletion consistency.

Covers the bug where a refused protected-user (ROOT) deletion removed the
persisted configuration while the user itself remained active, for both the
SQLite (PersistentUserManager) and the shared persistent-manager contract.

See issue #2502.
"""

import os
import sqlite3
import tempfile

from unittest.mock import patch

import pytest

from memos.configs.mem_os import MOSConfig
from memos.mem_user.mysql_persistent_user_manager import MySQLPersistentUserManager
from memos.mem_user.mysql_user_manager import MySQLUserManager
from memos.mem_user.persistent_user_manager import PersistentUserManager
from memos.mem_user.user_manager import UserRole


def _build_config(user_id: str) -> MOSConfig:
    """Build a minimal valid MOSConfig for the given user.

    ``chat_chunker`` is set explicitly so that ``get_user_config`` round-trips:
    its declared default is ``None`` although it is typed as a non-optional
    ``dict``, which is a pre-existing serialization quirk unrelated to this bug.
    """
    return MOSConfig(
        user_id=user_id,
        chat_model={"backend": "ollama", "config": {"model_name_or_path": "qwen3:0.6b"}},
        mem_reader={
            "backend": "simple_struct",
            "config": {
                "llm": {
                    "backend": "ollama",
                    "config": {"model_name_or_path": "qwen3:0.6b"},
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {"model_name_or_path": "nomic-embed-text"},
                },
                "chunker": {
                    "backend": "sentence",
                    "config": {"tokenizer_or_token_counter": "gpt2"},
                },
                "chat_chunker": {
                    "chunk_type": "content_length",
                    "chunk_length": 200,
                    "chunk_session": True,
                    "chunk_overlap": 0,
                },
            },
        },
    )


class TestPersistentDeleteProtectedUser:
    """A refused ROOT deletion must preserve both user and configuration."""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary SQLite database for testing."""
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_memos.db")
        yield db_path
        try:
            if os.path.exists(db_path):
                os.remove(db_path)
            os.rmdir(temp_dir)
        except (OSError, PermissionError):
            pass

    @pytest.fixture
    def manager(self, temp_db):
        """Create a PersistentUserManager with a temporary database."""
        mgr = PersistentUserManager(db_path=temp_db)
        yield mgr
        mgr.close()

    def test_delete_root_preserves_configuration(self, manager):
        """Refused ROOT deletion keeps the user active and its config intact."""
        manager.save_user_config("root", _build_config("root"))
        assert manager.get_user_config("root") is not None

        result = manager.delete_user("root")

        # Parent refuses the protected deletion.
        assert result is False
        assert manager.validate_user("root") is True
        # Configuration must NOT have been removed.
        assert manager.get_user_config("root") is not None

    def test_delete_custom_id_root_preserves_configuration(self, temp_db):
        """A ROOT user with a custom ID is guarded the same way."""
        manager = PersistentUserManager(db_path=temp_db, user_id="admin")
        try:
            manager.save_user_config("admin", _build_config("admin"))

            result = manager.delete_user("admin")

            assert result is False
            assert manager.validate_user("admin") is True
            assert manager.get_user_config("admin") is not None
        finally:
            manager.close()

    def test_delete_root_config_survives_separate_connection(self, temp_db):
        """The configuration row is still committed-present on a fresh connection."""
        manager = PersistentUserManager(db_path=temp_db)
        try:
            manager.save_user_config("root", _build_config("root"))
            manager.delete_user("root")
        finally:
            manager.close()

        conn = sqlite3.connect(temp_db)
        try:
            rows = conn.execute(
                "SELECT COUNT(*) FROM user_configs WHERE user_id = ?", ("root",)
            ).fetchone()
        finally:
            conn.close()

        assert rows[0] == 1

    def test_delete_missing_user_keeps_configuration(self, manager):
        """A nonexistent user deletion fails and does not touch any config row."""
        manager.save_user_config("root", _build_config("root"))

        result = manager.delete_user("non_existent")

        assert result is False
        assert manager.get_user_config("root") is not None

    def test_delete_ordinary_user_removes_user_and_config(self, manager):
        """Ordinary users are still deactivated AND their config removed."""
        user_id = manager.create_user_with_config("alice", _build_config("alice"))
        # Sanity: config stored and user active.
        assert manager.get_user_config(user_id) is not None
        assert manager.validate_user(user_id) is True

        result = manager.delete_user(user_id)

        assert result is True
        assert manager.validate_user(user_id) is False
        assert manager.get_user_config(user_id) is None

    def test_delete_ordinary_user_without_config(self, manager):
        """Deleting an ordinary user with no config still succeeds."""
        user_id = manager.create_user("bob", UserRole.USER)

        result = manager.delete_user(user_id)

        assert result is True
        assert manager.validate_user(user_id) is False


class TestPersistentDeleteReturnSemantics:
    """Return-behavior parity with the parent UserManager."""

    def test_matches_parent_refusal_for_root(self, tmp_path):
        """The persistent manager keeps the parent's refusal contract for ROOT."""
        db_path = str(tmp_path / "memos.db")
        manager = PersistentUserManager(db_path=db_path)
        try:
            assert manager.delete_user("root") is False
            assert manager.validate_user("root") is True
        finally:
            manager.close()


class TestMySQLPersistentDeleteOrdering:
    """Ordering contract of MySQLPersistentUserManager.delete_user.

    Instantiation requires a live MySQL server, so the ordering is verified by
    binding the parent and configuration-cleanup calls to fakes via ``patch.object``.
    """

    def _make_manager(self, parent_result, calls):
        """Build a MySQLPersistentUserManager with faked parent/config calls."""
        manager = object.__new__(MySQLPersistentUserManager)

        def fake_parent_delete(self, user_id):
            # Bound method: receives the instance as first argument.
            calls.append(("delete_user", user_id))
            return parent_result

        def fake_delete_config(user_id):
            calls.append(("delete_user_config", user_id))
            return True

        manager.delete_user_config = fake_delete_config
        return manager, fake_parent_delete

    def test_refused_deletion_skips_config_cleanup(self):
        calls = []
        manager, fake_parent = self._make_manager(parent_result=False, calls=calls)

        with patch.object(MySQLUserManager, "delete_user", fake_parent):
            result = manager.delete_user("root")

        assert result is False
        assert calls == [("delete_user", "root")]

    def test_successful_deletion_cleans_config_last(self):
        calls = []
        manager, fake_parent = self._make_manager(parent_result=True, calls=calls)

        with patch.object(MySQLUserManager, "delete_user", fake_parent):
            result = manager.delete_user("alice")

        assert result is True
        assert calls == [("delete_user", "alice"), ("delete_user_config", "alice")]
