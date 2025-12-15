from __future__ import annotations

import json
import os
import traceback

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from memos.api.handlers.formatters_handler import (
    format_memory_item,
    post_process_pref_mem,
    post_process_textual_mem,
)
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    MEM_FEEDBACK_TASK_LABEL,
    MEM_READ_TASK_LABEL,
    PREF_ADD_TASK_LABEL,
)
from memos.multi_mem_cube.views import MemCubeView
from memos.types.general_types import (
    FINE_STRATEGY,
    FineStrategy,
    MOSSearchResult,
    SearchMode,
    UserContext,
)
from memos.utils import timed


logger = get_logger(__name__)


if TYPE_CHECKING:
    from memos.api.product_models import APIADDRequest, APIFeedbackRequest, APISearchRequest
    from memos.mem_cube.navie import NaiveMemCube
    from memos.mem_reader.simple_struct import SimpleStructMemReader
    from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler


@dataclass
class SingleCubeView(MemCubeView):
    cube_id: str
    naive_mem_cube: NaiveMemCube
    mem_reader: SimpleStructMemReader
    mem_scheduler: OptimizedScheduler
    logger: Any
    searcher: Any
    feedback_server: Any | None = None
    deepsearch_agent: Any | None = None

    def add_memories(self, add_req: APIADDRequest) -> list[dict[str, Any]]:
        """
        This is basically your current handle_add_memories logic,
        but scoped to a single cube_id.
        """
        sync_mode = add_req.async_mode or self._get_sync_mode()
        self.logger.info(
            f"[DIAGNOSTIC] single_cube.add_memories called for cube_id: {self.cube_id}. sync_mode: {sync_mode}. Request: {add_req.model_dump_json(indent=2)}"
        )
        user_context = UserContext(
            user_id=add_req.user_id,
            mem_cube_id=self.cube_id,
            session_id=add_req.session_id or "default_session",
        )

        target_session_id = add_req.session_id or "default_session"
        sync_mode = add_req.async_mode or self._get_sync_mode()

        self.logger.info(
            f"[SingleCubeView] cube={self.cube_id} "
            f"Processing add with mode={sync_mode}, session={target_session_id}"
        )

        with ContextThreadPoolExecutor(max_workers=2) as executor:
            text_future = executor.submit(self._process_text_mem, add_req, user_context, sync_mode)
            pref_future = executor.submit(self._process_pref_mem, add_req, user_context, sync_mode)

            text_results = text_future.result()
            pref_results = pref_future.result()

        self.logger.info(
            f"[SingleCubeView] cube={self.cube_id} text_results={len(text_results)}, "
            f"pref_results={len(pref_results)}"
        )

        for item in text_results:
            item["cube_id"] = self.cube_id
        for item in pref_results:
            item["cube_id"] = self.cube_id

        all_memories = text_results + pref_results

        # TODO: search existing memories and compare

        return all_memories

    def search_memories(self, search_req: APISearchRequest) -> dict[str, Any]:
        # Create UserContext object
        user_context = UserContext(
            user_id=search_req.user_id,
            mem_cube_id=self.cube_id,
            session_id=search_req.session_id or "default_session",
        )
        self.logger.info(f"Search Req is: {search_req}")

        memories_result: MOSSearchResult = {
            "text_mem": [],
            "act_mem": [],
            "para_mem": [],
            "pref_mem": [],
            "pref_note": "",
            "tool_mem": [],
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
        memories_result = post_process_textual_mem(
            memories_result,
            text_formatted_memories,
            self.cube_id,
        )

        memories_result = post_process_pref_mem(
            memories_result,
            pref_formatted_memories,
            self.cube_id,
            search_req.include_preference,
        )

        self.logger.info(f"Search memories result: {memories_result}")
        self.logger.info(f"Search {len(memories_result)} memories.")
        return memories_result

    def feedback_memories(self, feedback_req: APIFeedbackRequest) -> dict[str, Any]:
        target_session_id = feedback_req.session_id or "default_session"
        if feedback_req.async_mode == "async":
            try:
                feedback_req_str = json.dumps(feedback_req.model_dump())
                message_item_feedback = ScheduleMessageItem(
                    user_id=feedback_req.user_id,
                    task_id=feedback_req.task_id,
                    session_id=target_session_id,
                    mem_cube_id=self.cube_id,
                    mem_cube=self.naive_mem_cube,
                    label=MEM_FEEDBACK_TASK_LABEL,
                    content=feedback_req_str,
                    timestamp=datetime.utcnow(),
                )
                # Use scheduler submission to ensure tracking and metrics
                self.mem_scheduler.submit_messages(messages=[message_item_feedback])
                self.logger.info(f"[SingleCubeView] cube={self.cube_id} Submitted FEEDBACK async")
            except Exception as e:
                self.logger.error(
                    f"[SingleCubeView] cube={self.cube_id} Failed to submit FEEDBACK: {e}",
                    exc_info=True,
                )
            return []
        else:
            feedback_result = self.feedback_server.process_feedback(
                user_id=feedback_req.user_id,
                user_name=self.cube_id,
                session_id=feedback_req.session_id,
                chat_history=feedback_req.history,
                retrieved_memory_ids=feedback_req.retrieved_memory_ids,
                feedback_content=feedback_req.feedback_content,
                feedback_time=feedback_req.feedback_time,
                async_mode=feedback_req.async_mode,
                corrected_answer=feedback_req.corrected_answer,
                task_id=feedback_req.task_id,
                info=feedback_req.info,
            )
            self.logger.info(f"[Feedback memories result:] {feedback_result}")
        return feedback_result

    def _get_search_mode(self, mode: str) -> str:
        """
        Get search mode with environment variable fallback.

        Args:
            mode: Requested search mode

        Returns:
            Search mode string
        """
        return mode

    @timed
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
            search_mode: Search mode (fast, fine, or mixture)

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

    def _deep_search(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
    ) -> list:
        target_session_id = search_req.session_id or "default_session"
        search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

        info = {
            "user_id": search_req.user_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        }

        enhanced_memories = self.searcher.deep_search(
            query=search_req.query,
            user_name=user_context.mem_cube_id,
            top_k=search_req.top_k,
            mode=SearchMode.FINE,
            manual_close_internet=not search_req.internet_search,
            moscube=search_req.moscube,
            search_filter=search_filter,
            info=info,
        )
        formatted_memories = [format_memory_item(data) for data in enhanced_memories]
        return formatted_memories

    def _agentic_search(
        self, search_req: APISearchRequest, user_context: UserContext, max_thinking_depth: int
    ) -> list:
        deepsearch_results = self.deepsearch_agent.run(
            search_req.query, user_id=user_context.mem_cube_id
        )
        formatted_memories = [format_memory_item(data) for data in deepsearch_results]
        return formatted_memories

    def _fine_search(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
    ) -> list:
        """
        Fine-grained search with query enhancement.

        Args:
            search_req: Search request
            user_context: User context

        Returns:
            List of enhanced search results
        """
        # TODO: support tool memory search in future

        logger.info(f"Fine strategy: {FINE_STRATEGY}")
        if FINE_STRATEGY == FineStrategy.DEEP_SEARCH:
            return self._deep_search(search_req=search_req, user_context=user_context)
        elif FINE_STRATEGY == FineStrategy.AGENTIC_SEARCH:
            return self._agentic_search(search_req=search_req, user_context=user_context)

        target_session_id = search_req.session_id or "default_session"
        search_priority = {"session_id": search_req.session_id} if search_req.session_id else None
        search_filter = search_req.filter

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
            search_priority=search_priority,
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
                memories=[mem.memory for mem in enhanced_memories],
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
                    search_priority=search_priority,
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

    @timed
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
            TODO: ADD CUBE ID IN PREFERENCE MEMORY
        """
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
            return []
        if not search_req.include_preference:
            return []

        logger.info(f"search_req.filter for preference memory: {search_req.filter}")
        logger.info(f"type of pref_mem: {type(self.naive_mem_cube.pref_mem)}")
        try:
            results = self.naive_mem_cube.pref_mem.search(
                query=search_req.query,
                top_k=search_req.pref_top_k,
                info={
                    "user_id": search_req.user_id,
                    "mem_cube_id": user_context.mem_cube_id,
                    "session_id": search_req.session_id,
                    "chat_history": search_req.chat_history,
                },
                search_filter=search_req.filter,
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
        search_priority = {"session_id": search_req.session_id} if search_req.session_id else None
        search_filter = search_req.filter or None
        plugin = bool(search_req.source is not None and search_req.source == "plugin")

        search_results = self.naive_mem_cube.text_mem.search(
            query=search_req.query,
            user_name=user_context.mem_cube_id,
            top_k=search_req.top_k,
            mode=SearchMode.FAST,
            manual_close_internet=not search_req.internet_search,
            memory_type=search_req.search_memory_type,
            search_filter=search_filter,
            search_priority=search_priority,
            info={
                "user_id": search_req.user_id,
                "session_id": target_session_id,
                "chat_history": search_req.chat_history,
            },
            plugin=plugin,
            search_tool_memory=search_req.search_tool_memory,
            tool_mem_top_k=search_req.tool_mem_top_k,
        )

        formatted_memories = [format_memory_item(data) for data in search_results]

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

    def _get_sync_mode(self) -> str:
        """
        Get synchronization mode from memory cube.

        Returns:
            Sync mode string ("sync" or "async")
        """
        try:
            return getattr(self.naive_mem_cube.text_mem, "mode", "sync")
        except Exception:
            return "sync"

    def _schedule_memory_tasks(
        self,
        add_req: APIADDRequest,
        user_context: UserContext,
        mem_ids: list[str],
        sync_mode: str,
    ) -> None:
        """
        Schedule memory processing tasks based on sync mode.

        Args:
            add_req: Add memory request
            user_context: User context
            mem_ids: List of memory IDs
            sync_mode: Synchronization mode
        """
        target_session_id = add_req.session_id or "default_session"

        if sync_mode == "async":
            # Async mode: submit MEM_READ_LABEL task
            try:
                message_item_read = ScheduleMessageItem(
                    user_id=add_req.user_id,
                    task_id=add_req.task_id,
                    session_id=target_session_id,
                    mem_cube_id=self.cube_id,
                    mem_cube=self.naive_mem_cube,
                    label=MEM_READ_TASK_LABEL,
                    content=json.dumps(mem_ids),
                    timestamp=datetime.utcnow(),
                    user_name=self.cube_id,
                    info=add_req.info,
                )
                self.mem_scheduler.submit_messages(messages=[message_item_read])
                self.logger.info(
                    f"[SingleCubeView] cube={self.cube_id} Submitted async MEM_READ: {json.dumps(mem_ids)}"
                )
            except Exception as e:
                self.logger.error(
                    f"[SingleCubeView] cube={self.cube_id} Failed to submit async memory tasks: {e}",
                    exc_info=True,
                )
        else:
            message_item_add = ScheduleMessageItem(
                user_id=add_req.user_id,
                task_id=add_req.task_id,
                session_id=target_session_id,
                mem_cube_id=self.cube_id,
                mem_cube=self.naive_mem_cube,
                label=ADD_TASK_LABEL,
                content=json.dumps(mem_ids),
                timestamp=datetime.utcnow(),
                user_name=self.cube_id,
            )
            self.mem_scheduler.submit_messages(messages=[message_item_add])

    def _process_pref_mem(
        self,
        add_req: APIADDRequest,
        user_context: UserContext,
        sync_mode: str,
    ) -> list[dict[str, Any]]:
        """
        Process and add preference memories.

        Extracts preferences from messages and adds them to the preference memory system.
        Handles both sync and async modes.

        Args:
            add_req: Add memory request
            user_context: User context with IDs

        Returns:
            List of formatted preference responses
        """
        if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
            return []

        if add_req.messages is None or isinstance(add_req.messages, str):
            return []

        for message in add_req.messages:
            if isinstance(message, dict) and message.get("role", None) is None:
                return []

        target_session_id = add_req.session_id or "default_session"

        if sync_mode == "async":
            try:
                messages_list = [add_req.messages]
                message_item_pref = ScheduleMessageItem(
                    user_id=add_req.user_id,
                    session_id=target_session_id,
                    mem_cube_id=user_context.mem_cube_id,
                    mem_cube=self.naive_mem_cube,
                    label=PREF_ADD_TASK_LABEL,
                    content=json.dumps(messages_list),
                    timestamp=datetime.utcnow(),
                    info=add_req.info,
                    user_name=self.cube_id,
                    task_id=add_req.task_id,
                )
                self.mem_scheduler.submit_messages(messages=[message_item_pref])
                self.logger.info(f"[SingleCubeView] cube={self.cube_id} Submitted PREF_ADD async")
            except Exception as e:
                self.logger.error(
                    f"[SingleCubeView] cube={self.cube_id} Failed to submit PREF_ADD: {e}",
                    exc_info=True,
                )
            return []
        else:
            pref_memories_local = self.naive_mem_cube.pref_mem.get_memory(
                [add_req.messages],
                type="chat",
                info={
                    **(add_req.info or {}),
                    "user_id": add_req.user_id,
                    "session_id": target_session_id,
                    "mem_cube_id": user_context.mem_cube_id,
                },
            )
            pref_ids_local: list[str] = self.naive_mem_cube.pref_mem.add(pref_memories_local)
            self.logger.info(
                f"[SingleCubeView] cube={self.cube_id} "
                f"added {len(pref_ids_local)} preferences for user {add_req.user_id}: {pref_ids_local}"
            )

            return [
                {
                    "memory": memory.metadata.preference,
                    "memory_id": memory_id,
                    "memory_type": memory.metadata.preference_type,
                }
                for memory_id, memory in zip(pref_ids_local, pref_memories_local, strict=False)
            ]

    def _process_text_mem(
        self,
        add_req: APIADDRequest,
        user_context: UserContext,
        sync_mode: str,
    ) -> list[dict[str, Any]]:
        """
        Process and add text memories.

        Extracts memories from messages and adds them to the text memory system.
        Handles both sync and async modes.

        Args:
            add_req: Add memory request
            user_context: User context with IDs

        Returns:
            List of formatted memory responses
        """
        target_session_id = add_req.session_id or "default_session"

        # Decide extraction mode:
        # - async: always fast (ignore add_req.mode)
        # - sync: use add_req.mode == "fast" to switch to fast pipeline, otherwise fine
        if sync_mode == "async":
            extract_mode = "fast"
        else:  # sync
            extract_mode = "fast" if add_req.mode == "fast" else "fine"

        self.logger.info(
            "[SingleCubeView] cube=%s Processing text memory "
            "with sync_mode=%s, extract_mode=%s, add_mode=%s",
            user_context.mem_cube_id,
            sync_mode,
            extract_mode,
            add_req.mode,
        )

        # Extract memories
        memories_local = self.mem_reader.get_memory(
            [add_req.messages],
            type="chat",
            info={
                **(add_req.info or {}),
                "custom_tags": add_req.custom_tags,
                "user_id": add_req.user_id,
                "session_id": target_session_id,
            },
            mode=extract_mode,
        )
        flattened_local = [mm for m in memories_local for mm in m]

        # Explicitly set source_doc_id to metadata if present in info
        source_doc_id = (add_req.info or {}).get("source_doc_id")
        if source_doc_id:
            for memory in flattened_local:
                memory.metadata.source_doc_id = source_doc_id

        self.logger.info(f"Memory extraction completed for user {add_req.user_id}")

        # Add memories to text_mem
        mem_ids_local: list[str] = self.naive_mem_cube.text_mem.add(
            flattened_local,
            user_name=user_context.mem_cube_id,
        )
        self.logger.info(
            f"Added {len(mem_ids_local)} memories for user {add_req.user_id} "
            f"in session {add_req.session_id}: {mem_ids_local}"
        )

        # Schedule async/sync tasks
        self._schedule_memory_tasks(
            add_req=add_req,
            user_context=user_context,
            mem_ids=mem_ids_local,
            sync_mode=sync_mode,
        )

        text_memories = [
            {
                "memory": memory.memory,
                "memory_id": memory_id,
                "memory_type": memory.metadata.memory_type,
            }
            for memory_id, memory in zip(mem_ids_local, flattened_local, strict=False)
        ]

        return text_memories
