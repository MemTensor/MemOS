import uuid

from unittest.mock import MagicMock

import pytest

from memos.extras.nli_model.client import NLIClient
from memos.extras.nli_model.types import NLIResult
from memos.graph_dbs.base import BaseGraphDB
from memos.memories.textual.item import (
    TextualMemoryItem,
    TextualMemoryMetadata,
)
from memos.memories.textual.tree_text_memory.organize.history_manager import (
    MemoryHistoryManager,
    _append_related_content,
    _detach_related_content,
)


@pytest.fixture
def mock_nli_client():
    client = MagicMock(spec=NLIClient)
    return client


@pytest.fixture
def mock_graph_db():
    return MagicMock(spec=BaseGraphDB)


@pytest.fixture
def history_manager(mock_nli_client, mock_graph_db):
    return MemoryHistoryManager(nli_client=mock_nli_client, graph_db=mock_graph_db)


def test_detach_related_content():
    original_memory = "This is the original memory content."
    item = TextualMemoryItem(memory=original_memory, metadata=TextualMemoryMetadata())

    duplicates = ["Duplicate 1", "Duplicate 2"]
    conflicts = ["Conflict 1", "Conflict 2"]

    # 1. Append content
    _append_related_content(item, duplicates, conflicts)

    # Verify content was appended
    assert item.memory != original_memory
    assert "[possibly conflicting memories]" in item.memory
    assert "[possibly duplicate memories]" in item.memory
    assert "Duplicate 1" in item.memory
    assert "Conflict 1" in item.memory

    # 2. Detach content
    _detach_related_content(item)

    # 3. Verify content is restored
    assert item.memory == original_memory


def test_detach_only_conflicts():
    original_memory = "Original memory."
    item = TextualMemoryItem(memory=original_memory, metadata=TextualMemoryMetadata())

    duplicates = []
    conflicts = ["Conflict A"]

    _append_related_content(item, duplicates, conflicts)
    assert "Conflict A" in item.memory
    assert "Duplicate" not in item.memory

    _detach_related_content(item)
    assert item.memory == original_memory


def test_detach_only_duplicates():
    original_memory = "Original memory."
    item = TextualMemoryItem(memory=original_memory, metadata=TextualMemoryMetadata())

    duplicates = ["Duplicate A"]
    conflicts = []

    _append_related_content(item, duplicates, conflicts)
    assert "Duplicate A" in item.memory
    assert "Conflict" not in item.memory

    _detach_related_content(item)
    assert item.memory == original_memory


def test_truncation(history_manager, mock_nli_client):
    # Setup
    new_item = TextualMemoryItem(memory="Test")
    long_memory = "A" * 300
    related_item = TextualMemoryItem(memory=long_memory)

    mock_nli_client.compare_one_to_many.return_value = [NLIResult.DUPLICATE]

    # Action
    history_manager.resolve_history_via_nli(new_item, [related_item])

    # Assert
    assert "possibly duplicate memories" in new_item.memory
    assert "..." in new_item.memory  # Should be truncated
    assert len(new_item.memory) < 1000  # Ensure reasonable length


def test_empty_related_items(history_manager, mock_nli_client):
    new_item = TextualMemoryItem(memory="Test")
    history_manager.resolve_history_via_nli(new_item, [])

    mock_nli_client.compare_one_to_many.assert_not_called()
    assert new_item.metadata.history is None or len(new_item.metadata.history) == 0


def test_mark_memory_status(history_manager, mock_graph_db):
    # Setup
    id1 = uuid.uuid4().hex
    id2 = uuid.uuid4().hex
    id3 = uuid.uuid4().hex
    items = [
        TextualMemoryItem(memory="M1", id=id1),
        TextualMemoryItem(memory="M2", id=id2),
        TextualMemoryItem(memory="M3", id=id3),
    ]
    status = "resolving"

    # Action
    history_manager.mark_memory_status(items, status)

    # Assert
    assert mock_graph_db.update_node.call_count == 3

    # Verify we called it correctly
    mock_graph_db.update_node.assert_any_call(id=id1, fields={"status": status})
    mock_graph_db.update_node.assert_any_call(id=id2, fields={"status": status})
    mock_graph_db.update_node.assert_any_call(id=id3, fields={"status": status})
