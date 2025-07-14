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
    ADD_LABEL,
    ACTIVATION_MEMORY_TYPE,
    LONG_TERM_MEMORY_TYPE,
    WORKING_MEMORY_TYPE,
    DEFAULT_ACT_MEM_DUMP_PATH,
    DEFAULT_ACTIVATION_MEM_SIZE,
    NOT_INITIALIZED,
    ScheduleLogForWebItem,
    ScheduleMessageItem,
    MONITOR_WORKING_MEMORY_TYPE,
    MONITOR_ACTIVATION_MEMORY_TYPE,
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
                    top_k=self.top_k
                )

    def _answer_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        # TODO: This handler is not ready yet
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

                # TODO: collect new activation memories to be updated
                new_activation_memories = []

                if self.monitor.timed_trigger(self.monitor._last_activation_mem_update_time, self.monitor.act_mem_update_interval):
                    self.update_activation_memory(
                        new_memories=new_activation_memories,
                        mem_cube=mem_cube
                    )
                    self.monitor._last_activation_mem_update_time = datetime.now()

    def _add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        # TODO: This handler is not ready yet
        logger.debug(f"Messages {messages} assigned to {ADD_LABEL} handler.")
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

                # TODO: collect new activation memories to be updated
                new_activation_memories = []

                if self.monitor.timed_trigger(self.monitor._last_activation_mem_update_time, self.monitor.act_mem_update_interval):
                    self.update_activation_memory(
                        new_memories=new_activation_memories,
                        mem_cube=mem_cube
                    )
                    self.monitor._last_activation_mem_update_time = datetime.now()



    def update_activation_memory(
            self,
            new_memories: list[str | TextualMemoryItem],
            mem_cube: GeneralMemCube,
    ) -> None:
        """
        Update activation memory by extracting KVCacheItems from new_memory (list of str),
        add them to a KVCacheMemory instance, and dump to disk.
        """
        if len(new_memories) == 0:
            logger.error("update_activation_memory: new_memory is empty.")
            return
        if isinstance(new_memories[0], TextualMemoryItem):
            new_text_memories = [mem.memory for mem in new_memories]
        elif isinstance(new_memories[0], str):
            new_text_memories = new_memories
        else:
            logger.error("Not Implemented.")

        try:
            assert isinstance(mem_cube.act_mem, KVCacheMemory)
            act_mem: KVCacheMemory = mem_cube.act_mem

            text_memory = MEMORY_ASSEMBLY_TEMPLATE.format(
                memory_text="".join(
                    [
                        f"{i + 1}. {sentence.strip()}\n"
                        for i, sentence in enumerate(new_text_memories)
                        if sentence.strip()  # Skip empty strings
                    ]
                )
            )
            if self.act_mem_backend == ACTIVATION_MEMORY_HF_BACKEND :
                # huggingface kv cache
                original_cache_items: List[KVCacheItem] = act_mem.get_all()
                pre_cache_item: KVCacheItem = origin_cache_items[-1]
                original_text_memories = pre_cache_item.records.text_memories
                act_mem.delete_all()
                cache_item: KVCacheItem = act_mem.extract(text_memory)
                cache_item.records.text_memories = new_text_memories

                act_mem.add(cache_item)
                act_mem.dump(self.act_mem_dump_path)

            elif self.act_mem_backend == ACTIVATION_MEMORY_VLLM_BACKEND :
                # vllm kv cache
                self.log_activation_memory_update(original_text_memories=original_text_memories,
                                                  new_text_memories=new_text_memories,
                                                  user_id=user_id,
                                                  mem_cube_id=mem_cube_id,
                                                  mem_cube=mem_cube)
            else:
                raise NotImplementedError(self.act_mem_backend)

        except Exception as e:
            logger.warning(f"MOS-based activation memory update failed: {e}")

    def working_memories_to_activation_memories(self):
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
        self._last_activation_mem_update_time = 0.0
        if (now - self._last_activation_mem_update_time) >= timedelta(
                seconds=self.act_mem_update_interval
        ):
            # TODO: not implemented
            self.update_activation_memory(
                new_memories=current_activation_mem,
                mem_cube=mem_cube
            )
            self._last_activation_mem_update_time = now

    def process_session_turn(self, queries: str|List[str],
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
        if isinstance(queries, str):
            queries = [queries]

        if query_history is None:
            query_history = queries
        else:
            query_history.extend(queries)

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
                queries=queries,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                original_memory=working_memory,
                new_memory=new_candidates,
                top_k=top_k
            )
            logger.debug(f"size of new_order_working_memory: {len(new_order_working_memory)}")




