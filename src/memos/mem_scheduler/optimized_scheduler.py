from typing import TYPE_CHECKING, Any

from memos.api.product_models import APISearchRequest
from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.api_misc import SchedulerAPIModule
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    API_MIX_SEARCH_LABEL,
    QUERY_LABEL,
    MemCubeID,
    SearchMode,
    UserID,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.types import UserContext


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorItem


logger = get_logger(__name__)


class OptimizedScheduler(GeneralScheduler):
    """Optimized scheduler with improved working memory management and support for api"""

    def __init__(self, config: GeneralSchedulerConfig):
        super().__init__(config)
        self.api_module = SchedulerAPIModule()
        self.message_consumers = {
            API_MIX_SEARCH_LABEL: self._api_mix_search_message_consumer,
        }

    def _format_memory_item(self, memory_data: Any) -> dict[str, Any]:
        """Format a single memory item for API response."""
        memory = memory_data.model_dump()
        memory_id = memory["id"]
        ref_id = f"[{memory_id.split('-')[0]}]"

        memory["ref_id"] = ref_id
        memory["metadata"]["embedding"] = []
        memory["metadata"]["sources"] = []
        memory["metadata"]["ref_id"] = ref_id
        memory["metadata"]["id"] = memory_id
        memory["metadata"]["memory"] = memory["memory"]

        return memory

    def fine_search_memories(
        self,
        search_req: APISearchRequest,
        user_context: UserContext,
        mem_cube: GeneralMemCube,
    ):
        """Fine search memories function copied from server_router to avoid circular import"""
        target_session_id = search_req.session_id
        if not target_session_id:
            target_session_id = "default_session"
        search_filter = {"session_id": search_req.session_id} if search_req.session_id else None

        # Create MemCube and perform search
        search_results = mem_cube.text_mem.search(
            query=search_req.query,
            user_name=user_context.mem_cube_id,
            top_k=search_req.top_k,
            mode=SearchMode.FINE,
            manual_close_internet=not search_req.internet_search,
            moscube=search_req.moscube,
            search_filter=search_filter,
            info={
                "user_id": search_req.user_id,
                "session_id": target_session_id,
                "chat_history": search_req.chat_history,
            },
        )
        formatted_memories = [self._format_memory_item(data) for data in search_results]

        return formatted_memories

    def update_search_memories_to_redis(
        self, user_id: str, mem_cube_id: str, messages: list[ScheduleMessageItem]
    ):
        mem_cube = messages[0].mem_cube

        # for status update
        self._set_current_context_from_message(msg=messages[0])

        # update query monitors
        for msg in messages:
            self.monitor.register_query_monitor_if_not_exists(
                user_id=user_id, mem_cube_id=mem_cube_id
            )

            content_dict = msg.content
            search_req = content_dict["search_req"]
            user_context = content_dict["user_context"]

            formatted_memories = self.fine_search_memories(
                search_req=search_req, user_context=user_context, mem_cube=mem_cube
            )

            # Sync search data to Redis
            try:
                self.api_module.sync_search_data(
                    user_id=search_req.user_id,
                    mem_cube_id=user_context.mem_cube_id,
                    query=search_req.query,
                    formatted_memories=formatted_memories,
                )
            except Exception as e:
                logger.error(f"Failed to sync search data: {e}")

    def _api_mix_search_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        logger.info(f"Messages {messages} assigned to {QUERY_LABEL} handler.")

        # Process the query in a session turn
        grouped_messages = self.dispatcher._group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=QUERY_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return
                self.update_search_memories_to_redis(
                    user_id=user_id, mem_cube_id=mem_cube_id, messages=messages
                )

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
