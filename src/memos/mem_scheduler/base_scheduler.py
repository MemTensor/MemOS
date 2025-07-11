import queue
import threading
import time
from abc import abstractmethod
from queue import Queue
from typing import TYPE_CHECKING, List

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.modules.rabbitmq_service import RabbitMQSchedulerModule
from memos.mem_scheduler.modules.redis_service import RedisSchedulerModule
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.memories.activation.kv import KVCacheMemory, KVCacheItem
from memos.mem_scheduler.modules.monitor import SchedulerMonitor
from memos.mem_scheduler.modules.retriever import SchedulerRetriever
from memos.mem_scheduler.modules.schemas import (
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_THREAD__POOL_MAX_WORKERS,
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

if TYPE_CHECKING:
    from pathlib import Path


logger = get_logger(__name__)


class BaseScheduler(RabbitMQSchedulerModule, RedisSchedulerModule):
    """Base class for all mem_scheduler."""

    def __init__(self, config: BaseSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__()
        self.config = config
        self.max_workers = self.config.get(
            "thread_pool_max_workers", DEFAULT_THREAD__POOL_MAX_WORKERS
        )
        self.retriever: SchedulerRetriever|None = None
        self.monitor: SchedulerMonitor|None = None
        self.enable_parallel_dispatch = self.config.get("enable_parallel_dispatch", False)
        self.dispatcher = SchedulerDispatcher(
            max_workers=self.max_workers, enable_parallel_dispatch=self.enable_parallel_dispatch
        )

        # message queue
        self.memos_message_queue: Queue[ScheduleMessageItem] = Queue()
        self._web_log_message_queue: Queue[ScheduleLogForWebItem] = Queue()
        self._consumer_thread = None  # Reference to our consumer thread
        self._running = False
        self._consume_interval = self.config.get(
            "consume_interval_seconds", DEFAULT_CONSUME_INTERVAL_SECONDS
        )

        # others
        self._current_user_id: str | None = None
        self.auth_config_path: str | Path | None = self.config.get("auth_config_path", None)
        self.auth_config = None
        self.rabbitmq_config = None

    @abstractmethod
    def initialize_modules(self, chat_llm: BaseLLM) -> None:
        """Initialize all necessary modules for the scheduler

        Args:
            chat_llm: The LLM instance to be used for chat interactions
        """

    @property
    def mem_cube(self) -> GeneralMemCube:
        """The memory cube associated with this MemChat."""
        return self._current_mem_cube

    @mem_cube.setter
    def mem_cube(self, value: GeneralMemCube) -> None:
        """The memory cube associated with this MemChat."""
        self._current_mem_cube = value
        self.retriever.mem_cube = value

    def _set_current_context_from_message(self, msg: ScheduleMessageItem) -> None:
        """Update current user/cube context from the incoming message."""
        self._current_user_id = msg.user_id
        self._current_mem_cube_id = msg.mem_cube_id
        self._current_mem_cube = msg.mem_cube

    def _validate_message(self, message: ScheduleMessageItem, label: str):
        """Validate if the message matches the expected label.

        Args:
            message: Incoming message item to validate.
            label: Expected message label (e.g., QUERY_LABEL/ANSWER_LABEL).

        Returns:
            bool: True if validation passed, False otherwise.
        """
        if message.label != label:
            logger.error(f"Handler validation failed: expected={label}, actual={message.label}")
            return False
        return True

    def submit_messages(self, messages: ScheduleMessageItem | list[ScheduleMessageItem]):
        """Submit multiple messages to the message queue."""
        if isinstance(messages, ScheduleMessageItem):
            messages = [messages]  # transform single message to list

        for message in messages:
            self.memos_message_queue.put(message)
            logger.info(f"Submitted message: {message.label} - {message.content}")

    def _submit_web_logs(self, messages: ScheduleLogForWebItem | list[ScheduleLogForWebItem]):
        """Submit log messages to the web log queue and optionally to RabbitMQ.

        Args:
            messages: Single log message or list of log messages
        """
        if isinstance(messages, ScheduleLogForWebItem):
            messages = [messages]  # transform single message to list

        for message in messages:
            self._web_log_message_queue.put(message)
            logger.info(
                f"Submitted Scheduling log for web: {message.log_title} - {message.log_content}"
            )

            if self.is_rabbitmq_connected():
                logger.info("Submitted Scheduling log to rabbitmq")
                self.rabbitmq_publish_message(message=message.to_dict())
        logger.debug(f"{len(messages)} submitted. {self._web_log_message_queue.qsize()} in queue.")

    def search(self, query: str, top_k: int, method=TreeTextMemory_SEARCH_METHOD):
        """Search in text memory with the given query.

        Args:
            query: The search query string
            top_k: Number of top results to return
            method: Search method to use

        Returns:
            Search results or None if not implemented
        """
        text_mem_base = self.mem_cube.text_mem
        if isinstance(text_mem_base, TreeTextMemory) and method == TextMemory_SEARCH_METHOD:
            results_long_term = text_mem_base.search(
                query=query, top_k=top_k, memory_type="LongTermMemory"
            )
            results_user = text_mem_base.search(query=query, top_k=top_k, memory_type="UserMemory")
            results = results_long_term + results_user
        else:
            logger.error("Not implemented.")
            results = None
        return results

    def _log_activation_memory_update(
            self,
            original_text_memories: List[str],
            new_text_memories: List[str]
       ):
        """Log changes when activation memory is updated.

        Args:
            original_text_memories: List of original memory texts
            new_text_memories: List of new memory texts
        """
        original_set = set(original_text_memories)
        new_set = set(new_text_memories)

        # Identify changes
        added_memories = list(new_set - original_set)  # Present in new but not original

        # recording messages
        for mem in added_memories:
            log_message = self.create_autofilled_log_item(
                log_content=mem,
                label=QUERY_LABEL,
                from_memory_type=WORKING_MEMORY_TYPE,
                to_memory_type=ACTIVATION_MEMORY_TYPE,
            )
            self._submit_web_logs(messages=log_message)
            logger.info(f"{len(added_memories)} {LONG_TERM_MEMORY_TYPE} memorie(s) "
                        f"transformed to {WORKING_MEMORY_TYPE} memories.")

    def replace_working_memory(
            self,
            original_memory: List[TextualMemoryItem],
            new_memory: List[TextualMemoryItem],
            top_k: int = 10,
    ) -> None | list[TextualMemoryItem]:
        """Replace working memory with new memories after reranking.
        """
        new_order_memory = None
        text_mem_base = self.mem_cube.text_mem
        if isinstance(text_mem_base, TreeTextMemory):
            text_mem_base: TreeTextMemory = text_mem_base
            combined_text_memory = [new_m.memory for new_m in original_memory] + [
                new_m.memory for new_m in new_memory
            ]
            combined_memory = original_memory + new_memory
            memory_map = {mem_obj.memory: mem_obj for mem_obj in combined_memory}

            unique_memory = list(dict.fromkeys(combined_text_memory))
            prompt = self.build_prompt(
                "memory_reranking",
                query="",
                current_order=unique_memory,
                staging_buffer=[],
            )
            response = self.chat_llm.generate([{"role": "user", "content": prompt}])
            response = json.loads(response)
            new_order_text_memory = response.get("new_order", [])[:top_k]

            new_order_memory = []
            for text in new_order_text_memory:
                if text in memory_map:
                    new_order_memory.append(memory_map[text])
                else:
                    logger.warning(
                        f"Memory text not found in memory map. text: {text}; memory_map: {memory_map}"
                    )

            text_mem_base.replace_working_memory(new_order_memory[:top_k])
            new_order_memory = new_order_memory[:top_k]
            logger.info(
                f"The working memory has been replaced with {len(new_order_memory)} new memories."
            )
            self._log_working_memory_replacement(original_memory=original_memory, new_memory=new_memory)
        else:
            logger.error("memory_base is not supported")

        return new_order_memory

    def _log_working_memory_replacement(
            self,
            original_memory: List[TextualMemoryItem],
            new_memory: List[TextualMemoryItem]
    ):
        """Log changes when working memory is replaced.

        Args:
            original_memory: Original memory items
            new_memory: New memory items
        """
        memory_type_map = {m.memory: m.metadata.memory_type for m in original_memory+new_memory}

        original_text_memories = [m.memory for m in original_memory]
        new_text_memories = [m.memory for m in new_memory]


        # Convert to sets for efficient difference operations
        original_set = set(original_text_memories)
        new_set = set(new_text_memories)

        # Identify changes
        added_memories = list(new_set - original_set)  # Present in new but not original

        # recording messages
        for mem in added_memories:
            if mem not in memory_type_map:
                logger.error(f"Memory text not found in type mapping: {memory_text[:50]}...")
            # Get the memory type from the map, default to LONG_TERM_MEMORY_TYPE if not found
            mem_type = memory_type_map.get(mem, LONG_TERM_MEMORY_TYPE)

            if mem_type == WORKING_MEMORY_TYPE:
                logger.warning(f"Memory already in working memory: {memory_text[:50]}...")
                continue

            log_message = self.create_autofilled_log_item(
                log_content=mem,
                label=QUERY_LABEL,
                from_memory_type=mem_type,
                to_memory_type=WORKING_MEMORY_TYPE,
            )
            self._submit_web_logs(messages=log_message)
            logger.info(f"{len(added_memories)} {LONG_TERM_MEMORY_TYPE} memorie(s) "
                        f"transformed to {WORKING_MEMORY_TYPE} memories.")

    def update_activation_memory(self, new_memories: list[str | TextualMemoryItem]) -> None:
        """
        Update activation memory by extracting KVCacheItems from new_memory (list of str),
        add them to a KVCacheMemory instance, and dump to disk.
        """
        # TODO: The function of update activation memory is waiting to test
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
            assert isinstance(self.mem_cube.act_mem, KVCacheMemory)
            act_mem: KVCacheMemory = self.mem_cube.act_mem

            text_memory = MEMORY_ASSEMBLY_TEMPLATE.format(
                memory_text="".join(
                    [
                        f"{i + 1}. {sentence.strip()}\n"
                        for i, sentence in enumerate(new_text_memories)
                        if sentence.strip()  # Skip empty strings
                    ]
                )
            )
            original_cache_items: List[KVCacheItem] = act_mem.get_all()
            pre_cache_item: KVCacheItem = origin_cache_items[-1]
            original_text_memories = pre_cache_item.records.text_memories
            act_mem.delete_all()
            cache_item: KVCacheItem = act_mem.extract(text_memory)
            cache_item.records.text_memories = new_text_memories

            act_mem.add(cache_item)
            act_mem.dump(self.act_mem_dump_path)

            self._log_activation_memory_update(original_text_memories=original_text_memories,
                                               new_text_memories=new_text_memories)
        except Exception as e:
            logger.warning(f"MOS-based activation memory update failed: {e}")

    def create_autofilled_log_item(
        self,
        log_content: str,
        label: str,
        from_memory_type: str,
        to_memory_type: str,
    ) -> ScheduleLogForWebItem:
        text_mem_base: TreeTextMemory = self.mem_cube.text_mem
        current_memory_sizes = text_mem_base.get_current_memory_size()
        current_memory_sizes = {
            "long_term_memory_size": current_memory_sizes["LongTermMemory"],
            "user_memory_size": current_memory_sizes["UserMemory"],
            "working_memory_size": current_memory_sizes["WorkingMemory"],
            "transformed_act_memory_size": NOT_INITIALIZED,
            "parameter_memory_size": NOT_INITIALIZED,
        }
        memory_capacities = {
            "long_term_memory_capacity": text_mem_base.memory_manager.memory_size["LongTermMemory"],
            "user_memory_capacity": text_mem_base.memory_manager.memory_size["UserMemory"],
            "working_memory_capacity": text_mem_base.memory_manager.memory_size["WorkingMemory"],
            "transformed_act_memory_capacity": NOT_INITIALIZED,
            "parameter_memory_capacity": NOT_INITIALIZED,
        }

        log_message = ScheduleLogForWebItem(
            user_id=self._current_user_id,
            mem_cube_id=self._current_mem_cube_id,
            label=label,
            from_memory_type=from_memory_type,
            to_memory_type=to_memory_type,
            log_content=log_content,
            current_memory_sizes=current_memory_sizes,
            memory_capacities=memory_capacities,
        )
        return log_message


    def get_web_log_messages(self) -> list[dict]:
        """
        Retrieves all web log messages from the queue and returns them as a list of JSON-serializable dictionaries.

        Returns:
            List[dict]: A list of dictionaries representing ScheduleLogForWebItem objects,
                       ready for JSON serialization. The list is ordered from oldest to newest.
        """
        messages = []

        # Process all items in the queue
        while not self._web_log_message_queue.empty():
            item = self._web_log_message_queue.get()
            # Convert the ScheduleLogForWebItem to a dictionary and ensure datetime is serialized
            item_dict = item.to_dict()
            messages.append(item_dict)
        return messages

    def _message_consumer(self) -> None:
        """
        Continuously checks the queue for messages and dispatches them.

        Runs in a dedicated thread to process messages at regular intervals.
        """
        while self._running:  # Use a running flag for graceful shutdown
            try:
                # Check if queue has messages (non-blocking)
                if not self.memos_message_queue.empty():
                    # Get all available messages at once
                    messages = []
                    while not self.memos_message_queue.empty():
                        try:
                            messages.append(self.memos_message_queue.get_nowait())
                        except queue.Empty:
                            break

                    if messages:
                        try:
                            self.dispatcher.dispatch(messages)
                        except Exception as e:
                            logger.error(f"Error dispatching messages: {e!s}")
                        finally:
                            # Mark all messages as processed
                            for _ in messages:
                                self.memos_message_queue.task_done()

                # Sleep briefly to prevent busy waiting
                time.sleep(self._consume_interval)  # Adjust interval as needed

            except Exception as e:
                logger.error(f"Unexpected error in message consumer: {e!s}")
                time.sleep(self._consume_interval)  # Prevent tight error loops

    def start(self) -> None:
        """
        Start the message consumer thread.

        Initializes and starts a daemon thread that will periodically
        check for and process messages from the queue.
        """
        if self._consumer_thread is not None and self._consumer_thread.is_alive():
            logger.warning("Consumer thread is already running")
            return

        self._running = True
        self._consumer_thread = threading.Thread(
            target=self._message_consumer,
            daemon=True,  # Allows program to exit even if thread is running
            name="MessageConsumerThread",
        )
        self._consumer_thread.start()
        logger.info("Message consumer thread started")

    def stop(self) -> None:
        """Stop the consumer thread and clean up resources."""
        if self._consumer_thread is None or not self._running:
            logger.warning("Consumer thread is not running")
            return
        self._running = False
        if self._consumer_thread.is_alive():
            self._consumer_thread.join(timeout=5.0)  # Wait up to 5 seconds
            if self._consumer_thread.is_alive():
                logger.warning("Consumer thread did not stop gracefully")
        logger.info("Message consumer thread stopped")
