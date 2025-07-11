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
    TextMemory_SEARCH_METHOD,
    TreeTextMemory_SEARCH_METHOD,
)
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.templates.mem_scheduler_prompts import MEMORY_ASSEMBLY_TEMPLATE


logger = get_logger(__name__)


class GeneralScheduler(BaseScheduler):
    def __init__(self, config: GeneralSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__(config)
        self.top_k = self.config.get("top_k", 10)
        self.act_mem_update_interval = self.config.get("act_mem_update_interval", 300)
        self.context_window_size = self.config.get("context_window_size", 5)
        self.activation_mem_size = self.config.get(
            "activation_mem_size", DEFAULT_ACTIVATION_MEM_SIZE
        )
        self.enable_act_memory_update = self.config.get("enable_act_memory_update", False)
        self.act_mem_dump_path = self.config.get("act_mem_dump_path", DEFAULT_ACT_MEM_DUMP_PATH)
        self.search_method = TextMemory_SEARCH_METHOD
        self._last_activation_mem_update_time = 0.0
        self.query_list = []

        # register handlers
        handlers = {
            QUERY_LABEL: self._query_message_consume,
            ANSWER_LABEL: self._answer_message_consume,
        }
        self.dispatcher.register_handlers(handlers)

    def initialize_modules(self, chat_llm: BaseLLM):
        self.chat_llm = chat_llm
        self.monitor = SchedulerMonitor(
            chat_llm=self.chat_llm, activation_mem_size=self.activation_mem_size
        )
        self.retriever = SchedulerRetriever(chat_llm=self.chat_llm)
        if self.auth_config_path is not None and Path(self.auth_config_path).exists():
            self.auth_config = AuthConfig.from_local_yaml(config_path=self.auth_config_path)
        elif AuthConfig.default_config_exists():
            self.auth_config = AuthConfig.from_local_yaml()
        else:
            self.auth_config = None

        # using auth_cofig
        if self.auth_config is not None:
            self.rabbitmq_config = self.auth_config.rabbitmq
            self.initialize_rabbitmq(config=self.rabbitmq_config)

        logger.debug("GeneralScheduler has been initialized")


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
            self._set_current_context_from_message(msg)

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
            text_mem_base = self.mem_cube.text_mem
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
                self.update_activation_memory(current_activation_mem)
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
            self._set_current_context_from_message(msg)

            self.process_session_turn(query=msg.content, top_k=self.top_k)

    def process_session_turn(self, query: str, top_k: int = 10) -> None:
        """
        Process a dialog turn:
        - If q_list reaches window size, trigger retrieval;
        - Immediately switch to the new memory if retrieval is triggered.
        """
        q_list = [query]
        self.query_list.append(query)
        text_mem_base = self.mem_cube.text_mem
        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error("Not implemented!")
            return

        working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in working_memory]
        intent_result = self.monitor.detect_intent(
            q_list=q_list,
            text_working_memory=text_working_memory
        )

        if intent_result["trigger_retrieval"]:
            missing_evidence = intent_result["missing_evidence"]
            num_evidence = len(missing_evidence)
            k_per_evidence = max(1, top_k // max(1, num_evidence))
            new_candidates = []
            for item in missing_evidence:
                logger.debug(f"missing_evidence: {item}")
                results = self.search(query=item,
                                      top_k=k_per_evidence,
                                      method=self.search_method)
                logger.debug(f"search results for {missing_evidence}: {results}")
                new_candidates.extend(results)

            new_order_working_memory = self.replace_working_memory(
                original_memory=working_memory, new_memory=new_candidates, top_k=top_k
            )
            logger.debug(f"size of new_order_working_memory: {len(new_order_working_memory)}")






