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
    def __init__(self, scheduler_context: SchedulerHandlerContext) -> None:
        self.query = QueryMessageHandler(scheduler_context)
        self.answer = AnswerMessageHandler(scheduler_context)
        self.add = AddMessageHandler(scheduler_context)
        self.memory_update = MemoryUpdateHandler(scheduler_context)
        self.mem_feedback = FeedbackMessageHandler(scheduler_context)
        self.mem_read = MemReadMessageHandler(scheduler_context)
        self.mem_reorganize = MemReorganizeMessageHandler(scheduler_context)
        self.pref_add = PrefAddMessageHandler(scheduler_context)

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
