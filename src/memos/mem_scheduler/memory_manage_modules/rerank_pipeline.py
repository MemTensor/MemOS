from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.utils.filter_utils import (
    filter_too_short_memories,
    filter_vector_based_similar_memories,
    transform_name_to_key,
)
from memos.mem_scheduler.utils.misc_utils import extract_json_obj
from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


class RerankPipeline:
    def __init__(
        self,
        process_llm,
        similarity_threshold: float,
        min_length_threshold: int,
        build_prompt,
    ):
        self.process_llm = process_llm
        self.filter_similarity_threshold = similarity_threshold
        self.filter_min_length_threshold = min_length_threshold
        self.build_prompt = build_prompt

    def rerank_memories(
        self, queries: list[str], original_memories: list[str], top_k: int
    ) -> tuple[list[str], bool]:
        logger.info("Starting memory reranking for %s memories", len(original_memories))

        prompt = self.build_prompt(
            "memory_reranking",
            queries=[f"[0] {queries[0]}"],
            current_order=[f"[{i}] {mem}" for i, mem in enumerate(original_memories)],
        )
        logger.debug("Generated reranking prompt: %s...", prompt[:200])

        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug("Received LLM response: %s...", response[:200])

        try:
            response = extract_json_obj(response)
            new_order = response["new_order"][:top_k]
            text_memories_with_new_order = [original_memories[idx] for idx in new_order]
            logger.info(
                "Successfully reranked memories. Returning top %s items; Ranking reasoning: %s",
                len(text_memories_with_new_order),
                response["reasoning"],
            )
            success_flag = True
        except Exception as e:
            logger.error(
                "Failed to rerank memories with LLM. Exception: %s. Raw response: %s ",
                e,
                response,
                exc_info=True,
            )
            text_memories_with_new_order = original_memories[:top_k]
            success_flag = False
        return text_memories_with_new_order, success_flag

    def process_and_rerank_memories(
        self,
        queries: list[str],
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
        top_k: int = 10,
    ) -> tuple[list[TextualMemoryItem], bool]:
        combined_memory = original_memory + new_memory

        memory_map = {
            transform_name_to_key(name=mem_obj.memory): mem_obj for mem_obj in combined_memory
        }

        combined_text_memory = [m.memory for m in combined_memory]

        filtered_combined_text_memory = filter_vector_based_similar_memories(
            text_memories=combined_text_memory,
            similarity_threshold=self.filter_similarity_threshold,
        )

        filtered_combined_text_memory = filter_too_short_memories(
            text_memories=filtered_combined_text_memory,
            min_length_threshold=self.filter_min_length_threshold,
        )

        unique_memory = list(dict.fromkeys(filtered_combined_text_memory))

        text_memories_with_new_order, success_flag = self.rerank_memories(
            queries=queries,
            original_memories=unique_memory,
            top_k=top_k,
        )

        memories_with_new_order = []
        for text in text_memories_with_new_order:
            normalized_text = transform_name_to_key(name=text)
            if normalized_text in memory_map:
                memories_with_new_order.append(memory_map[normalized_text])
            else:
                logger.warning(
                    "Memory text not found in memory map. text: %s;\nKeys of memory_map: %s",
                    text,
                    memory_map.keys(),
                )

        return memories_with_new_order, success_flag
