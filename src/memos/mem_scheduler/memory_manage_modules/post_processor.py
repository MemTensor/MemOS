"""
Memory Post-Processor - Handles post-retrieval memory filtering and reranking.

This module provides post-processing operations for retrieved memories,
including filtering and reranking operations specific to the scheduler's needs.

Note: Memory enhancement operations (enhance_memories_with_query, recall_for_missing_memories)
have been moved to AdvancedSearcher for better architectural separation.
"""

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE,
    DEFAULT_SCHEDULER_RETRIEVER_RETRIES,
)
from memos.mem_scheduler.utils.filter_utils import (
    filter_too_short_memories,
    filter_vector_based_similar_memories,
    transform_name_to_key,
)
from memos.memories.textual.item import TextualMemoryItem
from memos.mem_scheduler.utils.misc_utils import extract_json_obj

from .memory_filter import MemoryFilter


logger = get_logger(__name__)


class MemoryPostProcessor(BaseSchedulerModule):
    """
    Post-processor for retrieved memories.

    This class handles scheduler-specific post-retrieval operations:
    - Memory filtering: Remove unrelated or redundant memories
    - Memory reranking: Reorder memories by relevance
    - Memory evaluation: Assess memory's ability to answer queries

    Design principles:
    - Single Responsibility: Only handles filtering/reranking, not enhancement or retrieval
    - Composable: Can be used independently or chained together
    - Testable: Each operation can be tested in isolation

    Note: Memory enhancement operations have been moved to AdvancedSearcher.

    Usage:
        processor = MemoryPostProcessor(process_llm=llm, config=config)

        # Filter out unrelated memories
        filtered, _ = processor.filter_unrelated_memories(
            query_history=["What is Python?"],
            memories=raw_memories
        )

        # Rerank memories by relevance
        reranked, _ = processor.process_and_rerank_memories(
            queries=["What is Python?"],
            original_memory=filtered,
            new_memory=[],
            top_k=10
        )
    """

    def __init__(self, process_llm: BaseLLM, config: BaseSchedulerConfig):
        """
        Initialize the post-processor.

        Args:
            process_llm: LLM instance for enhancement and filtering operations
            config: Scheduler configuration containing batch sizes and retry settings
        """
        super().__init__()

        # Core dependencies
        self.process_llm = process_llm
        self.config = config
        self.memory_filter = MemoryFilter(process_llm=process_llm, config=config)

        # Configuration
        self.filter_similarity_threshold = 0.75
        self.filter_min_length_threshold = 6

        # NOTE: Config keys still use "scheduler_retriever_*" prefix for backward compatibility
        # TODO: Consider renaming to "post_processor_*" in future config refactor
        self.batch_size: int | None = getattr(
            config, "scheduler_retriever_batch_size", DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE
        )
        self.retries: int = getattr(
            config, "scheduler_retriever_enhance_retries", DEFAULT_SCHEDULER_RETRIEVER_RETRIES
        )

    def evaluate_memory_answer_ability(
        self, query: str, memory_texts: list[str], top_k: int | None = None
    ) -> bool:
        """
        Evaluate whether the given memories can answer the query.

        This method uses LLM to assess if the provided memories contain
        sufficient information to answer the given query.

        Args:
            query: The query to be answered
            memory_texts: List of memory text strings
            top_k: Optional limit on number of memories to consider

        Returns:
            Boolean indicating whether memories can answer the query
        """
        limited_memories = memory_texts[:top_k] if top_k is not None else memory_texts

        # Build prompt using the template
        prompt = self.build_prompt(
            template_name="memory_answer_ability_evaluation",
            query=query,
            memory_list="\n".join([f"- {memory}" for memory in limited_memories])
            if limited_memories
            else "No memories available",
        )

        # Use the process LLM to generate response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])

        try:
            result = extract_json_obj(response)

            # Validate response structure
            if "result" in result:
                logger.info(
                    f"[Answerability] result={result['result']}; "
                    f"reason={result.get('reason', 'n/a')}; "
                    f"evaluated={len(limited_memories)}"
                )
                return result["result"]
            else:
                logger.warning(f"[Answerability] invalid LLM JSON structure; payload={result}")
                return False

        except Exception as e:
            logger.error(f"[Answerability] parse failed; err={e}; raw={str(response)[:200]}...")
            return False

    def rerank_memories(
        self, queries: list[str], original_memories: list[str], top_k: int
    ) -> tuple[list[str], bool]:
        """
        Rerank memories based on relevance to given queries using LLM.

        Args:
            queries: List of query strings to determine relevance
            original_memories: List of memory strings to be reranked
            top_k: Number of top memories to return after reranking

        Returns:
            Tuple of (reranked_memories, success_flag)
            - reranked_memories: List of reranked memory strings (length <= top_k)
            - success_flag: True if reranking succeeded

        Note:
            If LLM reranking fails, falls back to original order (truncated to top_k)
        """
        logger.info(f"Starting memory reranking for {len(original_memories)} memories")

        # Build LLM prompt for memory reranking
        prompt = self.build_prompt(
            "memory_reranking",
            queries=[f"[0] {queries[0]}"],
            current_order=[f"[{i}] {mem}" for i, mem in enumerate(original_memories)],
        )
        logger.debug(f"Generated reranking prompt: {prompt[:200]}...")

        # Get LLM response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug(f"Received LLM response: {response[:200]}...")

        try:
            # Parse JSON response
            response = extract_json_obj(response)
            new_order = response["new_order"][:top_k]
            text_memories_with_new_order = [original_memories[idx] for idx in new_order]
            logger.info(
                f"Successfully reranked memories. Returning top {len(text_memories_with_new_order)} items; "
                f"Ranking reasoning: {response['reasoning']}"
            )
            success_flag = True
        except Exception as e:
            logger.error(
                f"Failed to rerank memories with LLM. Exception: {e}. Raw response: {response} ",
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
        """
        Process and rerank memory items by combining, filtering, and reranking.

        This is a higher-level method that combines multiple post-processing steps:
        1. Merge original and new memories
        2. Apply similarity filtering
        3. Apply length filtering
        4. Remove duplicates
        5. Rerank by relevance

        Args:
            queries: List of query strings to rerank memories against
            original_memory: List of original TextualMemoryItem objects
            new_memory: List of new TextualMemoryItem objects to merge
            top_k: Maximum number of memories to return after reranking

        Returns:
            Tuple of (reranked_memories, success_flag)
            - reranked_memories: List of reranked TextualMemoryItem objects
            - success_flag: True if reranking succeeded
        """
        # Combine original and new memories
        combined_memory = original_memory + new_memory

        # Create mapping from normalized text to memory objects
        memory_map = {
            transform_name_to_key(name=mem_obj.memory): mem_obj for mem_obj in combined_memory
        }

        # Extract text representations
        combined_text_memory = [m.memory for m in combined_memory]

        # Apply similarity filter
        filtered_combined_text_memory = filter_vector_based_similar_memories(
            text_memories=combined_text_memory,
            similarity_threshold=self.filter_similarity_threshold,
        )

        # Apply length filter
        filtered_combined_text_memory = filter_too_short_memories(
            text_memories=filtered_combined_text_memory,
            min_length_threshold=self.filter_min_length_threshold,
        )

        # Remove duplicates (preserving order)
        unique_memory = list(dict.fromkeys(filtered_combined_text_memory))

        # Rerank memories
        text_memories_with_new_order, success_flag = self.rerank_memories(
            queries=queries,
            original_memories=unique_memory,
            top_k=top_k,
        )

        # Map reranked texts back to memory objects
        memories_with_new_order = []
        for text in text_memories_with_new_order:
            normalized_text = transform_name_to_key(name=text)
            if normalized_text in memory_map:
                memories_with_new_order.append(memory_map[normalized_text])
            else:
                logger.warning(
                    f"Memory text not found in memory map. text: {text};\n"
                    f"Keys of memory_map: {memory_map.keys()}"
                )

        return memories_with_new_order, success_flag

    def filter_unrelated_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        """
        Filter out memories unrelated to the query history.

        Delegates to MemoryFilter for the actual filtering logic.
        """
        return self.memory_filter.filter_unrelated_memories(query_history, memories)

    def filter_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        """
        Filter out redundant memories from the list.

        Delegates to MemoryFilter for the actual filtering logic.
        """
        return self.memory_filter.filter_redundant_memories(query_history, memories)

    def filter_unrelated_and_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        """
        Filter out both unrelated and redundant memories using LLM analysis.

        Delegates to MemoryFilter for the actual filtering logic.
        """
        return self.memory_filter.filter_unrelated_and_redundant_memories(query_history, memories)
