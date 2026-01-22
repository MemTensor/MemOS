import json

from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import PREF_ADD_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler
from memos.memories.textual.preference import PreferenceTextMemory


logger = get_logger(__name__)


class PrefAddHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = PREF_ADD_TASK_LABEL

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        for message in batch:
            try:
                mem_cube = self.context.mem_cube
                if mem_cube is None:
                    logger.warning(
                        f"mem_cube is None for user_id={message.user_id}, mem_cube_id={message.mem_cube_id}, skipping processing"
                    )
                    continue

                user_id = message.user_id
                session_id = message.session_id
                mem_cube_id = message.mem_cube_id
                content = message.content
                messages_list = json.loads(content)
                info = message.info or {}

                logger.info(f"Processing pref_add for user_id={user_id}, mem_cube_id={mem_cube_id}")

                # Get the preference memory from the mem_cube
                pref_mem = mem_cube.pref_mem
                if pref_mem is None:
                    logger.warning(
                        f"Preference memory not initialized for mem_cube_id={mem_cube_id}, "
                        f"skipping pref_add processing"
                    )
                    continue
                if not isinstance(pref_mem, PreferenceTextMemory):
                    logger.error(
                        f"Expected PreferenceTextMemory but got {type(pref_mem).__name__} "
                        f"for mem_cube_id={mem_cube_id}"
                    )
                    continue

                # Use pref_mem.get_memory to process the memories
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
                # Add pref_mem to vector db
                pref_ids = pref_mem.add(pref_memories)

                logger.info(
                    f"Successfully processed and add preferences for user_id={user_id}, mem_cube_id={mem_cube_id}, pref_ids={pref_ids}"
                )

            except Exception as e:
                logger.error(f"Error processing pref_add message: {e}", exc_info=True)
