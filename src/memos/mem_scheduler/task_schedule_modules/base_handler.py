from abc import ABC, abstractmethod
from collections.abc import Callable

from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube


logger = get_logger(__name__)


class BaseHandler(ABC):
    def __init__(self, context: SchedulerContext):
        self.context = context
        self.expected_task_label = None

    def validate_and_log_messages(self, messages: list[ScheduleMessageItem], label: str) -> None:
        """
        Log the assignment of messages to the handler and validate them if a validator is present in the context.
        """
        logger.info(f"Messages {messages} assigned to {label} handler.")
        if self.context.validate_schedule_messages:
            self.context.validate_schedule_messages(messages, label)

    def handle_exception(self, e: Exception, message: str = "Error processing messages") -> None:
        """
        Log an exception with a custom message and stack trace.
        """
        logger.error(f"{message}: {e}", exc_info=True)

    def process_grouped_messages(
        self,
        messages: list[ScheduleMessageItem],
        message_handler: Callable[[str, str, list[ScheduleMessageItem]], None],
    ) -> None:
        """
        Group messages and process them in batches.
        """
        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)
        for user_id, user_batches in grouped_messages.items():
            for mem_cube_id, batch in user_batches.items():
                if not batch:
                    continue
                message_handler(user_id, mem_cube_id, batch)

    @abstractmethod
    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        pass

    def __call__(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process the messages.
        """
        self.validate_and_log_messages(messages=messages, label=self.expected_task_label)

        self.process_grouped_messages(
            messages=messages,
            message_handler=self.batch_handler,
        )
