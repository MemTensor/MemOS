from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import ADD_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler
from memos.mem_scheduler.utils.misc_utils import is_cloud_env


logger = get_logger(__name__)


class AddHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = ADD_TASK_LABEL

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        # Process each message in the batch
        for msg in batch:
            if self.context.log_add_messages:
                prepared_add_items, prepared_update_items_with_original = (
                    self.context.log_add_messages(msg=msg)
                )
            else:
                logger.error("log_add_messages not available in context")
                continue

            logger.info(
                f"prepared_add_items: {prepared_add_items};\n prepared_update_items_with_original: {prepared_update_items_with_original}"
            )
            # Conditional Logging: Knowledge Base (Cloud Service) vs. Playground/Default
            cloud_env = is_cloud_env()

            if cloud_env:
                if self.context.send_add_log_messages_to_cloud_env:
                    self.context.send_add_log_messages_to_cloud_env(
                        msg, prepared_add_items, prepared_update_items_with_original
                    )
            else:
                if self.context.send_add_log_messages_to_local_env:
                    self.context.send_add_log_messages_to_local_env(
                        msg, prepared_add_items, prepared_update_items_with_original
                    )
