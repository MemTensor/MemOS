from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import MEM_UPDATE_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler


logger = get_logger(__name__)


class MemoryUpdateHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = MEM_UPDATE_TASK_LABEL

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        # Process the whole batch once; no need to iterate per message
        if self.context.long_memory_update_process:
            self.context.long_memory_update_process(
                user_id=user_id, mem_cube_id=mem_cube_id, messages=batch
            )
        else:
            logger.error("long_memory_update_process is not available in context")
