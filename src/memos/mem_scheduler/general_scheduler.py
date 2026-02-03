from __future__ import annotations

from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.handlers import (
    SchedulerHandlerContext,
    SchedulerHandlerRegistry,
    SchedulerHandlerServices,
)


class GeneralScheduler(BaseScheduler):
    def __init__(self, config: GeneralSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__(config)

        self.query_key_words_limit = self.config.get("query_key_words_limit", 20)

        services = SchedulerHandlerServices(
            validate_messages=self.validate_schedule_messages,
            submit_messages=self.submit_messages,
            create_event_log=self.create_event_log,
            submit_web_logs=self._submit_web_logs,
            map_memcube_name=self._map_memcube_name,
            update_activation_memory_periodically=self.update_activation_memory_periodically,
            replace_working_memory=self.replace_working_memory,
            transform_working_memories_to_monitors=self.transform_working_memories_to_monitors,
            log_working_memory_replacement=self.log_working_memory_replacement,
        )
        ctx = SchedulerHandlerContext(
            get_mem_cube=lambda: self.mem_cube,
            get_monitor=lambda: self.monitor,
            get_retriever=lambda: self.retriever,
            get_mem_reader=lambda: self.mem_reader,
            get_feedback_server=lambda: self.feedback_server,
            get_search_method=lambda: self.search_method,
            get_top_k=lambda: self.top_k,
            get_enable_activation_memory=lambda: self.enable_activation_memory,
            get_query_key_words_limit=lambda: self.query_key_words_limit,
            services=services,
        )

        self._handler_registry = SchedulerHandlerRegistry(ctx)
        self.register_handlers(self._handler_registry.build_dispatch_map())
