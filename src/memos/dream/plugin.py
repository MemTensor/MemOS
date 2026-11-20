from __future__ import annotations

import json
import logging

from functools import partial
from typing import Any

from memos.dream.contextualization import DreamContextualizer
from memos.dream.enrichment import (
    DreamHeuristicEnricher,
    on_memory_items_after_fine_extract,
)
from memos.dream.hooks import on_add_signal, on_dream_execute
from memos.dream.lifecycle.contracts import LifecycleError
from memos.dream.lifecycle.runtime import DreamLifecycleRuntime, LifecycleRuntimeConfig
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
from memos.dream.search import DreamContextSearchExtension
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
    enabled_by_default = False

    def on_load(self) -> None:
        if getattr(self, "_loaded", False):
            return
        self._loaded = True
        self._owned_hooks = []
        self.lifecycle: DreamLifecycleRuntime | None = None
        self.context: dict[str, Any] = {"shared": {}, "configs": {}}
        self.signal_store = DreamSignalStore()
        self.heuristic_enricher = DreamHeuristicEnricher()
        self.search_extension = DreamContextSearchExtension()
        self.pipeline = AbstractDreamPipeline(
            context_strategy=DreamContextualizer(),
            motive_strategy=MotiveFormation(),
            recall_strategy=DirectRecall(),
            reasoning_strategy=ConsolidationReasoning(),
            diary_strategy=StructuredDiarySummary(),
            persistence_strategy=DreamPersistence(),
        )

        # Hook registration happens at load time because scheduler-triggered Dream
        # execution does not depend on FastAPI route binding.
        self._register_owned_hook(H.DREAM_EXECUTE, partial(on_dream_execute, self))
        self._register_owned_hook(
            H.SEARCH_MEMORY_RESULTS, self.search_extension.merge_context_recall
        )
        self._register_owned_hook(H.ADD_AFTER, partial(on_add_signal, self))
        self._register_owned_hook(
            H.MEMORY_ITEMS_AFTER_FINE_EXTRACT,
            partial(on_memory_items_after_fine_extract, self),
        )
        logger.info("[Dream] plugin loaded")

    def _register_owned_hook(self, name, callback) -> None:
        self.register_hook(name, callback)
        self._owned_hooks.append((name, callback))

    def init_components(self, context: dict) -> None:
        # Keep the mutable context reference directly. The server bootstrap updates
        # scheduler handles later, and the plugin should see those changes in-place.
        if self.lifecycle is not None:
            if context is self.context:
                return
            raise LifecycleError(
                "Shutdown the active lifecycle runtime before rebinding components"
            )
        config = LifecycleRuntimeConfig.model_validate(
            context.get("configs", {}).get("dream_lifecycle") or {}
        )
        runtime = None
        shared = context.get("shared", {})
        if config.enabled:
            if shared.get("dream_lifecycle") is not None:
                raise LifecycleError("A Dream lifecycle service is already registered")
            graph = shared.get("graph_db")
            if graph is None:
                raise LifecycleError("Dream lifecycle requires a shared graph backend")
            runtime = DreamLifecycleRuntime(graph, config)
        self.context = context
        self.pipeline.bind_context(context)
        if runtime is not None:
            self.lifecycle = runtime
            shared["dream_lifecycle"] = runtime.service
            self._register_owned_hook(H.SEARCH_COMPLETED, runtime.observer.on_search_completed)
            self._register_owned_hook(
                H.MEMORY_FEEDBACK_COMMITTED, runtime.observer.on_feedback_committed
            )
            runtime.start()

    def init_app(self) -> None:
        self.register_router(create_trigger_router(self))
        self.register_router(create_diary_router(self))
        logger.info("[Dream] plugin initialized")

    def on_shutdown(self) -> None:
        from memos.plugins.hooks import unregister_hook

        for name, callback in self._owned_hooks:
            unregister_hook(name, callback)
        self._owned_hooks.clear()
        if self.lifecycle is not None:
            if not self.lifecycle.shutdown():
                raise LifecycleError(
                    "Dream maintenance is still stopping; retain its runtime until complete"
                )
            shared = self.context.get("shared", {})
            if shared.get("dream_lifecycle") is self.lifecycle.service:
                shared.pop("dream_lifecycle")
            self.lifecycle = None
        self._loaded = False
        self.context = {"shared": {}, "configs": {}}
        self.heuristic_enricher = None
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
