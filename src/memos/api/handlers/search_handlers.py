"""
Search handler for memory search functionality.

This module handles all memory search operations including fast, fine-grained,
and mixture-based search modes.
"""

import os
import traceback

from typing import Any

from memos.api.handlers.formatters_handlers import (
    format_memory_item,
    post_process_pref_mem,
)
from memos.api.product_models import APISearchRequest, SearchResponse
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.schemas.general_schemas import SearchMode
from memos.types import MOSSearchResult, UserContext


logger = get_logger(__name__)


def fast_search_memories(
    search_req: APISearchRequest,
    user_context: UserContext,
    naive_mem_cube: Any,
) -> list[dict[str, Any]]:
    """
    Fast search memories using vector database.

    Performs a quick vector-based search for memories.

    Args:
        search_req: Search request containing query and parameters
        user_context: User context with IDs
        naive_mem_cube: Memory cube instance

    Returns:
        List of formatted search results
    """
    target_session_id = search_req.session_id or "default_session"
    search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

    # Create MemCube and perform search
    search_results = naive_mem_cube.text_mem.search(
        query=search_req.query,
        user_name=user_context.mem_cube_id,
        top_k=search_req.top_k,
        mode=SearchMode.FAST,
        manual_close_internet=not search_req.internet_search,
        moscube=search_req.moscube,
        search_filter=search_filter,
        info={
            "user_id": search_req.user_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        },
    )
    formatted_memories = [format_memory_item(data) for data in search_results]

    return formatted_memories


def fine_search_memories(
    search_req: APISearchRequest,
    user_context: UserContext,
    mem_scheduler: Any,
) -> list[dict[str, Any]]:
    """
    Fine-grained search memories using scheduler and retriever.

    Performs a more comprehensive search with query enhancement.

    Args:
        search_req: Search request containing query and parameters
        user_context: User context with IDs
        mem_scheduler: Scheduler instance for advanced retrieval

    Returns:
        List of formatted search results
    """
    target_session_id = search_req.session_id or "default_session"
    search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

    searcher = mem_scheduler.searcher

    info = {
        "user_id": search_req.user_id,
        "session_id": target_session_id,
        "chat_history": search_req.chat_history,
    }

    fast_retrieved_memories = searcher.retrieve(
        query=search_req.query,
        user_name=user_context.mem_cube_id,
        top_k=search_req.top_k,
        mode=SearchMode.FAST,
        manual_close_internet=not search_req.internet_search,
        moscube=search_req.moscube,
        search_filter=search_filter,
        info=info,
    )

    fast_memories = searcher.post_retrieve(
        retrieved_results=fast_retrieved_memories,
        top_k=search_req.top_k,
        user_name=user_context.mem_cube_id,
        info=info,
    )

    enhanced_results, _ = mem_scheduler.retriever.enhance_memories_with_query(
        query_history=[search_req.query],
        memories=fast_memories,
    )

    formatted_memories = [format_memory_item(data) for data in enhanced_results]

    return formatted_memories


def mix_search_memories(
    search_req: APISearchRequest,
    user_context: UserContext,
    mem_scheduler: Any,
) -> list[dict[str, Any]]:
    """
    Mix search memories: fast search + async fine search.

    Combines fast initial search with asynchronous fine-grained search.

    Args:
        search_req: Search request containing query and parameters
        user_context: User context with IDs
        mem_scheduler: Scheduler instance

    Returns:
        List of formatted search results
    """
    formatted_memories = mem_scheduler.mix_search_memories(
        search_req=search_req,
        user_context=user_context,
    )
    return formatted_memories


def handle_search_memories(
    search_req: APISearchRequest,
    naive_mem_cube: Any,
    mem_scheduler: Any,
) -> SearchResponse:
    """
    Main handler for search memories endpoint.

    Orchestrates the search process based on the requested search mode,
    supporting both text and preference memory searches.

    Args:
        search_req: Search request
        naive_mem_cube: Memory cube instance
        mem_scheduler: Scheduler instance

    Returns:
        SearchResponse with formatted results
    """
    # Create UserContext object
    user_context = UserContext(
        user_id=search_req.user_id,
        mem_cube_id=search_req.mem_cube_id,
        session_id=search_req.session_id or "default_session",
    )
    logger.info(f"Search Req is: {search_req}")

    memories_result: MOSSearchResult = {
        "text_mem": [],
        "act_mem": [],
        "para_mem": [],
        "pref_mem": [],
        "pref_note": "",
    }

    if search_req.mode == SearchMode.NOT_INITIALIZED:
        search_mode = os.getenv("SEARCH_MODE", SearchMode.FAST)
    else:
        search_mode = search_req.mode

    def _search_text():
        try:
            if search_mode == SearchMode.FAST:
                formatted_memories = fast_search_memories(
                    search_req=search_req,
                    user_context=user_context,
                    naive_mem_cube=naive_mem_cube,
                )
            elif search_mode == SearchMode.FINE:
                formatted_memories = fine_search_memories(
                    search_req=search_req,
                    user_context=user_context,
                    mem_scheduler=mem_scheduler,
                )
            elif search_mode == SearchMode.MIXTURE:
                formatted_memories = mix_search_memories(
                    search_req=search_req,
                    user_context=user_context,
                    mem_scheduler=mem_scheduler,
                )
            else:
                logger.error(f"Unsupported search mode: {search_mode}")
                return []
            return formatted_memories
        except Exception as e:
            logger.error("Error in search_text: %s; traceback: %s", e, traceback.format_exc())
            return []

    def _search_pref():
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
            return []
        try:
            results = naive_mem_cube.pref_mem.search(
                query=search_req.query,
                top_k=search_req.pref_top_k,
                info={
                    "user_id": search_req.user_id,
                    "session_id": search_req.session_id,
                    "chat_history": search_req.chat_history,
                },
            )
            return [format_memory_item(data) for data in results]
        except Exception as e:
            logger.error("Error in _search_pref: %s; traceback: %s", e, traceback.format_exc())
            return []

    with ContextThreadPoolExecutor(max_workers=2) as executor:
        text_future = executor.submit(_search_text)
        pref_future = executor.submit(_search_pref)
        text_formatted_memories = text_future.result()
        pref_formatted_memories = pref_future.result()

    memories_result["text_mem"].append(
        {
            "cube_id": search_req.mem_cube_id,
            "memories": text_formatted_memories,
        }
    )

    memories_result = post_process_pref_mem(
        memories_result,
        pref_formatted_memories,
        search_req.mem_cube_id,
        search_req.include_preference,
    )

    logger.info(f"Search memories result: {memories_result}")

    return SearchResponse(
        message="Search completed successfully",
        data=memories_result,
    )
