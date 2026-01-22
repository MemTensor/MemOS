"""
Scheduler Search Service - Unified search interface for the scheduler.

This module provides a clean abstraction over the Searcher class,
adapting it for scheduler-specific use cases while maintaining compatibility.
"""

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree import TreeTextMemory
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.types.general_types import SearchMode


logger = get_logger(__name__)


class SchedulerSearchService:
    """
    Unified search service for the scheduler.
    
    This service provides a clean interface for memory search operations,
    delegating to the Searcher class while handling scheduler-specific
    parameter adaptations.
    
    Design principles:
    - Single Responsibility: Only handles search coordination
    - Dependency Injection: Searcher is injected, not created
    - Fail-safe: Falls back to direct text_mem.search() if Searcher unavailable
    
    Usage:
        service = SchedulerSearchService(searcher=searcher)
        results = service.search(
            query="user query",
            user_id="user_123",
            mem_cube=mem_cube,
            top_k=10
        )
    """

    def __init__(self, searcher: Searcher | None = None):
        """
        Initialize the search service.
        
        Args:
            searcher: Optional Searcher instance. If None, will fall back to
                     direct mem_cube.text_mem.search() calls.
        """
        self.searcher = searcher

    def search(
        self,
        query: str,
        user_id: str,
        mem_cube: GeneralMemCube,
        top_k: int,
        mode: SearchMode = SearchMode.FAST,
        search_filter: dict | None = None,
        search_priority: dict | None = None,
        session_id: str = "default_session",
        internet_search: bool = False,
        chat_history: list | None = None,
        plugin: bool = False,
        search_tool_memory: bool = False,
        tool_mem_top_k: int = 6,
        playground_search_goal_parser: bool = False,
        mem_cube_id: str | None = None,
    ) -> list[TextualMemoryItem]:
        """
        Search for memories across both LongTermMemory and UserMemory.
        
        This method provides a unified interface for memory search, automatically
        handling the search across different memory types and merging results.
        
        Args:
            query: The search query string
            user_id: User identifier
            mem_cube: Memory cube instance containing text memory
            top_k: Number of top results to return per memory type
            mode: Search mode (FAST or FINE)
            search_filter: Optional metadata filters for search results
            search_priority: Optional metadata priority for search results
            session_id: Session identifier for session-scoped search
            internet_search: Whether to enable internet search
            chat_history: Chat history for context
            plugin: Whether this is a plugin-initiated search
            search_tool_memory: Whether to search tool memory
            tool_mem_top_k: Top-k for tool memory search
            playground_search_goal_parser: Whether to use playground goal parser
            mem_cube_id: Memory cube identifier (defaults to user_id if not provided)
            
        Returns:
            List of TextualMemoryItem objects sorted by relevance
            
        Raises:
            Exception: Propagates exceptions from underlying search implementations
        """
        mem_cube_id = mem_cube_id or user_id
        user_name = mem_cube_id
        text_mem_base = mem_cube.text_mem

        # Build info dict for tracking
        info = {
            "user_id": user_id,
            "session_id": session_id,
            "chat_history": chat_history,
        }

        try:
            if self.searcher:
                # Use injected Searcher (preferred path)
                results = self._search_with_searcher(
                    query=query,
                    user_name=user_name,
                    top_k=top_k,
                    mode=mode,
                    search_filter=search_filter,
                    search_priority=search_priority,
                    info=info,
                    internet_search=internet_search,
                    plugin=plugin,
                    search_tool_memory=search_tool_memory,
                    tool_mem_top_k=tool_mem_top_k,
                    playground_search_goal_parser=playground_search_goal_parser,
                )
                logger.info(
                    f"[SchedulerSearchService] Searched via Searcher: "
                    f"query='{query}' results={len(results)}"
                )
            else:
                # Fallback: Direct text_mem.search() call
                results = self._search_with_text_mem(
                    text_mem_base=text_mem_base,
                    query=query,
                    user_name=user_name,
                    top_k=top_k,
                    mode=mode,
                    search_filter=search_filter,
                    search_priority=search_priority,
                    info=info,
                    internet_search=internet_search,
                    plugin=plugin,
                    search_tool_memory=search_tool_memory,
                    tool_mem_top_k=tool_mem_top_k,
                    playground_search_goal_parser=playground_search_goal_parser,
                )
                logger.info(
                    f"[SchedulerSearchService] Searched via text_mem (fallback): "
                    f"query='{query}' results={len(results)}"
                )

            return results

        except Exception as e:
            logger.error(
                f"[SchedulerSearchService] Search failed for query='{query}': {e}",
                exc_info=True,
            )
            return []

    def _search_with_searcher(
        self,
        query: str,
        user_name: str,
        top_k: int,
        mode: SearchMode,
        search_filter: dict | None,
        search_priority: dict | None,
        info: dict,
        internet_search: bool,
        plugin: bool,
        search_tool_memory: bool,
        tool_mem_top_k: int,
        playground_search_goal_parser: bool,
    ) -> list[TextualMemoryItem]:
        """
        Search using the injected Searcher instance.
        
        IMPORTANT: This method searches "All" memory types in a single call to avoid
        the bug where calling search() twice (for LongTermMemory and UserMemory separately)
        would return 2*top_k results due to Searcher.search() applying deduplication and
        top_k limiting on each call.
        
        This ensures the final result is properly deduplicated and limited to top_k items.
        """
        # Preserve original internet search setting
        original_manual_close = getattr(self.searcher, "manual_close_internet", None)
        
        try:
            # Configure internet search
            if original_manual_close is not None:
                self.searcher.manual_close_internet = not internet_search

            # Search all memory types in a single call
            # This ensures proper deduplication and top_k limiting
            results = self.searcher.search(
                query=query,
                user_name=user_name,
                top_k=top_k,
                mode=mode,
                memory_type="All",  # Search all types together to avoid 2*top_k bug
                search_filter=search_filter,
                search_priority=search_priority,
                info=info,
                plugin=plugin,
                search_tool_memory=search_tool_memory,
                tool_mem_top_k=tool_mem_top_k,
                playground_search_goal_parser=playground_search_goal_parser,
            )

            return results

        finally:
            # Restore original setting
            if original_manual_close is not None:
                self.searcher.manual_close_internet = original_manual_close

    def _search_with_text_mem(
        self,
        text_mem_base: TreeTextMemory,
        query: str,
        user_name: str,
        top_k: int,
        mode: SearchMode,
        search_filter: dict | None,
        search_priority: dict | None,
        info: dict,
        internet_search: bool,
        plugin: bool,
        search_tool_memory: bool,
        tool_mem_top_k: int,
        playground_search_goal_parser: bool,
    ) -> list[TextualMemoryItem]:
        """
        Fallback: Search using direct text_mem.search() calls.
        
        This is used when no Searcher instance is available, providing
        backward compatibility with the original implementation.
        
        NOTE: TreeTextMemory.search() with memory_type="All" will internally
        search both LongTermMemory and UserMemory and properly merge results.
        """
        assert isinstance(text_mem_base, TreeTextMemory), (
            f"Fallback search requires TreeTextMemory, got {type(text_mem_base)}"
        )

        # Search all memory types together (same as Searcher behavior)
        results = text_mem_base.search(
            query=query,
            user_name=user_name,
            top_k=top_k,
            mode=mode,
            manual_close_internet=not internet_search,
            memory_type="All",  # Search all types to match Searcher behavior
            search_filter=search_filter,
            search_priority=search_priority,
            info=info,
            plugin=plugin,
            search_tool_memory=search_tool_memory,
            tool_mem_top_k=tool_mem_top_k,
            playground_search_goal_parser=playground_search_goal_parser,
        )

        return results
