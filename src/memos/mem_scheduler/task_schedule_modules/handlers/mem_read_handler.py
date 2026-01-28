import json

from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import MEM_READ_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler
from memos.memories.textual.tree import TreeTextMemory


logger = get_logger(__name__)


class MemReadHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = MEM_READ_TASK_LABEL

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        for message in batch:
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = self.context.mem_cube
                if mem_cube is None:
                    logger.error(
                        f"mem_cube is None for user_id={user_id}, mem_cube_id={mem_cube_id}, skipping processing",
                        stack_info=True,
                    )
                    continue

                content = message.content
                user_name = message.user_name
                info = message.info or {}

                # Parse the memory IDs from content
                mem_ids = json.loads(content) if isinstance(content, str) else content
                if not mem_ids:
                    continue

                logger.info(
                    f"Processing mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}, mem_ids={mem_ids}"
                )

                # Get the text memory from the mem_cube
                text_mem = mem_cube.text_mem
                if not isinstance(text_mem, TreeTextMemory):
                    logger.error(f"Expected TreeTextMemory but got {type(text_mem).__name__}")
                    continue

                # Use mem_reader to process the memories
                if self.context.process_memories_with_reader:
                    self.context.process_memories_with_reader(
                        mem_ids=mem_ids,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        text_mem=text_mem,
                        user_name=user_name,
                        custom_tags=info.get("custom_tags", None),
                        task_id=message.task_id,
                        info=info,
                    )
                else:
                    logger.error("process_memories_with_reader not available in context")

                logger.info(
                    f"Successfully processed mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_read message: {e}", stack_info=True)
