"""Tests for write-path content-hash dedup in MemoryManager.

Covers the ``_dedup_by_content_hash`` method introduced to address #2141.
All graph-store calls are mocked so no external services are required.
"""

import hashlib
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata


@pytest.fixture
def _manager():
    """Build a MemoryManager with mocked dependencies."""
    from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager

    mgr = MemoryManager(
        graph_store=MagicMock(),
        embedder=MagicMock(),
        llm=MagicMock(),
        is_reorganize=False,
    )
    return mgr


def _make_item(text: str) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=text,
        metadata=TextualMemoryMetadata(memory_type="LongTermMemory"),
    )


class TestDedupByContentHash:
    """Tests for ``MemoryManager._dedup_by_content_hash``."""

    def test_batch_level_dedup(self, _manager):
        """Duplicate items within the same batch are collapsed."""
        items = [_make_item("I like strawberry"), _make_item("I like strawberry")]
        result = _manager._dedup_by_content_hash(items, user_name="alice")
        assert len(result) == 1
        assert result[0].memory == "I like strawberry"

    def test_no_dedup_when_disabled(self, _manager):
        """When ``MOS_DEDUP_ENABLED=0``, all items pass through."""
        items = [_make_item("A"), _make_item("A")]
        with patch(
            "memos.memories.textual.tree_text_memory.organize.manager._DEDUP_ENABLED",
            False,
        ):
            result = _manager._dedup_by_content_hash(items, user_name="alice")
        assert len(result) == 2

    def test_graph_store_existing_within_window(self, _manager):
        """Items already in the graph store within the time window are skipped."""
        item = _make_item("I like strawberry")

        _manager.graph_store.get_by_metadata.return_value = ["existing-id"]
        _manager.graph_store.get_node.return_value = {
            "metadata": {"updated_at": datetime.now().isoformat()}
        }

        result = _manager._dedup_by_content_hash([item], user_name="alice")
        assert len(result) == 0

    def test_graph_store_existing_outside_window(self, _manager):
        """Items in the graph store but outside the time window are kept."""
        item = _make_item("I like strawberry")

        _manager.graph_store.get_by_metadata.return_value = ["old-id"]
        _manager.graph_store.get_node.return_value = {
            "metadata": {
                "updated_at": (datetime.now() - timedelta(days=30)).isoformat()
            }
        }

        result = _manager._dedup_by_content_hash([item], user_name="alice")
        assert len(result) == 1

    def test_fail_open_on_query_error(self, _manager):
        """If the graph store query raises, the write proceeds."""
        item = _make_item("I like strawberry")
        _manager.graph_store.get_by_metadata.side_effect = RuntimeError("DB down")

        result = _manager._dedup_by_content_hash([item], user_name="alice")
        assert len(result) == 1

    def test_content_hash_attached_to_metadata(self, _manager):
        """The ``content_hash`` field is set on metadata for kept items."""
        item = _make_item("hello world")
        _manager.graph_store.get_by_metadata.return_value = []

        result = _manager._dedup_by_content_hash([item], user_name="alice")
        assert len(result) == 1
        assert result[0].metadata.content_hash == hashlib.sha1(b"hello world").hexdigest()

    def test_empty_input(self, _manager):
        """Empty input returns empty output."""
        result = _manager._dedup_by_content_hash([], user_name="alice")
        assert result == []

    def test_mixed_duplicates_and_unique(self, _manager):
        """A mix of duplicate and unique items is handled correctly."""
        items = [
            _make_item("A"),
            _make_item("A"),  # batch dup
            _make_item("B"),  # unique
        ]
        _manager.graph_store.get_by_metadata.return_value = []

        result = _manager._dedup_by_content_hash(items, user_name="alice")
        assert len(result) == 2
        memories = [r.memory for r in result]
        assert "A" in memories
        assert "B" in memories
