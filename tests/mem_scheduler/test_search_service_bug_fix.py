"""
Critical bug fix test: Verify that search returns correct number of results.

This test verifies the fix for the bug where calling Searcher.search() twice
(once for LongTermMemory, once for UserMemory) would return 2*top_k results
because each call applies deduplication and top_k limiting independently.
"""

from unittest.mock import Mock

import pytest

from memos.mem_scheduler.memory_manage_modules.search_service import SchedulerSearchService
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.types.general_types import SearchMode


class TestSearchServiceBugFix:
    """Test suite for the critical 2*top_k bug fix."""

    @pytest.fixture
    def mock_searcher(self):
        """Create a mock Searcher that simulates real behavior."""
        searcher = Mock()
        searcher.manual_close_internet = True

        # Simulate Searcher.search() behavior:
        # Returns exactly top_k results after deduplication
        def search_side_effect(*args, **kwargs):
            top_k = kwargs.get("top_k", 10)
            memory_type = kwargs.get("memory_type", "All")

            # Simulate returning top_k results
            results = [
                TextualMemoryItem(
                    memory=f"Memory {i} ({memory_type})",
                    metadata=TextualMemoryMetadata(user_id="user1", memory_type=memory_type),
                )
                for i in range(top_k)
            ]
            return results

        searcher.search = Mock(side_effect=search_side_effect)
        return searcher

    @pytest.fixture
    def mock_mem_cube(self):
        """Create a mock MemCube."""
        mem_cube = Mock()
        mem_cube.text_mem = Mock()
        return mem_cube

    def test_search_returns_correct_count_not_double(self, mock_searcher, mock_mem_cube):
        """
        CRITICAL TEST: Verify search returns top_k results, not 2*top_k.

        This test verifies the fix for the bug where:
        - OLD (buggy): Called search() twice → returned 2*top_k results
        - NEW (fixed): Calls search() once with memory_type="All" → returns top_k results
        """
        service = SchedulerSearchService(searcher=mock_searcher)

        top_k = 10
        results = service.search(
            query="test query",
            user_id="user1",
            mem_cube=mock_mem_cube,
            top_k=top_k,
            mode=SearchMode.FAST,
        )

        # CRITICAL ASSERTION: Should return exactly top_k results, not 2*top_k
        assert len(results) == top_k, (
            f"Expected exactly {top_k} results, but got {len(results)}. "
            f"This indicates the 2*top_k bug is NOT fixed!"
        )

        # Verify search was called only ONCE with memory_type="All"
        assert mock_searcher.search.call_count == 1, (
            f"Expected search() to be called once, but was called {mock_searcher.search.call_count} times. "
            f"Multiple calls would cause the 2*top_k bug!"
        )

        # Verify the call used memory_type="All"
        call_kwargs = mock_searcher.search.call_args[1]
        assert call_kwargs["memory_type"] == "All", (
            f"Expected memory_type='All', but got '{call_kwargs['memory_type']}'. "
            f"Separate calls for LongTermMemory and UserMemory would cause the 2*top_k bug!"
        )

    def test_old_buggy_behavior_would_return_double(self):
        """
        Documentation test: Show what the OLD buggy behavior would have been.

        This test documents the bug for future reference.
        """
        # Simulate the OLD buggy implementation
        mock_searcher = Mock()

        def buggy_search(*args, **kwargs):
            # Each call returns top_k results
            top_k = kwargs.get("top_k", 10)
            return [Mock() for _ in range(top_k)]

        mock_searcher.search = Mock(side_effect=buggy_search)

        # OLD buggy code would do:
        top_k = 10
        results_long_term = mock_searcher.search(memory_type="LongTermMemory", top_k=top_k)
        results_user = mock_searcher.search(memory_type="UserMemory", top_k=top_k)
        buggy_results = results_long_term + results_user

        # This would return 2*top_k results!
        assert len(buggy_results) == 2 * top_k, (
            f"OLD buggy behavior: Expected {2 * top_k} results (2*top_k), "
            f"but got {len(buggy_results)}"
        )

        # This is the BUG we fixed!
        print(
            f"✅ Confirmed: OLD buggy behavior would return {len(buggy_results)} results (2*top_k)"
        )

    def test_search_with_different_top_k_values(self, mock_searcher, mock_mem_cube):
        """Test that the fix works correctly with different top_k values."""
        service = SchedulerSearchService(searcher=mock_searcher)

        for top_k in [1, 5, 10, 20, 50]:
            results = service.search(
                query="test query",
                user_id="user1",
                mem_cube=mock_mem_cube,
                top_k=top_k,
                mode=SearchMode.FAST,
            )

            # Should always return exactly top_k, never 2*top_k
            assert len(results) == top_k, (
                f"For top_k={top_k}, expected {top_k} results, but got {len(results)}"
            )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
