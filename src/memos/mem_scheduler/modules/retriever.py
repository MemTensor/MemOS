import json
import logging
from typing import Any, List, Dict
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from click import style
from memos.mem_scheduler.modules.misc import AutoDroppingQueue as Queue
from memos.log import get_logger
from memos.llms.base import BaseLLM
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.base import BaseSchedulerModule
from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.mem_scheduler.utils import extract_json_dict
from memos.memories.textual.tree import TreeTextMemory
from memos.mem_scheduler.utils import normalize_name
from memos.mem_scheduler.modules.schemas import (
    MemoryMonitorManager,
    UserID,
    MemCubeID,
    USER_MEMORY_TYPE,
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_THREAD__POOL_MAX_WORKERS,
    QUERY_LABEL,
    ANSWER_LABEL,
    ACTIVATION_MEMORY_TYPE,
    LONG_TERM_MEMORY_TYPE,
    WORKING_MEMORY_TYPE,
    DEFAULT_ACT_MEM_DUMP_PATH,
    NOT_INITIALIZED,
    ScheduleLogForWebItem,
    ScheduleMessageItem,
    TextMemory_SEARCH_METHOD,
    TreeTextMemory_SEARCH_METHOD,
)

logger = get_logger(__name__)



class SchedulerRetriever(BaseSchedulerModule):
    def __init__(self, process_llm: BaseLLM,
                 config: BaseSchedulerConfig):
        super().__init__()

        self.config: BaseSchedulerConfig = config
        self.process_llm = process_llm

        # hyper-parameters
        self.filter_similarity_threshold = 0.75
        self.filter_min_length_threshold = 5

        # log function callbacks
        self.log_working_memory_replacement = None


    def search(self, query: str,
               mem_cube: GeneralMemCube,
               top_k: int,
               method=TreeTextMemory_SEARCH_METHOD):
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
            if method == TreeTextMemory_SEARCH_METHOD:
                assert isinstance(text_mem_base, TreeTextMemory)
                results_long_term = text_mem_base.search(
                    query=query,
                    top_k=top_k,
                    memory_type="LongTermMemory"
                )
                results_user = text_mem_base.search(query=query,
                                                    top_k=top_k,
                                                    memory_type="UserMemory")
                results = results_long_term + results_user
            else:
                raise NotImplementedError(str(type(text_mem_base)))
        except Exception as e:
            logger.error(f"Fail to search. The exeption is {e}.")
            results = []
        return results

    def filter_similar_memories(
            self,
            text_memories: List[str],
            similarity_threshold: float = 0.75
        ) -> List[str]:
        """
        Filters out low-quality or duplicate memories based on text similarity.

        Args:
            text_memories: List of text memories to filter
            similarity_threshold: Threshold for considering memories duplicates (0.0-1.0)
                                Higher values mean stricter filtering

        Returns:
            List of filtered memories with duplicates removed
        """
        if not text_memories:
            logging.warning("Received empty memories list - nothing to filter")
            return []

        try:
            # Step 1: Vectorize texts using TF-IDF
            vectorizer = TfidfVectorizer()
            tfidf_matrix = vectorizer.fit_transform(text_memories)

            # Step 2: Calculate pairwise similarity matrix
            similarity_matrix = cosine_similarity(tfidf_matrix)

            # Step 3: Identify duplicates
            to_keep = []
            removal_reasons = {}

            for current_idx in range(len(text_memories)):
                is_duplicate = False

                # Compare with already kept memories
                for kept_idx in to_keep:
                    similarity_score = similarity_matrix[current_idx, kept_idx]

                    if similarity_score > similarity_threshold:
                        is_duplicate = True
                        # Generate removal reason with sample text
                        removal_reasons[current_idx] = (
                            f"Memory too similar (score: {similarity_score:.2f}) to kept memory #{kept_idx}. "
                            f"Kept: '{text_memories[kept_idx][:100]}...' | "
                            f"Removed: '{text_memories[current_idx][:100]}...'"
                        )
                        logger.info(removal_reasons)
                        break

                if not is_duplicate:
                    to_keep.append(current_idx)

            # Return filtered memories
            return [text_memories[i] for i in sorted(to_keep)]

        except Exception as e:
            logging.error(f"Error filtering memories: {str(e)}")
            return text_memories  # Return original list if error occurs

    def filter_too_short_memories(self, text_memories: List[str],
                                  min_length_threshold: int = 20) -> List[str]:
        """
        Filters out memories that are too short to be meaningful.

        Args:
            text_memories: List of text memories to filter
            min_length: Minimum character length required to keep a memory

        Returns:
            List of memories with short entries removed
        """
        if not text_memories:
            logging.debug("Received empty memories list in short memory filter")
            return []

        filtered_memories = []
        removal_indices = []

        for idx, memory in enumerate(text_memories):
            if len(memory.strip().split()) >= min_length_threshold:
                filtered_memories.append(memory)
            else:
                removal_indices.append(idx)

        if removal_indices:
            logging.info(
                f"Removed {len(removal_indices)} short memories "
                f"(shorter than {min_length_threshold} characters). "
                f"Sample removed: {text_memories[removal_indices[0]][:50]}..."
            )

        return filtered_memories


    def replace_working_memory(
            self,
            queries: List[str],
            user_id: str,
            mem_cube_id: str,
            mem_cube: GeneralMemCube,
            original_memory: List[TextualMemoryItem],
            new_memory: List[TextualMemoryItem],
            top_k: int = 10,
    ) -> None | list[TextualMemoryItem]:
        """Replace working memory with new memories after reranking.
        """
        memories_with_new_order = None
        text_mem_base = mem_cube.text_mem
        if isinstance(text_mem_base, TreeTextMemory):
            text_mem_base: TreeTextMemory = text_mem_base
            combined_memory = original_memory + new_memory
            memory_map = {normalize_name(text=mem_obj.memory): mem_obj for mem_obj in combined_memory}
            combined_text_memory = [normalize_name(text=m.memory) for m in combined_memory]

            # apply filters
            # TODO：需要验证一下
            """
            Log Entry #8:
- log: item_id='7b92fffa-7cb8-403e-9396-78f1d11e4f6e' user_id='user_1' mem_cube_id='mem_cube_5' label='query' from_memory_type='UserMemory' to_memory_type='WorkingMemory' log_content='The user is planning to move to Chicago next month, although the exact date of the move is unclear.' current_memory_sizes={'long_term_memory_size': 209, 'user_memory_size': 605, 'working_memory_size': 20, 'transformed_act_memory_size': -1} memory_capacities={'long_term_memory_capacity': 10000, 'user_memory_capacity': 10000, 'working_memory_capacity': 20, 'transformed_act_memory_capacity': -1} timestamp=datetime.datetime(2025, 7, 14, 21, 28, 0, 496940)
--------------------------------------------------

Log Entry #9:
- log: item_id='33acc8a6-9a77-4d9d-a7a0-970e5b74b3df' user_id='user_1' mem_cube_id='mem_cube_5' label='query' from_memory_type='UserMemory' to_memory_type='WorkingMemory' log_content='The user is planning to move to Chicago next month, which reflects a significant change in their living situation.' current_memory_sizes={'long_term_memory_size': 209, 'user_memory_size': 605, 'working_memory_size': 20, 'transformed_act_memory_size': -1} memory_capacities={'long_term_memory_capacity': 10000, 'user_memory_capacity': 10000, 'working_memory_capacity': 20, 'transformed_act_memory_capacity': -1} timestamp=datetime.datetime(2025, 7, 14, 21, 28, 0, 497328)
--------------------------------------------------

Log Entry #10:
- log: item_id='fa63eed9-e113-4a55-bb3f-4c2064d62d9d' user_id='user_1' mem_cube_id='mem_cube_5' label='query' from_memory_type='UserMemory' to_memory_type='WorkingMemory' log_content='The user is planning to move to Chicago in the upcoming month, indicating a significant change in their living situation.' current_memory_sizes={'long_term_memory_size': 209, 'user_memory_size': 605, 'working_memory_size': 20, 'transformed_act_memory_size': -1} memory_capacities={'long_term_memory_capacity': 10000, 'user_memory_capacity': 10000, 'working_memory_capacity': 20, 'transformed_act_memory_capacity': -1} timestamp=datetime.datetime(2025, 7, 14, 21, 28, 0, 497694)
--------------------------------------------------

            """
            filtered_combined_text_memory = self.filter_similar_memories(
                text_memories=combined_text_memory,
                similarity_threshold = self.filter_similarity_threshold
            )

            filtered_combined_text_memory = self.filter_too_short_memories(
                text_memories=filtered_combined_text_memory,
                min_length_threshold=self.filter_min_length_threshold
            )

            unique_memory = list(dict.fromkeys(filtered_combined_text_memory))

            try:
                prompt = self.build_prompt(
                    "memory_reranking",
                    queries=queries,
                    current_order=unique_memory,
                    staging_buffer=[],
                )
                response = self.process_llm.generate([{"role": "user", "content": prompt}])
                response = extract_json_dict(response)
                text_memories_with_new_order = response.get("new_order", [])[:top_k]
            except Exception as e:
                logger.error(f"Fail to rerank with LLM, Exeption: {e}.")
                text_memories_with_new_order = unique_memory[:top_k]

            memories_with_new_order = []
            for text in text_memories_with_new_order:
                text = normalize_name(text=text)
                if text in memory_map:
                    memories_with_new_order.append(memory_map[text])
                else:
                    logger.warning(
                        f"Memory text not found in memory map. text: {text}; keys of memory_map: {memory_map.keys()}"
                    )

            text_mem_base.replace_working_memory(memories_with_new_order[:top_k])
            memories_with_new_order = memories_with_new_order[:top_k]
            logger.info(
                f"The working memory has been replaced with {len(memories_with_new_order)} new memories."
            )
            self.log_working_memory_replacement(original_memory=original_memory,
                                                user_id=user_id,
                                                mem_cube_id=mem_cube_id,
                                                new_memory=new_memory,
                                                mem_cube=mem_cube)
        else:
            logger.error("memory_base is not supported")

        return memories_with_new_order