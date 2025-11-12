from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.utils.misc_utils import extract_json_obj
from memos.memories.textual.tree import TextualMemoryItem


logger = get_logger(__name__)


class MemoryFilter(BaseSchedulerModule):
    def __init__(self, process_llm: BaseLLM, config: BaseSchedulerConfig):
        super().__init__()
        self.config: BaseSchedulerConfig = config
        self.process_llm = process_llm

    def filter_unrelated_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        """
        Filter out memories that are completely unrelated to the query history using LLM.

        Args:
            query_history: List of query strings to determine relevance
            memories: List of TextualMemoryItem objects to be filtered

        Returns:
            Tuple of (filtered_memories, success_flag)
            - filtered_memories: List of TextualMemoryItem objects that are relevant to queries
            - success_flag: Boolean indicating if LLM filtering was successful

        Note:
            If LLM filtering fails, returns all memories (conservative approach)
        """
        success_flag = False

        if not memories:
            logger.info("No memories to filter - returning empty list")
            return [], True

        if not query_history:
            logger.info("No query history provided - keeping all memories")
            return memories, True

        logger.info(
            f"Starting memory filtering for {len(memories)} memories against {len(query_history)} queries"
        )

        # Extract memory texts for LLM processing
        memory_texts = [mem.memory for mem in memories]

        # Build LLM prompt for memory filtering
        prompt = self.build_prompt(
            "memory_filtering",
            query_history=[f"[{i}] {query}" for i, query in enumerate(query_history)],
            memories=[f"[{i}] {mem}" for i, mem in enumerate(memory_texts)],
        )
        logger.debug(f"Generated filtering prompt: {prompt[:200]}...")  # Log first 200 chars

        # Get LLM response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug(f"Received LLM filtering response: {response[:200]}...")  # Log first 200 chars

        try:
            # Parse JSON response
            response = extract_json_obj(response)
            logger.debug(f"Parsed JSON response: {response}")
            relevant_indices = response["relevant_memories"]
            filtered_count = response["filtered_count"]
            reasoning = response["reasoning"]

            # Validate indices
            if not isinstance(relevant_indices, list):
                raise ValueError("relevant_memories must be a list")

            # Filter memories based on relevant indices
            filtered_memories = []
            for idx in relevant_indices:
                if isinstance(idx, int) and 0 <= idx < len(memories):
                    filtered_memories.append(memories[idx])
                else:
                    logger.warning(f"Invalid memory index {idx} - skipping")

            logger.info(
                f"Successfully filtered memories. Kept {len(filtered_memories)} out of {len(memories)} memories. "
                f"Filtered out {filtered_count} unrelated memories. "
                f"Filtering reasoning: {reasoning}"
            )
            success_flag = True

        except Exception as e:
            logger.error(
                f"Failed to filter memories with LLM. Exception: {e}. Raw response: {response}",
                exc_info=True,
            )
            # Conservative approach: keep all memories if filtering fails
            filtered_memories = memories
            success_flag = False

        return filtered_memories, success_flag

    def filter_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        """
        Filter out redundant memories using LLM analysis.

        This function removes redundant memories by keeping the most informative
        version when multiple memories contain similar information relevant to queries.

        Args:
            query_history: List of query strings to determine relevance and value
            memories: List of TextualMemoryItem objects to be filtered

        Returns:
            Tuple of (filtered_memories, success_flag)
            - filtered_memories: List of TextualMemoryItem objects after redundancy filtering
            - success_flag: Boolean indicating if LLM filtering was successful

        Note:
            If LLM filtering fails, returns all memories (conservative approach)
        """
        success_flag = False

        if not memories:
            logger.info("No memories to filter for redundancy - returning empty list")
            return [], True

        if not query_history:
            logger.info("No query history provided - keeping all memories")
            return memories, True

        if len(memories) <= 1:
            logger.info("Only one memory - no redundancy to filter")
            return memories, True

        logger.info(
            f"Starting redundancy filtering for {len(memories)} memories against {len(query_history)} queries"
        )

        # Extract memory texts for LLM processing
        memory_texts = [mem.memory for mem in memories]

        # Build LLM prompt for redundancy filtering
        prompt = self.build_prompt(
            "memory_redundancy_filtering",
            query_history=[f"[{i}] {query}" for i, query in enumerate(query_history)],
            memories=[f"[{i}] {mem}" for i, mem in enumerate(memory_texts)],
        )
        logger.debug(
            f"Generated redundancy filtering prompt: {prompt[:200]}..."
        )  # Log first 200 chars

        # Get LLM response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug(
            f"Received LLM redundancy filtering response: {response[:200]}..."
        )  # Log first 200 chars

        try:
            # Parse JSON response
            response = extract_json_obj(response)
            logger.debug(f"Parsed JSON response: {response}")
            kept_indices = response["kept_memories"]
            redundant_groups = response.get("redundant_groups", [])
            reasoning = response["reasoning"]

            # Validate indices
            if not isinstance(kept_indices, list):
                raise ValueError("kept_memories must be a list")

            # Filter memories based on kept indices
            filtered_memories = []
            for idx in kept_indices:
                if isinstance(idx, int) and 0 <= idx < len(memories):
                    filtered_memories.append(memories[idx])
                else:
                    logger.warning(f"Invalid memory index {idx} - skipping")

            logger.info(
                f"Successfully filtered redundant memories. "
                f"Kept {len(filtered_memories)} out of {len(memories)} memories. "
                f"Removed {len(memories) - len(filtered_memories)} redundant memories. "
                f"Redundant groups identified: {len(redundant_groups)}. "
                f"Filtering reasoning: {reasoning}"
            )
            success_flag = True

        except Exception as e:
            logger.error(
                f"Failed to filter redundant memories with LLM. Exception: {e}. Raw response: {response}",
                exc_info=True,
            )
            # Conservative approach: keep all memories if filtering fails
            filtered_memories = memories
            success_flag = False

        return filtered_memories, success_flag

    def filter_unrelated_and_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        """
        Filter out both unrelated and redundant memories using LLM analysis.

        This function performs two types of filtering in sequence:
        1. Remove memories that are completely unrelated to the query history
        2. Remove redundant memories by keeping the most informative version

        Args:
            query_history: List of query strings to determine relevance and value
            memories: List of TextualMemoryItem objects to be filtered

        Returns:
            Tuple of (filtered_memories, success_flag)
            - filtered_memories: List of TextualMemoryItem objects after both filtering steps
            - success_flag: Boolean indicating if LLM filtering was successful

        Note:
            If LLM filtering fails, returns all memories (conservative approach)
        """
        if not memories:
            logger.info("No memories to filter for unrelated and redundant - returning empty list")
            return [], True

        if not query_history:
            logger.info("No query history provided - keeping all memories")
            return memories, True

        if len(memories) <= 1:
            logger.info("Only one memory - no filtering needed")
            return memories, True

        logger.info(
            f"Starting combined unrelated and redundant filtering for {len(memories)} memories against {len(query_history)} queries"
        )

        # Extract memory texts for LLM processing
        memory_texts = [mem.memory for mem in memories]

        # Build LLM prompt for combined filtering
        prompt = self.build_prompt(
            "memory_combined_filtering",
            query_history=[f"[{i}] {query}" for i, query in enumerate(query_history)],
            memories=[f"[{i}] {mem}" for i, mem in enumerate(memory_texts)],
        )
        logger.debug(
            f"Generated combined filtering prompt: {prompt[:200]}..."
        )  # Log first 200 chars

        # Get LLM response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug(
            f"Received LLM combined filtering response: {response[:200]}..."
        )  # Log first 200 chars

        try:
            # Parse JSON response
            response = extract_json_obj(response)
            logger.debug(f"Parsed JSON response: {response}")
            kept_indices = response["kept_memories"]
            unrelated_removed_count = response.get("unrelated_removed_count", 0)
            redundant_removed_count = response.get("redundant_removed_count", 0)
            redundant_groups = response.get("redundant_groups", [])
            reasoning = response["reasoning"]

            # Validate indices
            if not isinstance(kept_indices, list):
                raise ValueError("kept_memories must be a list")

            # Filter memories based on kept indices
            filtered_memories = []
            for idx in kept_indices:
                if isinstance(idx, int) and 0 <= idx < len(memories):
                    filtered_memories.append(memories[idx])
                else:
                    logger.warning(f"Invalid memory index {idx} - skipping")

            logger.info(
                f"Successfully filtered unrelated and redundant memories. "
                f"Kept {len(filtered_memories)} out of {len(memories)} memories. "
                f"Removed {len(memories) - len(filtered_memories)} memories total. "
                f"Unrelated removed: {unrelated_removed_count}. "
                f"Redundant removed: {redundant_removed_count}. "
                f"Redundant groups identified: {len(redundant_groups)}. "
                f"Filtering reasoning: {reasoning}"
            )
            success_flag = True

        except Exception as e:
            logger.error(
                f"Failed to filter unrelated and redundant memories with LLM. Exception: {e}. Raw response: {response}",
                exc_info=True,
            )
            # Conservative approach: keep all memories if filtering fails
            filtered_memories = memories
            success_flag = False

        return filtered_memories, success_flag
