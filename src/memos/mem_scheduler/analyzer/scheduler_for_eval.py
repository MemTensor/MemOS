from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_MAX_QUERY_KEY_WORDS,
    UserID,
)
from memos.mem_scheduler.schemas.monitor_schemas import QueryMonitorItem


if TYPE_CHECKING:
    from memos.memories.textual.tree import TextualMemoryItem


logger = get_logger(__name__)


class SchedulerForEval(GeneralScheduler):
    """
    A scheduler class that inherits from GeneralScheduler and provides evaluation-specific functionality.
    This class extends GeneralScheduler with evaluation methods.
    """

    def __init__(self, config):
        """
        Initialize the SchedulerForEval with the same configuration as GeneralScheduler.

        Args:
            config: Configuration object for the scheduler
        """
        super().__init__(config)

    def update_working_memory_for_eval(
        self, query: str, user_id: UserID | str, top_k: int
    ) -> list[str]:
        """
        Update working memory based on query and return the updated memory list.

        Args:
            query: The query string
            user_id: User identifier
            top_k: Number of top memories to return

        Returns:
            List of memory strings from updated working memory
        """
        self.monitor.register_query_monitor_if_not_exists(
            user_id=user_id, mem_cube_id=self.current_mem_cube_id
        )

        query_keywords = self.monitor.extract_query_keywords(query=query)
        logger.info(f'Extract keywords "{query_keywords}" from query "{query}"')

        item = QueryMonitorItem(
            user_id=user_id,
            mem_cube_id=self.current_mem_cube_id,
            query_text=query,
            keywords=query_keywords,
            max_keywords=DEFAULT_MAX_QUERY_KEY_WORDS,
        )
        query_db_manager = self.monitor.query_monitors[user_id][self.current_mem_cube_id]
        query_db_manager.obj.put(item=item)
        # Sync with database after adding new item
        query_db_manager.sync_with_orm()
        logger.debug(f"Queries in monitor are {query_db_manager.obj.get_queries_with_timesort()}.")

        queries = [query]

        # recall
        mem_cube = self.current_mem_cube
        text_mem_base = mem_cube.text_mem

        cur_working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in cur_working_memory]
        intent_result = self.monitor.detect_intent(
            q_list=queries, text_working_memory=text_working_memory
        )

        if intent_result["trigger_retrieval"]:
            missing_evidences = intent_result["missing_evidences"]
            num_evidence = len(missing_evidences)
            k_per_evidence = max(1, top_k // max(1, num_evidence))
            new_candidates = []
            for item in missing_evidences:
                logger.info(f"missing_evidences: {item}")
                results: list[TextualMemoryItem] = self.retriever.search(
                    query=item,
                    mem_cube=mem_cube,
                    top_k=k_per_evidence,
                    method=self.search_method,
                )
                logger.info(
                    f"search results for {missing_evidences}: {[one.memory for one in results]}"
                )
                new_candidates.extend(results)
            print(
                f"missing_evidences: {missing_evidences} and get {len(new_candidates)} new candidate memories."
            )
        else:
            new_candidates = []
            print(f"intent_result: {intent_result}. not triggered")

        # rerank
        new_order_working_memory = self.replace_working_memory(
            user_id=user_id,
            mem_cube_id=self.current_mem_cube_id,
            mem_cube=self.current_mem_cube,
            original_memory=cur_working_memory,
            new_memory=new_candidates,
        )
        new_order_working_memory = new_order_working_memory[:top_k]
        logger.info(f"size of new_order_working_memory: {len(new_order_working_memory)}")

        return [m.memory for m in new_order_working_memory]

    def evaluate_query_with_memories(
        self, query: str, memory_texts: list[str], user_id: UserID | str
    ) -> bool:
        """
        Use LLM to evaluate whether the given memories can answer the query.

        Args:
            query: The query string to evaluate
            memory_texts: List of memory texts to check against
            user_id: User identifier

        Returns:
            Boolean indicating whether the memories can answer the query
        """
        queries = [query]
        intent_result = self.monitor.detect_intent(q_list=queries, text_working_memory=memory_texts)
        return intent_result["trigger_retrieval"]

    def search_for_eval(
        self, query: str, user_id: UserID | str, top_k: int, scheduler_flag: bool = True
    ) -> tuple[list[str], bool]:
        """
        Original search_for_eval function refactored to use the new decomposed functions.

        Args:
            query: The query string
            user_id: User identifier
            top_k: Number of top memories to return
            scheduler_flag: Whether to update working memory or just evaluate

        Returns:
            Tuple of (memory_list, can_answer_boolean)
        """
        if not scheduler_flag:
            # Get current working memory without updating
            mem_cube = self.current_mem_cube
            text_mem_base = mem_cube.text_mem
            cur_working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
            text_working_memory: list[str] = [w_m.memory for w_m in cur_working_memory]

            # Use the evaluation function to check if memories can answer the query
            can_answer = self.evaluate_query_with_memories(
                query=query, memory_texts=text_working_memory, user_id=user_id
            )
            return text_working_memory, can_answer
        else:
            # Update working memory and get the result
            updated_memories = self.update_working_memory_for_eval(
                query=query, user_id=user_id, top_k=top_k
            )

            # Use the evaluation function to check if memories can answer the query
            can_answer = self.evaluate_query_with_memories(
                query=query, memory_texts=updated_memories, user_id=user_id
            )
            return updated_memories, can_answer
