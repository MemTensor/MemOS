from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable

    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorItem
    from memos.memories.textual.item import TextualMemoryItem


@dataclass(frozen=True)
class SchedulerHandlerServices:
    validate_messages: Callable[[list[ScheduleMessageItem], str], None]
    submit_messages: Callable[[list[ScheduleMessageItem]], None]
    create_event_log: Callable[..., Any]
    submit_web_logs: Callable[..., None]
    map_memcube_name: Callable[[str], str]
    update_activation_memory_periodically: Callable[..., None]
    replace_working_memory: Callable[
        [str, str, Any, list[TextualMemoryItem], list[TextualMemoryItem]],
        list[TextualMemoryItem] | None,
    ]
    transform_working_memories_to_monitors: Callable[..., list[MemoryMonitorItem]]
    log_working_memory_replacement: Callable[..., None]


@dataclass(frozen=True)
class SchedulerHandlerContext:
    get_mem_cube: Callable[[], Any]
    get_monitor: Callable[[], Any]
    get_retriever: Callable[[], Any]
    get_mem_reader: Callable[[], Any]
    get_feedback_server: Callable[[], Any]
    get_search_method: Callable[[], str]
    get_top_k: Callable[[], int]
    get_enable_activation_memory: Callable[[], bool]
    get_query_key_words_limit: Callable[[], int]
    services: SchedulerHandlerServices
