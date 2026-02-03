from __future__ import annotations

from collections.abc import Callable

from memos.mem_scheduler.handlers.add_handler import AddMessageHandler
from memos.mem_scheduler.handlers.answer_handler import AnswerMessageHandler
from memos.mem_scheduler.handlers.context import SchedulerHandlerContext
from memos.mem_scheduler.handlers.feedback_handler import FeedbackMessageHandler
from memos.mem_scheduler.handlers.mem_read_handler import MemReadMessageHandler
from memos.mem_scheduler.handlers.mem_reorganize_handler import MemReorganizeMessageHandler
from memos.mem_scheduler.handlers.memory_update_handler import MemoryUpdateHandler
from memos.mem_scheduler.handlers.pref_add_handler import PrefAddMessageHandler
from memos.mem_scheduler.handlers.query_handler import QueryMessageHandler
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    MEM_FEEDBACK_TASK_LABEL,
    MEM_ORGANIZE_TASK_LABEL,
    MEM_READ_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    PREF_ADD_TASK_LABEL,
    QUERY_TASK_LABEL,
)


class SchedulerHandlerRegistry:
    def __init__(self, ctx: SchedulerHandlerContext) -> None:
        self.query = QueryMessageHandler(ctx)
        self.answer = AnswerMessageHandler(ctx)
        self.add = AddMessageHandler(ctx)
        self.memory_update = MemoryUpdateHandler(ctx)
        self.mem_feedback = FeedbackMessageHandler(ctx)
        self.mem_read = MemReadMessageHandler(ctx)
        self.mem_reorganize = MemReorganizeMessageHandler(ctx)
        self.pref_add = PrefAddMessageHandler(ctx)

    def build_dispatch_map(self) -> dict[str, Callable]:
        return {
            QUERY_TASK_LABEL: self.query.handle,
            ANSWER_TASK_LABEL: self.answer.handle,
            MEM_UPDATE_TASK_LABEL: self.memory_update.handle,
            ADD_TASK_LABEL: self.add.handle,
            MEM_READ_TASK_LABEL: self.mem_read.handle,
            MEM_ORGANIZE_TASK_LABEL: self.mem_reorganize.handle,
            PREF_ADD_TASK_LABEL: self.pref_add.handle,
            MEM_FEEDBACK_TASK_LABEL: self.mem_feedback.handle,
        }
