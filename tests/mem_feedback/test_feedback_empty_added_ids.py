"""
Regression tests for issue #1122 (Part 2):
feedback.py _single_add_operation must handle empty added_ids gracefully
instead of raising IndexError.
"""

from unittest.mock import MagicMock


class TestFeedbackEmptyAddedIds:
    """Regression: _single_add_operation should not crash when added_ids is empty."""

    def test_single_add_returns_none_id_when_added_ids_empty(self):
        """
        When memory_manager.add() returns an empty list (e.g. due to a
        silent graph DB failure), _single_add_operation should return
        {"id": None, ...} instead of raising IndexError.
        """
        from memos.mem_feedback.feedback import MemFeedback

        core = object.__new__(MemFeedback)
        core.memory_manager = MagicMock()
        core.memory_manager.add.return_value = []  # simulate silent failure

        # Build a minimal mock memory item
        mock_memory = MagicMock()
        mock_memory.memory = "test memory"
        mock_memory.metadata.key = "test_key"
        mock_memory.metadata.tags = []
        mock_memory.metadata.embedding = [0.1, 0.2]
        mock_memory.metadata.user_id = "user1"
        mock_memory.metadata.background = ""
        mock_memory.metadata.sources = []
        mock_memory.metadata.created_at = "2025-01-01T00:00:00"
        mock_memory.metadata.updated_at = "2025-01-01T00:00:00"
        mock_memory.metadata.file_ids = None
        mock_memory.model_copy.return_value = mock_memory

        result = core._single_add_operation(
            old_memory_item=None,
            new_memory_item=mock_memory,
            user_id="user1",
            user_name="test-user",
        )

        assert result["id"] is None
        assert result["text"] == "test memory"

    def test_single_add_returns_id_when_added_ids_present(self):
        """Normal case: added_ids has one element, should return it."""
        from memos.mem_feedback.feedback import MemFeedback

        core = object.__new__(MemFeedback)
        core.memory_manager = MagicMock()
        core.memory_manager.add.return_value = ["mem-id-123"]

        mock_memory = MagicMock()
        mock_memory.memory = "test memory"
        mock_memory.metadata.key = "test_key"
        mock_memory.metadata.tags = []
        mock_memory.metadata.embedding = [0.1, 0.2]
        mock_memory.metadata.user_id = "user1"
        mock_memory.metadata.background = ""
        mock_memory.metadata.sources = []
        mock_memory.metadata.created_at = "2025-01-01T00:00:00"
        mock_memory.metadata.updated_at = "2025-01-01T00:00:00"
        mock_memory.metadata.file_ids = ["doc-1"]
        mock_memory.model_copy.return_value = mock_memory

        result = core._single_add_operation(
            old_memory_item=None,
            new_memory_item=mock_memory,
            user_id="user1",
            user_name="test-user",
        )

        assert result["id"] == "mem-id-123"
        assert result["text"] == "test memory"
        assert result["source_doc_id"] == "doc-1"
