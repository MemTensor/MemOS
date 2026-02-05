from __future__ import annotations

import concurrent.futures
import json

from typing import TYPE_CHECKING

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import PREF_ADD_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.memories.textual.preference import PreferenceTextMemory


logger = get_logger(__name__)

if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


class PrefAddMessageHandler(BaseSchedulerHandler):
    @property
    def expected_task_label(self) -> str:
        return PREF_ADD_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        with ContextThreadPoolExecutor(max_workers=min(8, len(batch))) as executor:
            futures = [executor.submit(self.process_message, msg) for msg in batch]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error("Thread task failed: %s", e, exc_info=True)

    def process_message(self, message: ScheduleMessageItem):
        try:
            mem_cube = self.scheduler_context.get_mem_cube()
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
