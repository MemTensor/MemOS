from __future__ import annotations

import json
import logging

from functools import partial
from typing import Any

from memos.dream.hooks import on_add_signal, on_dream_execute
from memos.dream.pipeline import (
    AbstractDreamPipeline,
    ConsolidationReasoning,
    DirectRecall,
    DreamPersistence,
    MotiveFormation,
    StructuredDiarySummary,
)
from memos.dream.routers.diary_router import create_diary_router
from memos.dream.routers.trigger_router import create_trigger_router
from memos.dream.signal_store import DreamSignalStore
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import MEM_DREAM_TASK_LABEL
from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H


logger = logging.getLogger(__name__)


class CommunityDreamPlugin(MemOSPlugin):
    """Minimal built-in Dream plugin shipped with the core repository.

    The current Dream plugin provides scheduler wiring and replaceable pipeline
    stage boundaries only. Community contributors can implement richer signal
    sources, recall, reasoning, diary persistence, and trigger policies behind
    the same hooks.
    """

    name = "dream"
    version = "0.1.0"
    description = "Built-in Dream plugin"
    priority = 10

    def on_load(self) -> None:
        self.context: dict[str, Any] = {"shared": {}, "configs": {}}
        self.signal_store = DreamSignalStore()
        self.pipeline = AbstractDreamPipeline(
            motive_strategy=MotiveFormation(),
            recall_strategy=DirectRecall(),
            reasoning_strategy=ConsolidationReasoning(),
            diary_strategy=StructuredDiarySummary(),
            persistence_strategy=DreamPersistence(),
        )

        # Hook registration happens at load time because scheduler-triggered Dream
        # execution does not depend on FastAPI route binding.
        self.register_hook(H.DREAM_EXECUTE, partial(on_dream_execute, self))
        self.register_hook(H.ADD_AFTER, partial(on_add_signal, self))
        logger.info("[Dream] plugin loaded")

    def init_components(self, context: dict) -> None:
        # Keep the mutable context reference directly. The server bootstrap updates
        # scheduler handles later, and the plugin should see those changes in-place.
        self.context = context
        self.pipeline.bind_context(context)

    def init_app(self) -> None:
        self.register_router(create_trigger_router(self))
        self.register_router(create_diary_router(self))
        logger.info("[Dream] plugin initialized")

    def on_shutdown(self) -> None:
        self.context = {"shared": {}, "configs": {}}
        logger.info("[Dream] plugin shutdown")

    def submit_dream_task(
        self,
        *,
        mem_cube_id: str,
        user_id: str,
        user_name: str,
        signal_snapshot,
    ) -> bool:
        submit_messages = self.context.get("shared", {}).get("submit_scheduler_messages")
        if submit_messages is None:
            logger.info(
                "[Dream] scheduler submit handle is unavailable; keep framework signal only."
            )
            return False

        message = ScheduleMessageItem(
            user_id=user_id or "",
            mem_cube_id=mem_cube_id,
            label=MEM_DREAM_TASK_LABEL,
            content=json.dumps(signal_snapshot.model_dump(mode="json")),
            user_name=user_name or "",
        )
        submit_messages([message])
        return True
