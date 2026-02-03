from __future__ import annotations

import concurrent.futures
import json

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.handlers.base import BaseSchedulerHandler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import PREF_ADD_TASK_LABEL
from memos.memories.textual.preference import PreferenceTextMemory


logger = get_logger(__name__)


class PrefAddMessageHandler(BaseSchedulerHandler):
    def handle(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {PREF_ADD_TASK_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                mem_cube = self.ctx.get_mem_cube()
                if mem_cube is None:
                    logger.warning(
                        "mem_cube is None for user_id=%s, mem_cube_id=%s, skipping processing",
                        message.user_id,
                        message.mem_cube_id,
                    )
                    return

                user_id = message.user_id
                session_id = message.session_id
                mem_cube_id = message.mem_cube_id
                content = message.content
                messages_list = json.loads(content)
                info = message.info or {}

                logger.info("Processing pref_add for user_id=%s, mem_cube_id=%s", user_id, mem_cube_id)

                pref_mem = mem_cube.pref_mem
                if pref_mem is None:
                    logger.warning(
                        "Preference memory not initialized for mem_cube_id=%s, skipping pref_add processing",
                        mem_cube_id,
                    )
                    return
                if not isinstance(pref_mem, PreferenceTextMemory):
                    logger.error(
                        "Expected PreferenceTextMemory but got %s for mem_cube_id=%s",
                        type(pref_mem).__name__,
                        mem_cube_id,
                    )
                    return

                pref_memories = pref_mem.get_memory(
                    messages_list,
                    type="chat",
                    info={
                        **info,
                        "user_id": user_id,
                        "session_id": session_id,
                        "mem_cube_id": mem_cube_id,
                    },
                )
                pref_ids = pref_mem.add(pref_memories)

                logger.info(
                    "Successfully processed and add preferences for user_id=%s, mem_cube_id=%s, pref_ids=%s",
                    user_id,
                    mem_cube_id,
                    pref_ids,
                )

            except Exception as e:
                logger.error("Error processing pref_add message: %s", e, exc_info=True)

        with ContextThreadPoolExecutor(max_workers=min(8, len(messages))) as executor:
            futures = [executor.submit(process_message, msg) for msg in messages]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error("Thread task failed: %s", e, exc_info=True)
