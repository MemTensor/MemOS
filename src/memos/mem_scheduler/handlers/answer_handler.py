from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.handlers.base import BaseSchedulerHandler
from memos.mem_scheduler.schemas.task_schemas import (
    ANSWER_TASK_LABEL,
    NOT_APPLICABLE_TYPE,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube


logger = get_logger(__name__)

if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


class AnswerMessageHandler(BaseSchedulerHandler):
    def handle(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {ANSWER_TASK_LABEL} handler.")
        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)

        self.ctx.services.validate_messages(messages=messages, label=ANSWER_TASK_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                batch = grouped_messages[user_id][mem_cube_id]
                if not batch:
                    continue
                try:
                    for msg in batch:
                        event = self.ctx.services.create_event_log(
                            label="addMessage",
                            from_memory_type=USER_INPUT_TYPE,
                            to_memory_type=NOT_APPLICABLE_TYPE,
                            user_id=msg.user_id,
                            mem_cube_id=msg.mem_cube_id,
                            mem_cube=self.ctx.get_mem_cube(),
                            memcube_log_content=[
                                {
                                    "content": f"[Assistant] {msg.content}",
                                    "ref_id": msg.item_id,
                                    "role": "assistant",
                                }
                            ],
                            metadata=[],
                            memory_len=1,
                            memcube_name=self.ctx.services.map_memcube_name(msg.mem_cube_id),
                        )
                        event.task_id = msg.task_id
                        self.ctx.services.submit_web_logs([event])
                except Exception:
                    logger.exception("Failed to record addMessage log for answer")
