from __future__ import annotations

import time

from functools import wraps
from typing import TYPE_CHECKING, Any, ClassVar

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

    # Class variable to store timing information for all instances
    timer_cache: ClassVar[dict[str, dict[str, Any]]] = {}

    def __init__(self, config):
        """
        Initialize the SchedulerForEval with the same configuration as GeneralScheduler.

        Args:
            config: Configuration object for the scheduler
        """
        super().__init__(config)
        # Initialize instance timer_cache
        self.timer_cache = {}

    @staticmethod
    def time_it(func_name: str | None = None):
        """
        Static method decorator to measure function execution time and store in timer_cache.

        Args:
            func_name: Custom name for the function in timer_cache. If None, uses function.__name__
        """

        def decorator(func):
            @wraps(func)
            def wrapper(self, *args, **kwargs):
                # Get function name
                name = func_name or func.__name__

                # Start timing
                start_time = time.time()
                result = func(self, *args, **kwargs)
                end_time = time.time()

                # Calculate execution time
                exec_time = end_time - start_time

                # Format time as HH:MM:SS.mmm
                hours = int(exec_time // 3600)
                minutes = int((exec_time % 3600) // 60)
                seconds = exec_time % 60

                if hours > 0:
                    time_str = f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"
                else:
                    time_str = f"{minutes:02d}:{seconds:06.3f}"

                # Store in timer_cache
                if not hasattr(self, "timer_cache"):
                    self.timer_cache = {}

                self.timer_cache[name] = {
                    "time_str": time_str,
                    "seconds": exec_time,
                }

                logger.info(f"{name} executed in {time_str}")
                return result

            return wrapper

        return decorator

    def get_timer_summary(self) -> str:
        """
        Get a summary of all timed functions.

        Returns:
            Formatted string with timing information
        """
        if not self.timer_cache:
            return "No timing data available."

        summary = "=== Timing Summary ===\n"
        for func_name, data in self.timer_cache.items():
            summary += f"{func_name}: {data['time_str']} (at {data['timestamp']})\n"

        return summary

    def clear_timer_cache(self):
        """Clear the timer cache."""
        self.timer_cache.clear()

    @time_it("update_working_memory")
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
            logger.info(
                f"missing_evidences: {missing_evidences} and get {len(new_candidates)} new candidate memories."
            )
        else:
            new_candidates = []
            logger.info(f"intent_result: {intent_result}. not triggered")

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

    @time_it("memory_answer_ability")
    def evaluate_memory_answer_ability(
        self, query: str, memory_texts: list[str], top_k: int = 100
    ) -> bool:
        """
        Use LLM to evaluate whether the given memories can answer the query.

        Args:
            query: The query string to evaluate
            memory_texts: List of memory texts to check against
            top_k: Maximum number of memories to consider for evaluation

        Returns:
            Boolean indicating whether the memories can answer the query
        """
        # Limit the number of memories to evaluate
        limited_memories = memory_texts[:top_k] if memory_texts else []

        # Build prompt using the template
        prompt = self.monitor.build_prompt(
            template_name="memory_answer_ability_evaluation",
            query=query,
            memory_list="\n".join([f"- {memory}" for memory in limited_memories])
            if limited_memories
            else "No memories available",
        )

        # Use the process LLM to generate response
        response = self.monitor._process_llm.generate([{"role": "user", "content": prompt}])

        try:
            # Extract JSON response
            from memos.mem_scheduler.utils.misc_utils import extract_json_dict

            result = extract_json_dict(response)

            # Validate response structure
            if "result" in result:
                logger.info(
                    f"Memory answer ability evaluation result: {result['result']}, reason: {result.get('reason', 'No reason provided')}"
                )
                return result["result"]
            else:
                logger.warning(f"Invalid response structure from LLM: {result}")
                return False

        except Exception as e:
            logger.error(
                f"Failed to parse LLM response for memory answer ability evaluation: {response}. Error: {e}"
            )
            # Fallback: return False if we can't determine answer ability
            return False

    @time_it("search_for_eval")
    def search_for_eval(
        self, query: str, user_id: UserID | str, top_k: int, scheduler_flag: bool = True
    ) -> list[str]:
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

            return text_working_memory
        else:
            # Update working memory and get the result
            updated_memories = self.update_working_memory_for_eval(
                query=query, user_id=user_id, top_k=top_k
            )

            return updated_memories
