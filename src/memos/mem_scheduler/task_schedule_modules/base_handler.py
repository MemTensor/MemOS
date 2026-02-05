from __future__ import annotations

from abc import abstractmethod
from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube


if TYPE_CHECKING:
    from collections.abc import Callable

    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.mem_scheduler.task_schedule_modules.context import SchedulerHandlerContext


logger = get_logger(__name__)


class BaseSchedulerHandler:
    def __init__(self, scheduler_context: SchedulerHandlerContext) -> None:
        self.scheduler_context = scheduler_context

    @property
    @abstractmethod
    def expected_task_label(self) -> str:
        """The expected task label for this handler."""
        ...

    def validate_and_log_messages(self, messages: list[ScheduleMessageItem], label: str) -> None:
        logger.info(f"Messages {messages} assigned to {label} handler.")
        self.scheduler_context.services.validate_messages(messages=messages, label=label)

    def handle_exception(self, e: Exception, message: str = "Error processing messages") -> None:
        logger.error(f"{message}: {e}", exc_info=True)

    def process_grouped_messages(
        self,
        messages: list[ScheduleMessageItem],
        message_handler: Callable[[str, str, list[ScheduleMessageItem]], None],
    ) -> None:
        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)
        for user_id, user_batches in grouped_messages.items():
            for mem_cube_id, batch in user_batches.items():
                if not batch:
                    continue
                try:
                    message_handler(user_id, mem_cube_id, batch)
                except Exception as e:
                    self.handle_exception(
                        e, f"Error processing batch for user {user_id}, mem_cube {mem_cube_id}"
                    )

    @abstractmethod
    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None: ...

    def __call__(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process the messages.
        """
        self.validate_and_log_messages(messages=messages, label=self.expected_task_label)

        self.process_grouped_messages(
            messages=messages,
            message_handler=self.batch_handler,
        )
