from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.memory_manage_modules.enhancement_pipeline import EnhancementPipeline
from memos.mem_scheduler.memory_manage_modules.filter_pipeline import FilterPipeline
from memos.mem_scheduler.memory_manage_modules.rerank_pipeline import RerankPipeline
from memos.mem_scheduler.memory_manage_modules.search_pipeline import SearchPipeline
from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


class SchedulerRetriever(BaseSchedulerModule):
    def __init__(self, process_llm, config):
        super().__init__()

        self.filter_similarity_threshold = 0.75
        self.filter_min_length_threshold = 6
        self.process_llm = process_llm
        self.config = config

        self.search_pipeline = SearchPipeline()
        self.enhancement_pipeline = EnhancementPipeline(
            process_llm=process_llm,
            config=config,
            build_prompt=self.build_prompt,
        )
        self.rerank_pipeline = RerankPipeline(
            process_llm=process_llm,
            similarity_threshold=self.filter_similarity_threshold,
            min_length_threshold=self.filter_min_length_threshold,
            build_prompt=self.build_prompt,
        )
        self.filter_pipeline = FilterPipeline(process_llm=process_llm, config=config)
        self.memory_filter = self.filter_pipeline.memory_filter

    def evaluate_memory_answer_ability(
        self, query: str, memory_texts: list[str], top_k: int | None = None
    ) -> bool:
        return self.enhancement_pipeline.evaluate_memory_answer_ability(
            query=query,
            memory_texts=memory_texts,
            top_k=top_k,
        )

    def search(
        self,
        query: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube,
        top_k: int,
        method: str,
        search_args: dict | None = None,
    ) -> list[TextualMemoryItem]:
        return self.search_pipeline.search(
            query=query,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            top_k=top_k,
            method=method,
            search_args=search_args,
        )

    def enhance_memories_with_query(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.enhancement_pipeline.enhance_memories_with_query(
            query_history=query_history,
            memories=memories,
        )

    def recall_for_missing_memories(self, query: str, memories: list[str]) -> tuple[str, bool]:
        return self.enhancement_pipeline.recall_for_missing_memories(
            query=query,
            memories=memories,
        )

    def rerank_memories(
        self, queries: list[str], original_memories: list[str], top_k: int
    ) -> tuple[list[str], bool]:
        return self.rerank_pipeline.rerank_memories(
            queries=queries,
            original_memories=original_memories,
            top_k=top_k,
        )

    def process_and_rerank_memories(
        self,
        queries: list[str],
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
        top_k: int = 10,
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.rerank_pipeline.process_and_rerank_memories(
            queries=queries,
            original_memory=original_memory,
            new_memory=new_memory,
            top_k=top_k,
        )

    def filter_unrelated_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.filter_pipeline.filter_unrelated_memories(
            query_history=query_history,
            memories=memories,
        )

    def filter_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.filter_pipeline.filter_redundant_memories(
            query_history=query_history,
            memories=memories,
        )

    def filter_unrelated_and_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        return self.filter_pipeline.filter_unrelated_and_redundant_memories(
            query_history=query_history,
            memories=memories,
        )
