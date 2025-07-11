import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import List

from memos.configs.mem_scheduler import GeneralSchedulerConfig, AuthConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.modules.monitor import SchedulerMonitor
from memos.mem_scheduler.modules.retriever import SchedulerRetriever
from memos.mem_scheduler.modules.schemas import (
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
)
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.templates.mem_scheduler_prompts import MEMORY_ASSEMBLY_TEMPLATE

logger = get_logger(__name__)


class GeneralScheduler(BaseScheduler):
    def __init__(self, config: GeneralSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__(config)

        # register handlers
        handlers = {
            QUERY_LABEL: self._query_message_consume,
            ANSWER_LABEL: self._answer_message_consume,
        }
        self.dispatcher.register_handlers(handlers)


    def _answer_message_consume(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        # TODO: This handler is not ready yet
        logger.debug(f"Messages {messages} assigned to {ANSWER_LABEL} handler.")
        for msg in messages:
            if not self._validate_message(msg, ANSWER_LABEL):
                continue

            # for status update
            self._set_current_context_from_message(msg)

            mem_cube = msg.mem_cube
            answer = msg.content

            if not self.enable_act_memory_update:
                logger.info("Activation memory updates are disabled - skipping processing")
                return
            # Get current activation memory items
            current_activation_mem = [
                item["memory"]
                for item in self.monitor.activation_memory_freq_list
                if item["memory"] is not None
            ]

            # Update memory frequencies based on the answer
            # TODO: not implemented
            text_mem_base = mem_cube.text_mem
            if isinstance(text_mem_base, TreeTextMemory):
                working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
            else:
                logger.error("Not implemented!")
                return
            text_working_memory: list[str] = [w_m.memory for w_m in working_memory]
            self.monitor.activation_memory_freq_list = self.monitor.update_freq(
                answer=answer,
                text_working_memory=text_working_memory,
                activation_memory_freq_list=self.monitor.activation_memory_freq_list,
            )

            # Check if it's time to update activation memory
            now = datetime.now()
            if (now - self._last_activation_mem_update_time) >= timedelta(
                seconds=self.act_mem_update_interval
            ):
                # TODO: not implemented
                self.update_activation_memory(
                    new_memories=current_activation_mem,
                    mem_cube=mem_cube
                )
                self._last_activation_mem_update_time = now


    def _query_message_consume(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        logger.debug(f"Messages {messages} assigned to {QUERY_LABEL} handler.")
        for msg in messages:
            if not self._validate_message(msg, QUERY_LABEL):
                continue
            # Process the query in a session turn

            # for status update
            self._set_current_context_from_message(msg)

            self.process_session_turn(
                query=msg.content,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=msg.mem_cube,
                top_k=self.top_k
            )

    def process_session_turn(self, query: str,
                             user_id: str,
                             mem_cube_id:str,
                             mem_cube: GeneralMemCube,
                             top_k: int = 10,
                             query_history: List[str]|None = None) -> None:
        """
        Process a dialog turn:
        - If q_list reaches window size, trigger retrieval;
        - Immediately switch to the new memory if retrieval is triggered.
        """
        if query_history is None:
            query_history = [query]
        else:
            query_history.append(query)

        text_mem_base = mem_cube.text_mem
        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error("Not implemented!")
            return

        working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in working_memory]
        intent_result = self.monitor.detect_intent(
            q_list=query_history,
            text_working_memory=text_working_memory
        )

        if intent_result["trigger_retrieval"]:
            missing_evidences = intent_result["missing_evidences"]
            num_evidence = len(missing_evidences)
            k_per_evidence = max(1, top_k // max(1, num_evidence))
            new_candidates = []
            for item in missing_evidences:
                logger.debug(f"missing_evidences: {item}")
                results = self.retriever.search(query=item,
                                                mem_cube=mem_cube,
                                                top_k=k_per_evidence,
                                                method=self.search_method)
                logger.debug(f"search results for {missing_evidences}: {results}")
                new_candidates.extend(results)

            new_order_working_memory = self.retriever.replace_working_memory(
                query=query,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                original_memory=working_memory,
                new_memory=new_candidates,
                top_k=top_k
            )
            logger.debug(f"size of new_order_working_memory: {len(new_order_working_memory)}")




