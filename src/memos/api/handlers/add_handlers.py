"""
Add handler for memory addition functionality.

This module handles adding new memories to the system, supporting both
text and preference memory additions with optional async processing.
"""

import json
import os

from datetime import datetime
from typing import Any

from memos.api.product_models import APIADDRequest, MemoryResponse
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    MEM_READ_LABEL,
    PREF_ADD_LABEL,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.types import UserContext


logger = get_logger(__name__)


def _process_text_mem(
    add_req: APIADDRequest,
    user_context: UserContext,
    naive_mem_cube: Any,
    mem_reader: Any,
    mem_scheduler: Any,
) -> list[dict[str, str]]:
    """
    Process and add text memories.

    Extracts memories from messages and adds them to the text memory system.
    Handles both sync and async modes.

    Args:
        add_req: Add memory request
        user_context: User context with IDs
        naive_mem_cube: Memory cube instance
        mem_reader: Memory reader for extraction
        mem_scheduler: Scheduler for async tasks

    Returns:
        List of formatted memory responses
    """
    target_session_id = add_req.session_id or "default_session"

    # Determine sync mode
    try:
        sync_mode = getattr(naive_mem_cube.text_mem, "mode", "sync")
    except Exception:
        sync_mode = "sync"

    logger.info(f"Processing text memory with mode: {sync_mode}")

    memories_local = mem_reader.get_memory(
        [add_req.messages],
        type="chat",
        info={
            "user_id": add_req.user_id,
            "session_id": target_session_id,
        },
        mode="fast" if sync_mode == "async" else "fine",
    )
    flattened_local = [mm for m in memories_local for mm in m]
    logger.info(f"Memory extraction completed for user {add_req.user_id}")

    mem_ids_local: list[str] = naive_mem_cube.text_mem.add(
        flattened_local,
        user_name=user_context.mem_cube_id,
    )
    logger.info(
        f"Added {len(mem_ids_local)} memories for user {add_req.user_id} "
        f"in session {add_req.session_id}: {mem_ids_local}"
    )

    # Handle async/sync scheduling
    if sync_mode == "async":
        try:
            message_item_read = ScheduleMessageItem(
                user_id=add_req.user_id,
                session_id=target_session_id,
                mem_cube_id=add_req.mem_cube_id,
                mem_cube=naive_mem_cube,
                label=MEM_READ_LABEL,
                content=json.dumps(mem_ids_local),
                timestamp=datetime.utcnow(),
                user_name=add_req.mem_cube_id,
            )
            mem_scheduler.submit_messages(messages=[message_item_read])
            logger.info(f"Submitted async memory read task: {json.dumps(mem_ids_local)}")
        except Exception as e:
            logger.error(f"Failed to submit async memory tasks: {e}", exc_info=True)
    else:
        message_item_add = ScheduleMessageItem(
            user_id=add_req.user_id,
            session_id=target_session_id,
            mem_cube_id=add_req.mem_cube_id,
            mem_cube=naive_mem_cube,
            label=ADD_LABEL,
            content=json.dumps(mem_ids_local),
            timestamp=datetime.utcnow(),
            user_name=add_req.mem_cube_id,
        )
        mem_scheduler.submit_messages(messages=[message_item_add])

    return [
        {
            "memory": memory.memory,
            "memory_id": memory_id,
            "memory_type": memory.metadata.memory_type,
        }
        for memory_id, memory in zip(mem_ids_local, flattened_local, strict=False)
    ]


def _process_pref_mem(
    add_req: APIADDRequest,
    user_context: UserContext,
    naive_mem_cube: Any,
    mem_scheduler: Any,
) -> list[dict[str, str]]:
    """
    Process and add preference memories.

    Extracts preferences from messages and adds them to the preference memory system.
    Handles both sync and async modes.

    Args:
        add_req: Add memory request
        user_context: User context with IDs
        naive_mem_cube: Memory cube instance
        mem_scheduler: Scheduler for async tasks

    Returns:
        List of formatted preference responses
    """
    if os.getenv("ENABLE_PREFERENCE_MEMORY", "false").lower() != "true":
        return []

    # Determine sync mode
    try:
        sync_mode = getattr(naive_mem_cube.text_mem, "mode", "sync")
    except Exception:
        sync_mode = "sync"

    target_session_id = add_req.session_id or "default_session"

    # Follow async behavior: enqueue when async
    if sync_mode == "async":
        try:
            messages_list = [add_req.messages]
            message_item_pref = ScheduleMessageItem(
                user_id=add_req.user_id,
                session_id=target_session_id,
                mem_cube_id=add_req.mem_cube_id,
                mem_cube=naive_mem_cube,
                label=PREF_ADD_LABEL,
                content=json.dumps(messages_list),
                timestamp=datetime.utcnow(),
            )
            mem_scheduler.submit_messages(messages=[message_item_pref])
            logger.info("Submitted preference add to scheduler (async mode)")
        except Exception as e:
            logger.error(f"Failed to submit PREF_ADD task: {e}", exc_info=True)
        return []
    else:
        pref_memories_local = naive_mem_cube.pref_mem.get_memory(
            [add_req.messages],
            type="chat",
            info={
                "user_id": add_req.user_id,
                "session_id": target_session_id,
                "mem_cube_id": add_req.mem_cube_id,
            },
        )
        pref_ids_local: list[str] = naive_mem_cube.pref_mem.add(pref_memories_local)
        logger.info(
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


def handle_add_memories(
    add_req: APIADDRequest,
    naive_mem_cube: Any,
    mem_reader: Any,
    mem_scheduler: Any,
) -> MemoryResponse:
    """
    Main handler for add memories endpoint.

    Orchestrates the addition of both text and preference memories,
    supporting concurrent processing.

    Args:
        add_req: Add memory request
        naive_mem_cube: Memory cube instance
        mem_reader: Memory reader for extraction
        mem_scheduler: Scheduler for async tasks

    Returns:
        MemoryResponse with added memory information
    """
    # Create UserContext object
    user_context = UserContext(
        user_id=add_req.user_id,
        mem_cube_id=add_req.mem_cube_id,
        session_id=add_req.session_id or "default_session",
    )

    logger.info(f"Add Req is: {add_req}")

    with ContextThreadPoolExecutor(max_workers=2) as executor:
        text_future = executor.submit(
            _process_text_mem,
            add_req,
            user_context,
            naive_mem_cube,
            mem_reader,
            mem_scheduler,
        )
        pref_future = executor.submit(
            _process_pref_mem,
            add_req,
            user_context,
            naive_mem_cube,
            mem_scheduler,
        )
        text_response_data = text_future.result()
        pref_response_data = pref_future.result()

    logger.info(f"add_memories Text response data: {text_response_data}")
    logger.info(f"add_memories Pref response data: {pref_response_data}")

    return MemoryResponse(
        message="Memory added successfully",
        data=text_response_data + pref_response_data,
    )
