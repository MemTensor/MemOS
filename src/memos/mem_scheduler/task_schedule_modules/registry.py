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
    TaskPriorityLevel,
)

from .handlers.add_handler import AddMessageHandler
from .handlers.answer_handler import AnswerMessageHandler
from .handlers.feedback_handler import FeedbackMessageHandler
from .handlers.mem_read_handler import MemReadMessageHandler
from .handlers.mem_reorganize_handler import MemReorganizeMessageHandler
from .handlers.memory_update_handler import MemoryUpdateHandler
from .handlers.pref_add_handler import PrefAddMessageHandler
from .handlers.query_handler import QueryMessageHandler


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
        predefined_handlers = {
            QUERY_TASK_LABEL: (self.query, TaskPriorityLevel.LEVEL_1, None),
            ANSWER_TASK_LABEL: (self.answer, TaskPriorityLevel.LEVEL_1, None),
            MEM_UPDATE_TASK_LABEL: self.memory_update,
            ADD_TASK_LABEL: (self.add, TaskPriorityLevel.LEVEL_1, None),
            MEM_READ_TASK_LABEL: self.mem_read,
            MEM_ORGANIZE_TASK_LABEL: self.mem_reorganize,
            PREF_ADD_TASK_LABEL: (self.pref_add, None, 600_000),
            MEM_FEEDBACK_TASK_LABEL: self.mem_feedback,
        }
        return predefined_handlers
