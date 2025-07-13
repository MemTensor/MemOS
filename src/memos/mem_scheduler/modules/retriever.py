import json
from typing import Any, List, Dict

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
from memos.mem_scheduler.modules.schemas import (
    DEFAULT_ACTIVATION_MEM_SIZE,
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
    DEFAULT_ACTIVATION_MEM_SIZE,
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
            combined_text_memory = [new_m.memory for new_m in original_memory] + [
                new_m.memory for new_m in new_memory
            ]
            combined_memory = original_memory + new_memory
            memory_map = {mem_obj.memory: mem_obj for mem_obj in combined_memory}

            unique_memory = list(dict.fromkeys(combined_text_memory))
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