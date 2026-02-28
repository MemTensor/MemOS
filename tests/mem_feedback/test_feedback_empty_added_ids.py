"""
Regression tests for issue #1122 (Bug #2):
MemFeedback._single_add_operation() must handle empty added_ids
without raising IndexError.
"""

import uuid
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from memos.mem_feedback.feedback import MemFeedback
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


def _make_memory_item(memory_text="I prefer Python for AI development"):
    """Create a minimal TextualMemoryItem for testing."""
    return TextualMemoryItem(
        id=str(uuid.uuid4()),
        memory=memory_text,
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="user1",
            memory_type="WorkingMemory",
            sources=[],
            embedding=[0.1, 0.2, 0.3],
            created_at=datetime.now().isoformat(),
            background="",
            key="test-key",
            tags=[],
        ),
    )


@pytest.fixture
def feedback_instance():
    """Create a MemFeedback instance bypassing __init__."""
    fb = object.__new__(MemFeedback)
    fb.memory_manager = MagicMock()
    fb.embedder = MagicMock()
    return fb


class TestSingleAddOperationEmptyIds:
    """Test _single_add_operation when memory_manager.add() returns empty list."""

    def test_empty_added_ids_returns_none_id(self, feedback_instance):
        """When added_ids is empty, should return {"id": None} instead of IndexError."""
        feedback_instance.memory_manager.add.return_value = []

        new_item = _make_memory_item()
        result = feedback_instance._single_add_operation(
            old_memory_item=None,
            new_memory_item=new_item,
            user_id="user1",
            user_name="test-user",
        )

        assert result["id"] is None
        assert result["text"] == new_item.memory
        assert result["source_doc_id"] is None

    def test_normal_added_ids_returns_first_id(self, feedback_instance):
        """When added_ids has values, should return the first id normally."""
        expected_id = str(uuid.uuid4())
        feedback_instance.memory_manager.add.return_value = [expected_id]

        new_item = _make_memory_item()
        result = feedback_instance._single_add_operation(
            old_memory_item=None,
            new_memory_item=new_item,
            user_id="user1",
            user_name="test-user",
        )

        assert result["id"] == expected_id
        assert result["text"] == new_item.memory
