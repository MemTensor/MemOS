from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

from memos_smartcomment.adapter import AsyncTraceAdapter
from memos_smartcomment.config import SmartCommentSettings
from memos_smartcomment.handlers import HookHandlers


# isort: split
from memos.log import get_logger
from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H


if TYPE_CHECKING:
    from fastapi import FastAPI


logger = get_logger(__name__)
AdapterFactory = Callable[[SmartCommentSettings], AsyncTraceAdapter]


class SmartCommentPlugin(MemOSPlugin):
    """Trace existing MemOS semantic Hooks without changing business results."""

    name = "smartcomment"
    version = "0.1.0"
    description = "Trace MemOS memory flows with smartcomment"
    # Opt in with MEMOS_ENABLED_PLUGINS=smartcomment; installation alone does not enable it.
    enabled_by_default = False

    def __init__(self, adapter_factory: AdapterFactory | None = None) -> None:
        self._adapter_factory = adapter_factory or AsyncTraceAdapter
        self.adapter: AsyncTraceAdapter | None = None
        self.handlers: HookHandlers | None = None
        self.context: dict[str, Any] = {"shared": {}, "configs": {}}

    def on_load(self) -> None:
        settings = SmartCommentSettings.from_env()
        self.adapter = self._adapter_factory(settings)
        self.handlers = HookHandlers(
            self.adapter.submit,
            max_value_chars=settings.max_value_chars,
            defer_search=self.adapter.submit,
        )
        # start the adapter, which will begin processing trace events asynchronously.
        self.adapter.start()

        for hook, callback in (
            (H.ADD_BEFORE, self.handlers.on_add_before),
            (H.ADD_AFTER, self.handlers.on_add_after),
            (H.MEM_READER_EXTRACT_AFTER, self.handlers.on_mem_reader_extract_after),
            (H.MEM_READER_EXTRACT_FAILED, self.handlers.on_mem_reader_extract_failed),
            (H.TEXT_MEMORY_ADD_AFTER, self.handlers.on_text_memory_add_after),
            (H.TEXT_MEMORY_ADD_FAILED, self.handlers.on_text_memory_add_failed),
            (H.SCHEDULER_MEMORY_OPERATION_AFTER, self.handlers.on_scheduler_memory_operation_after),
            (
                H.SCHEDULER_MEMORY_OPERATION_FAILED,
                self.handlers.on_scheduler_memory_operation_failed,
            ),
            (H.SEARCH_BEFORE, self.handlers.on_search_before),
            (H.SEARCH_MEMORY_RESULTS, self.handlers.on_search_memory_results),
            (H.SEARCH_RESULTS_AFTER_THRESHOLD, self.handlers.on_search_results_after_threshold),
            (H.SEARCH_RESULTS_AFTER_DEDUP, self.handlers.on_search_results_after_dedup),
            (H.SEARCH_RESULTS_AFTER_RERANK, self.handlers.on_search_results_after_rerank),
            (H.SEARCH_POST_PROCESS_FAILED, self.handlers.on_search_post_process_failed),
        ):
            self.register_hook(hook, callback)
        logger.info(
            "smartcomment plugin loaded; output_dir=%s queue_size=%d link_search_to_add=%s",
            settings.output_dir,
            settings.queue_size,
            settings.link_search_to_add,
        )

    def init_components(self, context: dict[str, Any]) -> None:
        self.context = context

    def init_app(self) -> None:
        original_lifespan = self._app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(app: FastAPI) -> AsyncIterator[Mapping[str, Any] | None]:
            try:
                async with original_lifespan(app) as state:
                    yield state
            finally:
                # Components may still emit events while shutting down.
                self.on_shutdown()

        self._app.router.lifespan_context = lifespan

    def on_shutdown(self) -> None:
        if self.handlers is not None:
            self.handlers.clear()
        if self.adapter is not None:
            self.adapter.close()
            stats = getattr(self.adapter, "stats", None)
            if stats is not None:
                logger.info(
                    "smartcomment plugin stopped; accepted=%d processed=%d dropped=%d "
                    "failed=%d write_failures=%d",
                    stats.accepted,
                    stats.processed,
                    stats.dropped,
                    stats.failed,
                    stats.write_failures,
                )
        self.context = {"shared": {}, "configs": {}}
