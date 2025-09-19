from typing import TYPE_CHECKING

from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    MemCubeID,
    UserID,
)
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorItem


logger = get_logger(__name__)


class OptimizedScheduler(GeneralScheduler):
    """Optimized scheduler with improved working memory management"""

    def __init__(self, config: GeneralSchedulerConfig):
        super().__init__(config)

    def replace_working_memory(
        self,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube: GeneralMemCube,
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
    ) -> None | list[TextualMemoryItem]:
        """Replace working memory with new memories after reranking."""
        text_mem_base = mem_cube.text_mem
        if isinstance(text_mem_base, TreeTextMemory):
            text_mem_base: TreeTextMemory = text_mem_base

            # process rerank memories with llm
            query_db_manager = self.monitor.query_monitors[user_id][mem_cube_id]
            # Sync with database to get latest query history
            query_db_manager.sync_with_orm()

            query_history = query_db_manager.obj.get_queries_with_timesort()
            memories_with_new_order, rerank_success_flag = (
                self.retriever.process_and_rerank_memories(
                    queries=query_history,
                    original_memory=original_memory,
                    new_memory=new_memory,
                    top_k=self.top_k,
                )
            )

            # Apply combined filtering (unrelated + redundant)
            logger.info(
                f"Applying combined unrelated and redundant memory filtering to {len(memories_with_new_order)} memories"
            )
            filtered_memories, filtering_success_flag = (
                self.retriever.filter_unrelated_and_redundant_memories(
                    query_history=query_history,
                    memories=memories_with_new_order,
                )
            )

            if filtering_success_flag:
                logger.info(
                    f"Combined filtering completed successfully. "
                    f"Filtered from {len(memories_with_new_order)} to {len(filtered_memories)} memories"
                )
                memories_with_new_order = filtered_memories
            else:
                logger.warning(
                    "Combined filtering failed - keeping memories as fallback. "
                    f"Count: {len(memories_with_new_order)}"
                )

            # Update working memory monitors
            query_keywords = query_db_manager.obj.get_keywords_collections()
            logger.info(
                f"Processing {len(memories_with_new_order)} memories with {len(query_keywords)} query keywords"
            )
            new_working_memory_monitors = self.transform_working_memories_to_monitors(
                query_keywords=query_keywords,
                memories=memories_with_new_order,
            )

            if not rerank_success_flag:
                for one in new_working_memory_monitors:
                    one.sorting_score = 0

            logger.info(f"update {len(new_working_memory_monitors)} working_memory_monitors")
            self.monitor.update_working_memory_monitors(
                new_working_memory_monitors=new_working_memory_monitors,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )

            # Use the filtered and reranked memories directly
            text_mem_base.replace_working_memory(memories=memories_with_new_order)

            # Update monitor after replacing working memory
            mem_monitors: list[MemoryMonitorItem] = self.monitor.working_memory_monitors[user_id][
                mem_cube_id
            ].obj.get_sorted_mem_monitors(reverse=True)
            new_working_memories = [mem_monitor.tree_memory_item for mem_monitor in mem_monitors]

            logger.info(
                f"The working memory has been replaced with {len(memories_with_new_order)} new memories."
            )
            self.log_working_memory_replacement(
                original_memory=original_memory,
                new_memory=new_working_memories,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                log_func_callback=self._submit_web_logs,
            )
        else:
            logger.error("memory_base is not supported")
            memories_with_new_order = new_memory

        return memories_with_new_order
