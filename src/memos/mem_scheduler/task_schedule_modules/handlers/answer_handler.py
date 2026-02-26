from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import (
    ANSWER_TASK_LABEL,
    NOT_APPLICABLE_TYPE,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler


logger = get_logger(__name__)

if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


class AnswerMessageHandler(BaseSchedulerHandler):
    @property
    def expected_task_label(self) -> str:
        return ANSWER_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        for msg in batch:
            event = self.scheduler_context.services.create_event_log(
                label="addMessage",
                from_memory_type=USER_INPUT_TYPE,
                to_memory_type=NOT_APPLICABLE_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.scheduler_context.get_mem_cube(),
                memcube_log_content=[
                    {
                        "content": f"[Assistant] {msg.content}",
                        "ref_id": msg.item_id,
                        "role": "assistant",
                    }
                ],
                metadata=[],
                memory_len=1,
                memcube_name=self.scheduler_context.services.map_memcube_name(msg.mem_cube_id),
            )
            event.task_id = msg.task_id
            self.scheduler_context.services.submit_web_logs([event])
