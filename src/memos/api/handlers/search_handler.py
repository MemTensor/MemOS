"""
Search handler for memory search functionality (Class-based version).

This module provides a class-based implementation of search handlers,
using dependency injection for better modularity and testability.
"""

import os
import traceback

from typing import Any

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.handlers.formatters_handler import (
    format_memory_item,
    post_process_pref_mem,
)
from memos.api.product_models import APISearchRequest, SearchResponse
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.schemas.general_schemas import FINE_STRATEGY, FineStrategy, SearchMode
from memos.types import MOSSearchResult, UserContext


logger = get_logger(__name__)


class SearchHandler(BaseHandler):
    """
    Handler for memory search operations.

    Provides fast, fine-grained, and mixture-based search modes.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize search handler.

        Args:
            dependencies: HandlerDependencies instance
        """
        super().__init__(dependencies)
        self._validate_dependencies("naive_mem_cube", "mem_scheduler", "searcher")

    def handle_search_memories(self, search_req: APISearchRequest) -> SearchResponse:
        """
        Main handler for search memories endpoint.

        Orchestrates the search process based on the requested search mode,
        supporting both text and preference memory searches.

        Args:
            search_req: Search request containing query and parameters

        Returns:
            SearchResponse with formatted results
        """
        # Create UserContext object
        user_context = UserContext(
            user_id=search_req.user_id,
            mem_cube_id=search_req.mem_cube_id,
            session_id=search_req.session_id or "default_session",
        )
        self.logger.info(f"Search Req is: {search_req}")

        memories_result: MOSSearchResult = {
            "text_mem": [],
            "act_mem": [],
            "para_mem": [],
            "pref_mem": [],
            "pref_note": "",
        }

        # Determine search mode
        search_mode = self._get_search_mode(search_req.mode)

        # Execute search in parallel for text and preference memories
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            text_future = executor.submit(self._search_text, search_req, user_context, search_mode)
            pref_future = executor.submit(self._search_pref, search_req, user_context)

            text_formatted_memories = text_future.result()
            pref_formatted_memories = pref_future.result()

        # Build result
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

        self.logger.info(f"Search memories result: {memories_result}")

        return SearchResponse(
            message="Search completed successfully",
            data=memories_result,
        )

    def _get_search_mode(self, mode: str) -> str:
        return mode

    def _search_text(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
        search_mode: str,
    ) -> list[dict[str, Any]]:
        """
        Search text memories based on mode.

        Args:
            search_req: Search request
            user_context: User context
            search_mode: Search mode (FAST, FINE, or MIXTURE)

        Returns:
            List of formatted memory items
        """
        try:
            if search_mode == SearchMode.FAST:
                text_memories = self._fast_search(search_req, user_context)
            elif search_mode == SearchMode.FINE:
                text_memories = self._fine_search(search_req, user_context)
            elif search_mode == SearchMode.MIXTURE:
                text_memories = self._mix_search(search_req, user_context)
            else:
                self.logger.error(f"Unsupported search mode: {search_mode}")
                return []

            return text_memories

        except Exception as e:
            self.logger.error("Error in search_text: %s; traceback: %s", e, traceback.format_exc())
            return []

    def _search_pref(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
    ) -> list[dict[str, Any]]:
        """
        Search preference memories.

        Args:
            search_req: Search request
            user_context: User context

        Returns:
            List of formatted preference memory items
        """
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
            return []

        try:
            results = self.naive_mem_cube.pref_mem.search(
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
            self.logger.error("Error in _search_pref: %s; traceback: %s", e, traceback.format_exc())
            return []

    def _fast_search(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
    ) -> list:
        """
        Fast search using vector database.

        Args:
            search_req: Search request
            user_context: User context

        Returns:
            List of search results
        """
        target_session_id = search_req.session_id or "default_session"
        search_filter = {"session_id": search_req.session_id} if search_req.session_id else None
        plugin = bool(search_req.info is not None and search_req.info.get("origin_model"))
        search_results = self.naive_mem_cube.text_mem.search(
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
            plugin=plugin,
        )

        formatted_memories = [format_memory_item(data) for data in search_results]

        return formatted_memories

    def _deep_search(
        self, search_req: APISearchRequest, user_context: UserContext, max_thinking_depth: int
    ) -> list:
        logger.error("waiting to be implemented")
        return []

    def _fine_search(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
    ) -> list[str]:
        """
        Fine-grained search with query enhancement.

        Args:
            search_req: Search request
            user_context: User context

        Returns:
            List of enhanced search results
        """
        if FINE_STRATEGY == FineStrategy.DEEP_SEARCH:
            return self._deep_search(
                search_req=search_req, user_context=user_context, max_thinking_depth=3
            )

        target_session_id = search_req.session_id or "default_session"
        search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

        info = {
            "user_id": search_req.user_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        }

        # Fine retrieve
        raw_retrieved_memories = self.searcher.retrieve(
            query=search_req.query,
            user_name=user_context.mem_cube_id,
            top_k=search_req.top_k,
            mode=SearchMode.FINE,
            manual_close_internet=not search_req.internet_search,
            moscube=search_req.moscube,
            search_filter=search_filter,
            info=info,
        )

        # Post retrieve
        raw_memories = self.searcher.post_retrieve(
            retrieved_results=raw_retrieved_memories,
            top_k=search_req.top_k,
            user_name=user_context.mem_cube_id,
            info=info,
        )

        # Enhance with query
        enhanced_memories, _ = self.mem_scheduler.retriever.enhance_memories_with_query(
            query_history=[search_req.query],
            memories=raw_memories,
        )

        if len(enhanced_memories) < len(raw_memories):
            logger.info(
                f"Enhanced memories ({len(enhanced_memories)}) are less than raw memories ({len(raw_memories)}). Recalling for more."
            )
            missing_info_hint, trigger = self.mem_scheduler.retriever.recall_for_missing_memories(
                query=search_req.query,
                memories=raw_memories,
            )
            retrieval_size = len(raw_memories) - len(enhanced_memories)
            logger.info(f"Retrieval size: {retrieval_size}")
            if trigger:
                logger.info(f"Triggering additional search with hint: {missing_info_hint}")
                additional_memories = self.searcher.search(
                    query=missing_info_hint,
                    user_name=user_context.mem_cube_id,
                    top_k=retrieval_size,
                    mode=SearchMode.FAST,
                    memory_type="All",
                    search_filter=search_filter,
                    info=info,
                )
            else:
                logger.info("Not triggering additional search, using fast memories.")
                additional_memories = raw_memories[:retrieval_size]

            enhanced_memories += additional_memories
            logger.info(
                f"Added {len(additional_memories)} more memories. Total enhanced memories: {len(enhanced_memories)}"
            )
        formatted_memories = [format_memory_item(data) for data in enhanced_memories]

        logger.info(f"Found {len(formatted_memories)} memories for user {search_req.user_id}")

        return formatted_memories

    def _mix_search(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
    ) -> list:
        """
        Mix search combining fast and fine-grained approaches.

        Args:
            search_req: Search request
            user_context: User context

        Returns:
            List of formatted search results
        """
        return self.mem_scheduler.mix_search_memories(
            search_req=search_req,
            user_context=user_context,
        )
