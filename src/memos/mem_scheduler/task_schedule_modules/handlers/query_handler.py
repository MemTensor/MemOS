import threading

from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    MEM_UPDATE_TASK_LABEL,
    NOT_APPLICABLE_TYPE,
    QUERY_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler


logger = get_logger(__name__)


class QueryHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = QUERY_TASK_LABEL
        self._local = threading.local()

    def __call__(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        self._local.mem_update_messages = []
        try:
            super().__call__(messages)

            if self.context.submit_messages and self._local.mem_update_messages:
                self.context.submit_messages(self._local.mem_update_messages)
        finally:
            self._local.mem_update_messages = []

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        if not hasattr(self._local, "mem_update_messages"):
            self._local.mem_update_messages = []

        for msg in batch:
            try:
                if self.context.create_event_log and self.context.submit_web_logs:
                    event = self.context.create_event_log(
                        label="addMessage",
                        from_memory_type=USER_INPUT_TYPE,
                        to_memory_type=NOT_APPLICABLE_TYPE,
                        user_id=msg.user_id,
                        mem_cube_id=msg.mem_cube_id,
                        mem_cube=self.context.mem_cube,
                        memcube_log_content=[
                            {
                                "content": f"[User] {msg.content}",
                                "ref_id": msg.item_id,
                                "role": "user",
                            }
                        ],
                        metadata=[],
                        memory_len=1,
                        memcube_name=self.context.map_memcube_name(msg.mem_cube_id)
                        if self.context.map_memcube_name
                        else None,
                    )
                    event.task_id = msg.task_id
                    self.context.submit_web_logs([event])
            except Exception as e:
                self.handle_exception(e, "Failed to record addMessage log for query")
            # Re-submit the message with label changed to mem_update
            update_msg = ScheduleMessageItem(
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                label=MEM_UPDATE_TASK_LABEL,
                content=msg.content,
                session_id=msg.session_id,
                user_name=msg.user_name,
                info=msg.info,
                task_id=msg.task_id,
            )
            self._local.mem_update_messages.append(update_msg)
