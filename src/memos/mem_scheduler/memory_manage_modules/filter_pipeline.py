from __future__ import annotations

from memos.mem_scheduler.memory_manage_modules.memory_filter import MemoryFilter
from memos.memories.textual.tree import TextualMemoryItem


class FilterPipeline:
    def __init__(self, process_llm, config):
        self.memory_filter = MemoryFilter(process_llm=process_llm, config=config)

    def filter_unrelated_memories(
        self, query_history: list[str], memories: list[TextualMemoryItem]
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.memory_filter.filter_unrelated_memories(query_history, memories)

    def filter_redundant_memories(
        self, query_history: list[str], memories: list[TextualMemoryItem]
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.memory_filter.filter_redundant_memories(query_history, memories)

    def filter_unrelated_and_redundant_memories(
        self, query_history: list[str], memories: list[TextualMemoryItem]
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.memory_filter.filter_unrelated_and_redundant_memories(query_history, memories)
