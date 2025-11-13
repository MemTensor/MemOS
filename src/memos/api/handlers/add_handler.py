"""
Add handler for memory addition functionality (Class-based version).

This module provides a class-based implementation of add handlers,
using dependency injection for better modularity and testability.
"""

import json
import os

from datetime import datetime

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APIADDRequest, MemoryResponse
from memos.context.context import ContextThreadPoolExecutor
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    MEM_READ_LABEL,
    PREF_ADD_LABEL,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.types import UserContext


class AddHandler(BaseHandler):
    """
    Handler for memory addition operations.

    Handles both text and preference memory additions with sync/async support.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize add handler.

        Args:
            dependencies: HandlerDependencies instance
        """
        super().__init__(dependencies)
        self._validate_dependencies("naive_mem_cube", "mem_reader", "mem_scheduler")

    def handle_add_memories(self, add_req: APIADDRequest) -> MemoryResponse:
        """
        Main handler for add memories endpoint.

        Orchestrates the addition of both text and preference memories,
        supporting concurrent processing.

        Args:
            add_req: Add memory request

        Returns:
            MemoryResponse with added memory information
        """
        # Create UserContext object
        user_context = UserContext(
            user_id=add_req.user_id,
            mem_cube_id=add_req.mem_cube_id,
            session_id=add_req.session_id or "default_session",
        )

        self.logger.info(f"Add Req is: {add_req}")

        # Process text and preference memories in parallel
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            text_future = executor.submit(self._process_text_mem, add_req, user_context)
            pref_future = executor.submit(self._process_pref_mem, add_req, user_context)

            text_response_data = text_future.result()
            pref_response_data = pref_future.result()

        self.logger.info(f"add_memories Text response data: {text_response_data}")
        self.logger.info(f"add_memories Pref response data: {pref_response_data}")

        return MemoryResponse(
            message="Memory added successfully",
            data=text_response_data + pref_response_data,
        )

    def _process_text_mem(
        self,
        add_req: APIADDRequest,
        user_context: UserContext,
    ) -> list[dict[str, str]]:
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

        # Determine sync mode
        sync_mode = add_req.async_mode or self._get_sync_mode()

        self.logger.info(f"Processing text memory with mode: {sync_mode}")

        # Extract memories
        memories_local = self.mem_reader.get_memory(
            [add_req.messages],
            type="chat",
            info={
                "user_id": add_req.user_id,
                "session_id": target_session_id,
            },
            mode="fast" if sync_mode == "async" else "fine",
        )
        flattened_local = [mm for m in memories_local for mm in m]
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

        return [
            {
                "memory": memory.memory,
                "memory_id": memory_id,
                "memory_type": memory.metadata.memory_type,
            }
            for memory_id, memory in zip(mem_ids_local, flattened_local, strict=False)
        ]

    def _process_pref_mem(
        self,
        add_req: APIADDRequest,
        user_context: UserContext,
    ) -> list[dict[str, str]]:
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

        # Determine sync mode
        sync_mode = add_req.async_mode or self._get_sync_mode()
        target_session_id = add_req.session_id or "default_session"

        # Follow async behavior: enqueue when async
        if sync_mode == "async":
            try:
                messages_list = [add_req.messages]
                message_item_pref = ScheduleMessageItem(
                    user_id=add_req.user_id,
                    session_id=target_session_id,
                    mem_cube_id=add_req.mem_cube_id,
                    mem_cube=self.naive_mem_cube,
                    label=PREF_ADD_LABEL,
                    content=json.dumps(messages_list),
                    timestamp=datetime.utcnow(),
                )
                self.mem_scheduler.submit_messages(messages=[message_item_pref])
                self.logger.info("Submitted preference add to scheduler (async mode)")
            except Exception as e:
                self.logger.error(f"Failed to submit PREF_ADD task: {e}", exc_info=True)
            return []
        else:
            # Sync mode: process immediately
            pref_memories_local = self.naive_mem_cube.pref_mem.get_memory(
                [add_req.messages],
                type="chat",
                info={
                    "user_id": add_req.user_id,
                    "session_id": target_session_id,
                    "mem_cube_id": add_req.mem_cube_id,
                },
            )
            pref_ids_local: list[str] = self.naive_mem_cube.pref_mem.add(pref_memories_local)
            self.logger.info(
                f"Added {len(pref_ids_local)} preferences for user {add_req.user_id} "
                f"in session {add_req.session_id}: {pref_ids_local}"
            )
            return [
                {
                    "memory": memory.memory,
                    "memory_id": memory_id,
                    "memory_type": memory.metadata.preference_type,
                }
                for memory_id, memory in zip(pref_ids_local, pref_memories_local, strict=False)
            ]

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
                    session_id=target_session_id,
                    mem_cube_id=add_req.mem_cube_id,
                    mem_cube=self.naive_mem_cube,
                    label=MEM_READ_LABEL,
                    content=json.dumps(mem_ids),
                    timestamp=datetime.utcnow(),
                    user_name=add_req.mem_cube_id,
                )
                self.mem_scheduler.submit_messages(messages=[message_item_read])
                self.logger.info(f"Submitted async memory read task: {json.dumps(mem_ids)}")
            except Exception as e:
                self.logger.error(f"Failed to submit async memory tasks: {e}", exc_info=True)
        else:
            # Sync mode: submit ADD_LABEL task
            message_item_add = ScheduleMessageItem(
                user_id=add_req.user_id,
                session_id=target_session_id,
                mem_cube_id=add_req.mem_cube_id,
                mem_cube=self.naive_mem_cube,
                label=ADD_LABEL,
                content=json.dumps(mem_ids),
                timestamp=datetime.utcnow(),
                user_name=add_req.mem_cube_id,
            )
            self.mem_scheduler.submit_messages(messages=[message_item_add])
