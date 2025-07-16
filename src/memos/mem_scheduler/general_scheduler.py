import json

from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.modules.schemas import (
    ADD_LABEL,
    ANSWER_LABEL,
    QUERY_LABEL,
    ScheduleMessageItem,
)
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
        logger.debug(f"Messages {messages} assigned to {QUERY_LABEL} handler.")

        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self._validate_messages(messages=messages, label=QUERY_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                # for status update
                self._set_current_context_from_message(msg=messages[0])

                self.process_session_turn(
                    queries=[msg.content for msg in messages],
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=messages[0].mem_cube,
                    top_k=self.top_k,
                )

    def _answer_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        logger.debug(f"Messages {messages} assigned to {ANSWER_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self._validate_messages(messages=messages, label=ANSWER_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                # for status update
                self._set_current_context_from_message(msg=messages[0])

                # update acivation memories
                if self.enable_act_memory_update:
                    self.update_activation_memory_periodically(
                        interval_seconds=self.monitor.act_mem_update_interval,
                        label=ANSWER_LABEL,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=messages[0].mem_cube,
                    )

    def _add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.debug(f"Messages {messages} assigned to {ADD_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self._validate_messages(messages=messages, label=ADD_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                # for status update
                self._set_current_context_from_message(msg=messages[0])

                # submit logs
                for msg in messages:
                    user_inputs = json.loads(msg.content)
                    self.log_adding_user_inputs(
                        user_inputs=user_inputs,
                        user_id=msg.user_id,
                        mem_cube_id=msg.mem_cube_id,
                        mem_cube=msg.mem_cube,
                    )

                # update acivation memories
                if self.enable_act_memory_update:
                    self.update_activation_memory_periodically(
                        interval_seconds=self.monitor.act_mem_update_interval,
                        label=ADD_LABEL,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=messages[0].mem_cube,
                    )

    def process_session_turn(
        self,
        queries: str | list[str],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        top_k: int = 10,
        query_history: list[str] | None = None,
    ) -> None:
        """
        Process a dialog turn:
        - If q_list reaches window size, trigger retrieval;
        - Immediately switch to the new memory if retrieval is triggered.
        """
        if isinstance(queries, str):
            queries = [queries]

        if query_history is None:
            query_history = queries
        else:
            query_history.extend(queries)

        text_mem_base = mem_cube.text_mem
        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error("Not implemented!", exc_info=True)
            return

        working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in working_memory]
        intent_result = self.monitor.detect_intent(
            q_list=query_history, text_working_memory=text_working_memory
        )

        if intent_result["trigger_retrieval"]:
            missing_evidences = intent_result["missing_evidences"]
            num_evidence = len(missing_evidences)
            k_per_evidence = max(1, top_k // max(1, num_evidence))
            new_candidates = []
            for item in missing_evidences:
                logger.debug(f"missing_evidences: {item}")
                results = self.retriever.search(
                    query=item, mem_cube=mem_cube, top_k=k_per_evidence, method=self.search_method
                )
                logger.debug(f"search results for {missing_evidences}: {results}")
                new_candidates.extend(results)

            new_order_working_memory = self.retriever.replace_working_memory(
                queries=queries,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                original_memory=working_memory,
                new_memory=new_candidates,
                top_k=top_k,
            )
            logger.debug(f"size of new_order_working_memory: {len(new_order_working_memory)}")
