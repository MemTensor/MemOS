from __future__ import annotations

from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from memos.mem_scheduler.handlers.context import SchedulerHandlerContext


class BaseSchedulerHandler:
    def __init__(self, ctx: SchedulerHandlerContext) -> None:
        self.ctx = ctx
