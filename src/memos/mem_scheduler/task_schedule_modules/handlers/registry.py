from __future__ import annotations

from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from collections.abc import Callable

    from .context import SchedulerHandlerContext

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

from .add_handler import AddMessageHandler
from .answer_handler import AnswerMessageHandler
from .feedback_handler import FeedbackMessageHandler
from .mem_read_handler import MemReadMessageHandler
from .mem_reorganize_handler import MemReorganizeMessageHandler
from .memory_update_handler import MemoryUpdateHandler
from .pref_add_handler import PrefAddMessageHandler
from .query_handler import QueryMessageHandler


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
            QUERY_TASK_LABEL: self.query,
            ANSWER_TASK_LABEL: self.answer,
            MEM_UPDATE_TASK_LABEL: self.memory_update,
            ADD_TASK_LABEL: self.add,
            MEM_READ_TASK_LABEL: self.mem_read,
            MEM_ORGANIZE_TASK_LABEL: self.mem_reorganize,
            PREF_ADD_TASK_LABEL: self.pref_add,
            MEM_FEEDBACK_TASK_LABEL: self.mem_feedback,
        }
