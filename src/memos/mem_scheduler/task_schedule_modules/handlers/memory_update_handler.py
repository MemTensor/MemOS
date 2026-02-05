from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.schemas.monitor_schemas import QueryMonitorItem
from memos.mem_scheduler.schemas.task_schemas import (
    DEFAULT_MAX_QUERY_KEY_WORDS,
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.mem_scheduler.utils.filter_utils import is_all_chinese, is_all_english
from memos.memories.textual.naive import NaiveTextMemory
from memos.memories.textual.tree import TreeTextMemory


logger = get_logger(__name__)

if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.memories.textual.item import TextualMemoryItem
    from memos.types import MemCubeID, UserID


class MemoryUpdateHandler(BaseSchedulerHandler):
    @property
    def expected_task_label(self) -> str:
        return MEM_UPDATE_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        self.long_memory_update_process(user_id=user_id, mem_cube_id=mem_cube_id, messages=batch)

    def long_memory_update_process(
        self,
        user_id: str,
        mem_cube_id: str,
        messages: list[ScheduleMessageItem],
    ) -> None:
        mem_cube = self.scheduler_context.get_mem_cube()
        monitor = self.scheduler_context.get_monitor()

        query_key_words_limit = self.scheduler_context.get_query_key_words_limit()

        for msg in messages:
            monitor.register_query_monitor_if_not_exists(user_id=user_id, mem_cube_id=mem_cube_id)

            query = msg.content
            query_keywords = monitor.extract_query_keywords(query=query)
            logger.info(
                'Extracted keywords "%s" from query "%s" for user_id=%s',
                query_keywords,
                query,
                user_id,
            )

            if len(query_keywords) == 0:
                stripped_query = query.strip()
                if is_all_english(stripped_query):
                    words = stripped_query.split()
                elif is_all_chinese(stripped_query):
                    words = stripped_query
                else:
                    logger.debug(
                        "Mixed-language memory, using character count: %s...",
                        stripped_query[:50],
                    )
                    words = stripped_query

                query_keywords = list(set(words[:query_key_words_limit]))
                logger.error(
                    "Keyword extraction failed for query '%s' (user_id=%s). Using fallback keywords: %s... (truncated)",
                    query,
                    user_id,
                    query_keywords[:10],
                    exc_info=True,
                )

            item = QueryMonitorItem(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                query_text=query,
                keywords=query_keywords,
                max_keywords=DEFAULT_MAX_QUERY_KEY_WORDS,
            )

            query_db_manager = monitor.query_monitors[user_id][mem_cube_id]
            query_db_manager.obj.put(item=item)
        query_db_manager.sync_with_orm()
        logger.debug(
            "Queries in monitor for user_id=%s, mem_cube_id=%s: %s",
            user_id,
            mem_cube_id,
            query_db_manager.obj.get_queries_with_timesort(),
        )

        queries = [msg.content for msg in messages]

        cur_working_memory, new_candidates = self.process_session_turn(
            queries=queries,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            top_k=self.scheduler_context.get_top_k(),
        )
        logger.info(
            "[long_memory_update_process] Processed %s queries %s and retrieved %s new candidate memories for user_id=%s: "
            + ("\n- " + "\n- ".join([f"{one.id}: {one.memory}" for one in new_candidates])),
            len(queries),
            queries,
            len(new_candidates),
            user_id,
        )

        new_order_working_memory = self.scheduler_context.services.replace_working_memory(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            original_memory=cur_working_memory,
            new_memory=new_candidates,
        )
        logger.debug(
            "[long_memory_update_process] Final working memory size: %s memories for user_id=%s",
            len(new_order_working_memory),
            user_id,
        )

        old_memory_texts = "\n- " + "\n- ".join(
            [f"{one.id}: {one.memory}" for one in cur_working_memory]
        )
        new_memory_texts = "\n- " + "\n- ".join(
            [f"{one.id}: {one.memory}" for one in new_order_working_memory]
        )

        logger.info(
            "[long_memory_update_process] For user_id='%s', mem_cube_id='%s': "
            "Scheduler replaced working memory based on query history %s. "
            "Old working memory (%s items): %s. "
            "New working memory (%s items): %s.",
            user_id,
            mem_cube_id,
            queries,
            len(cur_working_memory),
            old_memory_texts,
            len(new_order_working_memory),
            new_memory_texts,
        )

        logger.debug(
            "Activation memory update %s (interval: %ss)",
            "enabled" if self.scheduler_context.get_enable_activation_memory() else "disabled",
            monitor.act_mem_update_interval,
        )
        if self.scheduler_context.get_enable_activation_memory():
            self.scheduler_context.services.update_activation_memory_periodically(
                interval_seconds=monitor.act_mem_update_interval,
                label=QUERY_TASK_LABEL,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )

    def process_session_turn(
        self,
        queries: str | list[str],
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube,
        top_k: int = 10,
    ) -> tuple[list[TextualMemoryItem], list[TextualMemoryItem]] | None:
        text_mem_base = mem_cube.text_mem
        if not isinstance(text_mem_base, TreeTextMemory):
            if isinstance(text_mem_base, NaiveTextMemory):
                logger.debug(
                    "NaiveTextMemory used for mem_cube_id=%s, processing session turn with simple search.",
                    mem_cube_id,
                )
                cur_working_memory = []
            else:
                logger.warning(
                    "Not implemented! Expected TreeTextMemory but got %s for mem_cube_id=%s, user_id=%s. text_mem_base value: %s",
                    type(text_mem_base).__name__,
                    mem_cube_id,
                    user_id,
                    text_mem_base,
                )
                return [], []
        else:
            cur_working_memory = text_mem_base.get_working_memory(user_name=mem_cube_id)
            cur_working_memory = cur_working_memory[:top_k]

        logger.info(
            "[process_session_turn] Processing %s queries for user_id=%s, mem_cube_id=%s",
            len(queries),
            user_id,
            mem_cube_id,
        )

        text_working_memory: list[str] = [w_m.memory for w_m in cur_working_memory]
        monitor = self.scheduler_context.get_monitor()
        intent_result = monitor.detect_intent(
            q_list=queries, text_working_memory=text_working_memory
        )

        time_trigger_flag = False
        if monitor.timed_trigger(
            last_time=monitor.last_query_consume_time,
            interval_seconds=monitor.query_trigger_interval,
        ):
            time_trigger_flag = True

        if (not intent_result["trigger_retrieval"]) and (not time_trigger_flag):
            logger.info(
                "[process_session_turn] Query schedule not triggered for user_id=%s, mem_cube_id=%s. Intent_result: %s",
                user_id,
                mem_cube_id,
                intent_result,
            )
            return
        if (not intent_result["trigger_retrieval"]) and time_trigger_flag:
            logger.info(
                "[process_session_turn] Query schedule forced to trigger due to time ticker for user_id=%s, mem_cube_id=%s",
                user_id,
                mem_cube_id,
            )
            intent_result["trigger_retrieval"] = True
            intent_result["missing_evidences"] = queries
        else:
            logger.info(
                "[process_session_turn] Query schedule triggered for user_id=%s, mem_cube_id=%s. Missing evidences: %s",
                user_id,
                mem_cube_id,
                intent_result["missing_evidences"],
            )

        missing_evidences = intent_result["missing_evidences"]
        num_evidence = len(missing_evidences)
        k_per_evidence = max(1, top_k // max(1, num_evidence))
        new_candidates: list[TextualMemoryItem] = []
        retriever = self.scheduler_context.get_retriever()
        search_method = self.scheduler_context.get_search_method()

        for item in missing_evidences:
            logger.info(
                "[process_session_turn] Searching for missing evidence: '%s' with top_k=%s for user_id=%s",
                item,
                k_per_evidence,
                user_id,
            )

            search_args = {}
            if isinstance(text_mem_base, NaiveTextMemory):
                try:
                    results = text_mem_base.search(query=item, top_k=k_per_evidence)
                except Exception as e:
                    logger.warning("NaiveTextMemory search failed: %s", e)
                    results = []
            else:
                results = retriever.search(
                    query=item,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    top_k=k_per_evidence,
                    method=search_method,
                    search_args=search_args,
                )

            logger.info(
                "[process_session_turn] Search results for missing evidence '%s': \n- %s",
                item,
                "\n- ".join([f"{one.id}: {one.memory}" for one in results]),
            )
            new_candidates.extend(results)
        return cur_working_memory, new_candidates
