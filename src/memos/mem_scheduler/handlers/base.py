from __future__ import annotations

from memos.mem_scheduler.handlers.context import SchedulerHandlerContext


class BaseSchedulerHandler:
    def __init__(self, ctx: SchedulerHandlerContext) -> None:
        self.ctx = ctx
