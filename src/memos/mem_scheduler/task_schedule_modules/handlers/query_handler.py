from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    MEM_UPDATE_TASK_LABEL,
    NOT_APPLICABLE_TYPE,
    QUERY_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler


logger = get_logger(__name__)


class QueryMessageHandler(BaseSchedulerHandler):
    @property
    def expected_task_label(self) -> str:
        return QUERY_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        mem_update_messages: list[ScheduleMessageItem] = []
        for msg in batch:
            try:
                event = self.scheduler_context.services.create_event_log(
                    label="addMessage",
                    from_memory_type=USER_INPUT_TYPE,
                    to_memory_type=NOT_APPLICABLE_TYPE,
                    user_id=msg.user_id,
                    mem_cube_id=msg.mem_cube_id,
                    mem_cube=self.scheduler_context.get_mem_cube(),
                    memcube_log_content=[
                        {
                            "content": f"[User] {msg.content}",
                            "ref_id": msg.item_id,
                            "role": "user",
                        }
                    ],
                    metadata=[],
                    memory_len=1,
                    memcube_name=self.scheduler_context.services.map_memcube_name(msg.mem_cube_id),
                )
                event.task_id = msg.task_id
                self.scheduler_context.services.submit_web_logs([event])
            except Exception:
                logger.exception("Failed to record addMessage log for query")

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
            mem_update_messages.append(update_msg)

        if mem_update_messages:
            self.scheduler_context.services.submit_messages(messages=mem_update_messages)
