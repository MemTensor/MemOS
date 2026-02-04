from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorItem
from memos.mem_scheduler.utils.filter_utils import transform_name_to_key
from memos.memories.textual.naive import NaiveTextMemory
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


if TYPE_CHECKING:
    from memos.types.general_types import MemCubeID, UserID


logger = get_logger(__name__)


class BaseSchedulerMemoryMixin:
    def transform_working_memories_to_monitors(
        self, query_keywords, memories: list[TextualMemoryItem]
    ) -> list[MemoryMonitorItem]:
        result = []
        mem_length = len(memories)
        for idx, mem in enumerate(memories):
            text_mem = mem.memory
            mem_key = transform_name_to_key(name=text_mem)

            keywords_score = 0
            if query_keywords and text_mem:
                for keyword, count in query_keywords.items():
                    keyword_count = text_mem.count(keyword)
                    if keyword_count > 0:
                        keywords_score += keyword_count * count
                        logger.debug(
                            "Matched keyword '%s' %s times, added %s to keywords_score",
                            keyword,
                            keyword_count,
                            keywords_score,
                        )

            sorting_score = mem_length - idx

            mem_monitor = MemoryMonitorItem(
                memory_text=text_mem,
                tree_memory_item=mem,
                tree_memory_item_mapping_key=mem_key,
                sorting_score=sorting_score,
                keywords_score=keywords_score,
                recording_count=1,
            )
            result.append(mem_monitor)

        logger.info("Transformed %s memories to monitors", len(result))
        return result

    def replace_working_memory(
        self,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube,
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
    ) -> None | list[TextualMemoryItem]:
        text_mem_base = mem_cube.text_mem
        if isinstance(text_mem_base, TreeTextMemory):
            query_db_manager = self.monitor.query_monitors[user_id][mem_cube_id]
            query_db_manager.sync_with_orm()

            query_history = query_db_manager.obj.get_queries_with_timesort()

            original_count = len(original_memory)
            filtered_original_memory = []
            for origin_mem in original_memory:
                if "mode:fast" not in origin_mem.metadata.tags:
                    filtered_original_memory.append(origin_mem)
                else:
                    logger.debug(
                        "Filtered out memory - ID: %s, Tags: %s",
                        getattr(origin_mem, "id", "unknown"),
                        origin_mem.metadata.tags,
                    )
            filtered_count = original_count - len(filtered_original_memory)
            remaining_count = len(filtered_original_memory)

            logger.info(
                "Filtering complete. Removed %s memories with tag 'mode:fast'. Remaining memories: %s",
                filtered_count,
                remaining_count,
            )
            original_memory = filtered_original_memory

            memories_with_new_order, rerank_success_flag = (
                self.retriever.process_and_rerank_memories(
                    queries=query_history,
                    original_memory=original_memory,
                    new_memory=new_memory,
                    top_k=self.top_k,
                )
            )

            logger.info("Filtering memories based on query history: %s queries", len(query_history))
            filtered_memories, filter_success_flag = self.retriever.filter_unrelated_memories(
                query_history=query_history,
                memories=memories_with_new_order,
            )

            if filter_success_flag:
                logger.info(
                    "Memory filtering completed successfully. Filtered from %s to %s memories",
                    len(memories_with_new_order),
                    len(filtered_memories),
                )
                memories_with_new_order = filtered_memories
            else:
                logger.warning(
                    "Memory filtering failed - keeping all memories as fallback. Original count: %s",
                    len(memories_with_new_order),
                )

            query_keywords = query_db_manager.obj.get_keywords_collections()
            logger.info(
                "Processing %s memories with %s query keywords",
                len(memories_with_new_order),
                len(query_keywords),
            )
            new_working_memory_monitors = self.transform_working_memories_to_monitors(
                query_keywords=query_keywords,
                memories=memories_with_new_order,
            )

            if not rerank_success_flag:
                for one in new_working_memory_monitors:
                    one.sorting_score = 0

            logger.info("update %s working_memory_monitors", len(new_working_memory_monitors))
            self.monitor.update_working_memory_monitors(
                new_working_memory_monitors=new_working_memory_monitors,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )

            mem_monitors: list[MemoryMonitorItem] = self.monitor.working_memory_monitors[user_id][
                mem_cube_id
            ].obj.get_sorted_mem_monitors(reverse=True)
            new_working_memories = [mem_monitor.tree_memory_item for mem_monitor in mem_monitors]

            text_mem_base.replace_working_memory(memories=new_working_memories)

            logger.info(
                "The working memory has been replaced with %s new memories.",
                len(memories_with_new_order),
            )
            self.log_working_memory_replacement(
                original_memory=original_memory,
                new_memory=new_working_memories,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                log_func_callback=self._submit_web_logs,
            )
        elif isinstance(text_mem_base, NaiveTextMemory):
            logger.info(
                "NaiveTextMemory: Updating working memory monitors with %s candidates.",
                len(new_memory),
            )

            query_db_manager = self.monitor.query_monitors[user_id][mem_cube_id]
            query_db_manager.sync_with_orm()
            query_keywords = query_db_manager.obj.get_keywords_collections()

            new_working_memory_monitors = self.transform_working_memories_to_monitors(
                query_keywords=query_keywords,
                memories=new_memory,
            )

            self.monitor.update_working_memory_monitors(
                new_working_memory_monitors=new_working_memory_monitors,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
            memories_with_new_order = new_memory
        else:
            logger.error("memory_base is not supported")
            memories_with_new_order = new_memory

        return memories_with_new_order

    def update_activation_memory(
        self,
        new_memories: list[str | TextualMemoryItem],
        label: str,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube,
    ) -> None:
        if hasattr(self, "activation_memory_manager") and self.activation_memory_manager:
            self.activation_memory_manager.update_activation_memory(
                new_memories=new_memories,
                label=label,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
        else:
            logger.warning("Activation memory manager not initialized")

    def update_activation_memory_periodically(
        self,
        interval_seconds: int,
        label: str,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube,
    ):
        if hasattr(self, "activation_memory_manager") and self.activation_memory_manager:
            self.activation_memory_manager.update_activation_memory_periodically(
                interval_seconds=interval_seconds,
                label=label,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
        else:
            logger.warning("Activation memory manager not initialized")
