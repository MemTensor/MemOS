from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.schemas.general_schemas import (
    TreeTextMemory_FINE_SEARCH_METHOD,
    TreeTextMemory_SEARCH_METHOD,
)
from memos.mem_scheduler.utils.filter_utils import (
    filter_too_short_memories,
    filter_vector_based_similar_memories,
    transform_name_to_key,
)
from memos.mem_scheduler.utils.misc_utils import (
    extract_json_dict,
)
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory

from .memory_filter import MemoryFilter


logger = get_logger(__name__)


class SchedulerRetriever(BaseSchedulerModule):
    def __init__(self, process_llm: BaseLLM, config: BaseSchedulerConfig):
        super().__init__()

        # hyper-parameters
        self.filter_similarity_threshold = 0.75
        self.filter_min_length_threshold = 6

        self.config: BaseSchedulerConfig = config
        self.process_llm = process_llm

        # Initialize memory filter
        self.memory_filter = MemoryFilter(process_llm=process_llm, config=config)

    def search(
        self,
        query: str,
        mem_cube: GeneralMemCube,
        top_k: int,
        method: str = TreeTextMemory_SEARCH_METHOD,
        info: dict | None = None,
    ) -> list[TextualMemoryItem]:
        """Search in text memory with the given query.

        Args:
            query: The search query string
            top_k: Number of top results to return
            method: Search method to use

        Returns:
            Search results or None if not implemented
        """
        text_mem_base = mem_cube.text_mem
        try:
            if method in [TreeTextMemory_SEARCH_METHOD, TreeTextMemory_FINE_SEARCH_METHOD]:
                assert isinstance(text_mem_base, TreeTextMemory)
                if info is None:
                    logger.warning(
                        "Please input 'info' when use tree.search so that "
                        "the database would store the consume history."
                    )
                    info = {"user_id": "", "session_id": ""}

                mode = "fast" if method == TreeTextMemory_SEARCH_METHOD else "fine"
                results_long_term = text_mem_base.search(
                    query=query, top_k=top_k, memory_type="LongTermMemory", mode=mode, info=info
                )
                results_user = text_mem_base.search(
                    query=query, top_k=top_k, memory_type="UserMemory", mode=mode, info=info
                )
                results = results_long_term + results_user
            else:
                raise NotImplementedError(str(type(text_mem_base)))
        except Exception as e:
            logger.error(f"Fail to search. The exeption is {e}.", exc_info=True)
            results = []
        return results

    def rerank_memories(
        self, queries: list[str], original_memories: list[str], top_k: int
    ) -> (list[str], bool):
        """
        Rerank memories based on relevance to given queries using LLM.

        Args:
            queries: List of query strings to determine relevance
            original_memories: List of memory strings to be reranked
            top_k: Number of top memories to return after reranking

        Returns:
            List of reranked memory strings (length <= top_k)

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
        logger.debug(f"Generated reranking prompt: {prompt[:200]}...")  # Log first 200 chars

        # Get LLM response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug(f"Received LLM response: {response[:200]}...")  # Log first 200 chars

        try:
            # Parse JSON response
            response = extract_json_dict(response)
            new_order = response["new_order"][:top_k]
            text_memories_with_new_order = [original_memories[idx] for idx in new_order]
            logger.info(
                f"Successfully reranked memories. Returning top {len(text_memories_with_new_order)} items;"
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
    ) -> list[TextualMemoryItem] | None:
        """
        Process and rerank memory items by combining original and new memories,
        applying filters, and then reranking based on relevance to queries.

        Args:
            queries: List of query strings to rerank memories against
            original_memory: List of original TextualMemoryItem objects
            new_memory: List of new TextualMemoryItem objects to merge
            top_k: Maximum number of memories to return after reranking

        Returns:
            List of reranked TextualMemoryItem objects, or None if processing fails
        """
        # Combine original and new memories into a single list
        combined_memory = original_memory + new_memory

        # Create a mapping from normalized text to memory objects
        memory_map = {
            transform_name_to_key(name=mem_obj.memory): mem_obj for mem_obj in combined_memory
        }

        # Extract normalized text representations from all memory items
        combined_text_memory = [m.memory for m in combined_memory]

        # Apply similarity filter to remove overly similar memories
        filtered_combined_text_memory = filter_vector_based_similar_memories(
            text_memories=combined_text_memory,
            similarity_threshold=self.filter_similarity_threshold,
        )

        # Apply length filter to remove memories that are too short
        filtered_combined_text_memory = filter_too_short_memories(
            text_memories=filtered_combined_text_memory,
            min_length_threshold=self.filter_min_length_threshold,
        )

        # Ensure uniqueness of memory texts using dictionary keys (preserves order)
        unique_memory = list(dict.fromkeys(filtered_combined_text_memory))

        # Rerank the filtered memories based on relevance to the queries
        text_memories_with_new_order, success_flag = self.rerank_memories(
            queries=queries,
            original_memories=unique_memory,
            top_k=top_k,
        )

        # Map reranked text entries back to their original memory objects
        memories_with_new_order = []
        for text in text_memories_with_new_order:
            normalized_text = transform_name_to_key(name=text)
            if normalized_text in memory_map:  # Ensure correct key matching
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
    ) -> (list[TextualMemoryItem], bool):
        return self.memory_filter.filter_unrelated_memories(query_history, memories)

    def filter_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        return self.memory_filter.filter_redundant_memories(query_history, memories)

    def filter_unrelated_and_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        """
        Filter out both unrelated and redundant memories using LLM analysis.

        This method delegates to the MemoryFilter class.
        """
        return self.memory_filter.filter_unrelated_and_redundant_memories(query_history, memories)
