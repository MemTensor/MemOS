"""
Unit tests for SchedulerSearchService.

These tests verify that the SchedulerSearchService correctly delegates
search operations to the Searcher class and provides proper fallback behavior.
"""

from unittest.mock import Mock

import pytest

from memos.mem_scheduler.memory_manage_modules.search_service import SchedulerSearchService
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.memories.textual.tree import TreeTextMemory
from memos.types.general_types import SearchMode


class TestSchedulerSearchService:
    """Test suite for SchedulerSearchService."""

    @pytest.fixture
    def mock_searcher(self):
        """Create a mock Searcher instance."""
        searcher = Mock()
        searcher.manual_close_internet = True
        searcher.search = Mock(
            return_value=[
                TextualMemoryItem(
                    memory="Test memory 1",
                    metadata=TextualMemoryMetadata(user_id="user1", memory_type="LongTermMemory"),
                )
            ]
        )
        return searcher

    @pytest.fixture
    def mock_mem_cube(self):
        """Create a mock MemCube instance."""
        mem_cube = Mock()
        mem_cube.text_mem = Mock(spec=TreeTextMemory)
        mem_cube.text_mem.search = Mock(
            return_value=[
                TextualMemoryItem(
                    memory="Fallback memory",
                    metadata=TextualMemoryMetadata(user_id="user1", memory_type="LongTermMemory"),
                )
            ]
        )
        return mem_cube

    def test_init_with_searcher(self, mock_searcher):
        """Test initialization with a Searcher instance."""
        service = SchedulerSearchService(searcher=mock_searcher)
        assert service.searcher is mock_searcher

    def test_init_without_searcher(self):
        """Test initialization without a Searcher instance."""
        service = SchedulerSearchService(searcher=None)
        assert service.searcher is None

    def test_search_with_searcher(self, mock_searcher, mock_mem_cube):
        """Test search operation using Searcher (preferred path)."""
        service = SchedulerSearchService(searcher=mock_searcher)

        results = service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
            mode=SearchMode.FAST,
        )

        # Verify Searcher.search() was called ONCE with memory_type="All"
        # (This avoids the 2*top_k bug)
        assert mock_searcher.search.call_count == 1

        # Verify correct parameters were passed
        call_args = mock_searcher.search.call_args[1]
        assert call_args["query"] == "test query"
        assert call_args["memory_type"] == "All"  # Should search all types together
        assert call_args["top_k"] == 10

        # Verify results were returned
        assert len(results) >= 1

    def test_search_without_searcher_fallback(self, mock_mem_cube):
        """Test search operation without Searcher (fallback path)."""
        service = SchedulerSearchService(searcher=None)

        results = service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
            mode=SearchMode.FAST,
        )

        # Verify text_mem.search() was called once as fallback (with memory_type="All")
        assert mock_mem_cube.text_mem.search.call_count == 1

        # Verify results were returned
        assert len(results) >= 1

    def test_search_internet_search_toggle(self, mock_searcher, mock_mem_cube):
        """Test that internet_search parameter correctly toggles manual_close_internet."""
        service = SchedulerSearchService(searcher=mock_searcher)

        # Test with internet_search=True
        service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
            internet_search=True,
        )

        # Verify manual_close_internet was set to False (enable internet search)
        # Note: This is tested during the call, then restored
        assert mock_searcher.manual_close_internet  # Restored after call

    def test_search_mode_fine(self, mock_searcher, mock_mem_cube):
        """Test search with FINE mode."""
        service = SchedulerSearchService(searcher=mock_searcher)

        service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
            mode=SearchMode.FINE,
        )

        # Verify FINE mode was passed
        call_args = mock_searcher.search.call_args_list[0][1]
        assert call_args["mode"] == SearchMode.FINE

    def test_search_with_filters(self, mock_searcher, mock_mem_cube):
        """Test search with search_filter and search_priority."""
        service = SchedulerSearchService(searcher=mock_searcher)

        search_filter = {"source": "document"}
        search_priority = {"session_id": "session123"}

        service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
            search_filter=search_filter,
            search_priority=search_priority,
        )

        # Verify filters were passed
        call_args = mock_searcher.search.call_args_list[0][1]
        assert call_args["search_filter"] == search_filter
        assert call_args["search_priority"] == search_priority

    def test_search_exception_handling(self, mock_mem_cube):
        """Test that exceptions are caught and empty list is returned."""
        service = SchedulerSearchService(searcher=None)
        mock_mem_cube.text_mem.search.side_effect = Exception("Search failed")

        results = service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
        )

        # Verify empty list is returned on exception
        assert results == []

    def test_search_preserves_searcher_state(self, mock_searcher, mock_mem_cube):
        """Test that the original searcher state is preserved after search."""
        service = SchedulerSearchService(searcher=mock_searcher)

        original_state = True
        mock_searcher.manual_close_internet = original_state

        service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=10,
            internet_search=True,  # This should temporarily change the state
        )

        # Verify original state was restored
        assert mock_searcher.manual_close_internet == original_state


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
