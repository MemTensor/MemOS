import json

from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    ANSWER_LABEL,
    DEFAULT_MAX_QUERY_KEY_WORDS,
    QUERY_LABEL,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.monitor_schemas import QueryMonitorItem
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


logger = get_logger(__name__)


class GeneralScheduler(BaseScheduler):
    def __init__(self, config: GeneralSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__(config)

        # register handlers
        handlers = {
            QUERY_LABEL: self._query_message_consumer,
            ANSWER_LABEL: self._answer_message_consumer,
            ADD_LABEL: self._add_message_consumer,
        }
        self.dispatcher.register_handlers(handlers)

    def _query_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        logger.info(f"Messages {messages} assigned to {QUERY_LABEL} handler.")

        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=QUERY_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                mem_cube = messages[0].mem_cube

                # for status update
                self._set_current_context_from_message(msg=messages[0])

                # update query monitors
                for msg in messages:
                    query = msg.content
                    query_keywords = self.monitor.extract_query_keywords(query=query)
                    logger.info(f'Extract keywords "{query_keywords}" from query "{query}"')

                    item = QueryMonitorItem(
                        query_text=query,
                        keywords=query_keywords,
                        max_keywords=DEFAULT_MAX_QUERY_KEY_WORDS,
                    )
                    self.monitor.query_monitors.put(item=item)
                logger.debug(
                    f"Queries in monitor are {self.monitor.query_monitors.get_queries_with_timesort()}."
                )

                queries = [msg.content for msg in messages]

                # recall
                cur_working_memory, new_candidates = self.process_session_turn(
                    queries=queries,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    top_k=self.top_k,
                )
                logger.info(
                    f"Processed {queries} and get {len(new_candidates)} new candidate memories."
                )

                # rerank
                new_order_working_memory = self.replace_working_memory(
                    queries=queries,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    original_memory=cur_working_memory,
                    new_memory=new_candidates,
                )
                logger.info(f"size of new_order_working_memory: {len(new_order_working_memory)}")

    def _answer_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        logger.info(f"Messages {messages} assigned to {ANSWER_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ANSWER_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                # for status update
                self._set_current_context_from_message(msg=messages[0])

                # update acivation memories
                if self.enable_act_memory_update:
                    if (
                        len(self.monitor.working_memory_monitors[user_id][mem_cube_id].memories)
                        == 0
                    ):
                        self.initialize_working_memory_monitors(
                            user_id=user_id,
                            mem_cube_id=mem_cube_id,
                            mem_cube=messages[0].mem_cube,
                        )

                    self.update_activation_memory_periodically(
                        interval_seconds=self.monitor.act_mem_update_interval,
                        label=ANSWER_LABEL,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=messages[0].mem_cube,
                    )

    def _add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {ADD_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ADD_LABEL)
        try:
            for user_id in grouped_messages:
                for mem_cube_id in grouped_messages[user_id]:
                    messages = grouped_messages[user_id][mem_cube_id]
                    if len(messages) == 0:
                        return

                    # for status update
                    self._set_current_context_from_message(msg=messages[0])

                    # submit logs
                    for msg in messages:
                        userinput_memory_ids = json.loads(msg.content)
                        mem_cube = msg.mem_cube
                        for memory_id in userinput_memory_ids:
                            mem_item: TextualMemoryItem = mem_cube.text_mem.get(memory_id=memory_id)
                            mem_type = mem_item.metadata.memory_type
                            mem_content = mem_item.memory

                            self.log_adding_memory(
                                memory=mem_content,
                                memory_type=mem_type,
                                user_id=msg.user_id,
                                mem_cube_id=msg.mem_cube_id,
                                mem_cube=msg.mem_cube,
                                log_func_callback=self._submit_web_logs,
                            )

                    # update activation memories
                    if self.enable_act_memory_update:
                        self.update_activation_memory_periodically(
                            interval_seconds=self.monitor.act_mem_update_interval,
                            label=ADD_LABEL,
                            user_id=user_id,
                            mem_cube_id=mem_cube_id,
                            mem_cube=messages[0].mem_cube,
                        )
        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)

    def process_session_turn(
        self,
        queries: str | list[str],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        top_k: int = 10,
    ) -> tuple[list[TextualMemoryItem], list[TextualMemoryItem]] | None:
        """
        Process a dialog turn:
        - If q_list reaches window size, trigger retrieval;
        - Immediately switch to the new memory if retrieval is triggered.
        """

        text_mem_base = mem_cube.text_mem
        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error("Not implemented!", exc_info=True)
            return

        logger.info(f"Processing {len(queries)} queries.")

        cur_working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in cur_working_memory]
        intent_result = self.monitor.detect_intent(
            q_list=queries, text_working_memory=text_working_memory
        )

        time_trigger_flag = False
        if self.monitor.timed_trigger(
            last_time=self.monitor.last_query_consume_time,
            interval_seconds=self.monitor.query_trigger_interval,
        ):
            time_trigger_flag = True

        if (not intent_result["trigger_retrieval"]) and (not time_trigger_flag):
            logger.info(f"Query schedule not triggered. Intent_result: {intent_result}")
            return
        elif (not intent_result["trigger_retrieval"]) and time_trigger_flag:
            logger.info("Query schedule is forced to trigger due to time ticker")
            intent_result["trigger_retrieval"] = True
            intent_result["missing_evidences"] = queries
        else:
            logger.info(
                f'Query schedule triggered for user "{user_id}" and mem_cube "{mem_cube_id}".'
                f" Missing evidences: {intent_result['missing_evidences']}"
            )

        missing_evidences = intent_result["missing_evidences"]
        num_evidence = len(missing_evidences)
        k_per_evidence = max(1, top_k // max(1, num_evidence))
        new_candidates = []
        for item in missing_evidences:
            logger.info(f"missing_evidences: {item}")
            results: list[TextualMemoryItem] = self.retriever.search(
                query=item, mem_cube=mem_cube, top_k=k_per_evidence, method=self.search_method
            )
            logger.info(f"search results for {missing_evidences}: {results}")
            new_candidates.extend(results)

        if len(new_candidates) == 0:
            logger.warning(
                f"As new_candidates is empty, new_candidates is set same to working_memory.\n"
                f"time_trigger_flag: {time_trigger_flag}; intent_result: {intent_result}"
            )
            new_candidates = cur_working_memory
        return cur_working_memory, new_candidates
