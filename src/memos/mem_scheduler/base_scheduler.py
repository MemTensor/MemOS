import queue
import threading
import time

from datetime import datetime
from pathlib import Path

from memos.configs.mem_scheduler import AuthConfig, BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.modules.misc import AutoDroppingQueue as Queue
from memos.mem_scheduler.modules.monitor import SchedulerMonitor
from memos.mem_scheduler.modules.rabbitmq_service import RabbitMQSchedulerModule
from memos.mem_scheduler.modules.redis_service import RedisSchedulerModule
from memos.mem_scheduler.modules.retriever import SchedulerRetriever
from memos.mem_scheduler.modules.schemas import (
    ACTIVATION_MEMORY_TYPE,
    ACTIVATION_MEMORY_VLLM_BACKEND,
    ADD_LABEL,
    DEFAULT_ACT_MEM_DUMP_PATH,
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_THREAD__POOL_MAX_WORKERS,
    LONG_TERM_MEMORY_TYPE,
    NOT_INITIALIZED,
    QUERY_LABEL,
    TEXT_MEMORY_TYPE,
    USER_INPUT_TYPE,
    WORKING_MEMORY_TYPE,
    ScheduleLogForWebItem,
    ScheduleMessageItem,
    TreeTextMemory_SEARCH_METHOD,
)
from memos.mem_scheduler.utils import normalize_name
from memos.memories.activation.kv import KVCacheItem, KVCacheMemory
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.templates.mem_scheduler_prompts import MEMORY_ASSEMBLY_TEMPLATE


logger = get_logger(__name__)


class BaseScheduler(RabbitMQSchedulerModule, RedisSchedulerModule):
    """Base class for all mem_scheduler."""

    def __init__(self, config: BaseSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__()
        self.config = config

        # hyper-parameters
        self.top_k = self.config.get("top_k", 5)
        self.context_window_size = self.config.get("context_window_size", 5)
        self.enable_act_memory_update = self.config.get("enable_act_memory_update", False)
        self.act_mem_dump_path = self.config.get("act_mem_dump_path", DEFAULT_ACT_MEM_DUMP_PATH)
        self.search_method = TreeTextMemory_SEARCH_METHOD

        self.enable_parallel_dispatch = self.config.get("enable_parallel_dispatch", False)
        self.max_workers = self.config.get(
            "thread_pool_max_workers", DEFAULT_THREAD__POOL_MAX_WORKERS
        )

        self.retriever: SchedulerRetriever | None = None
        self.monitor: SchedulerMonitor | None = None

        self.dispatcher = SchedulerDispatcher(
            max_workers=self.max_workers, enable_parallel_dispatch=self.enable_parallel_dispatch
        )

        # internal message queue
        self.max_internal_messae_queue_size = 100
        self.memos_message_queue: Queue[ScheduleMessageItem] = Queue(
            maxsize=self.max_internal_messae_queue_size
        )
        self._web_log_message_queue: Queue[ScheduleLogForWebItem] = Queue(
            maxsize=self.max_internal_messae_queue_size
        )
        self._consumer_thread = None  # Reference to our consumer thread
        self._running = False
        self._consume_interval = self.config.get(
            "consume_interval_seconds", DEFAULT_CONSUME_INTERVAL_SECONDS
        )

        # other attributes
        self._context_lock = threading.Lock()
        self._current_user_id: str | None = None
        self.auth_config_path: str | Path | None = self.config.get("auth_config_path", None)
        self.auth_config = None
        self.rabbitmq_config = None
        self.act_mem_backend = ACTIVATION_MEMORY_VLLM_BACKEND

    def initialize_modules(self, chat_llm: BaseLLM, process_llm: BaseLLM | None = None):
        if process_llm is None:
            process_llm = chat_llm

        # initialize submodules
        self.chat_llm = chat_llm
        self.process_llm = process_llm
        self.monitor = SchedulerMonitor(process_llm=self.process_llm, config=self.config)
        self.retriever = SchedulerRetriever(process_llm=self.process_llm, config=self.config)
        self.retriever.log_working_memory_replacement = self.log_working_memory_replacement

        # initialize with auth_cofig
        if self.auth_config_path is not None and Path(self.auth_config_path).exists():
            self.auth_config = AuthConfig.from_local_yaml(config_path=self.auth_config_path)
        elif AuthConfig.default_config_exists():
            self.auth_config = AuthConfig.from_local_yaml()
        else:
            self.auth_config = None

        if self.auth_config is not None:
            self.rabbitmq_config = self.auth_config.rabbitmq
            self.initialize_rabbitmq(config=self.rabbitmq_config)

        logger.debug("GeneralScheduler has been initialized")

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
        """Update current user/cube context from the incoming message (thread-safe)."""
        with self._context_lock:
            self._current_user_id = msg.user_id
            self._current_mem_cube_id = msg.mem_cube_id
            self._current_mem_cube = msg.mem_cube

    def _validate_messages(self, messages: list[ScheduleMessageItem], label: str):
        """Validate if all messages match the expected label.

        Args:
            messages: List of message items to validate.
            label: Expected message label (e.g., QUERY_LABEL/ANSWER_LABEL).

        Returns:
            bool: True if all messages passed validation, False if any failed.
        """
        for message in messages:
            if not self._validate_message(message, label):
                return False
                logger.error("Message batch contains invalid labels, aborting processing")
        return True

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

    def update_activation_memory(
        self,
        new_memories: list[str | TextualMemoryItem],
        mem_cube: GeneralMemCube,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
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

            # huggingface or vllm kv cache
            original_cache_items: list[KVCacheItem] = act_mem.get_all()
            pre_cache_item: KVCacheItem = original_cache_items[-1]
            original_text_memories = pre_cache_item.records.text_memories
            act_mem.delete_all()
            cache_item: KVCacheItem = act_mem.extract(text_memory)
            cache_item.records.text_memories = new_text_memories

            act_mem.add(cache_item)
            act_mem.dump(self.act_mem_dump_path)

            self.log_activation_memory_update(
                original_text_memories=original_text_memories,
                new_text_memories=new_text_memories,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )

        except Exception as e:
            logger.warning(f"MOS-based activation memory update failed: {e}")

    def update_activation_memory_periodically(
        self,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
    ):
        new_activation_memories = []

        if self.monitor.timed_trigger(
            last_time=self.monitor._last_activation_mem_update_time,
            interval_seconds=self.monitor.act_mem_update_interval,
        ):
            self.monitor.update_memory_monitors(
                user_id=user_id, mem_cube_id=mem_cube_id, mem_cube=mem_cube
            )

            new_activation_memories = [
                m.memory_text for m in self.monitor.activation_memory_monitors[user_id][mem_cube_id]
            ]

            self.update_activation_memory(new_memories=new_activation_memories, mem_cube=mem_cube)

            self.monitor._last_activation_mem_update_time = datetime.now()

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
            logger.info(f"Submitted Scheduling log for web: {message.log_content}")
            logger.info(f"Submitted Scheduling log for web: {message.log_content}")
            if self.is_rabbitmq_connected():
                logger.info("Submitted Scheduling log to rabbitmq")
                self.rabbitmq_publish_message(message=message.to_dict())
        logger.debug(f"{len(messages)} submitted. {self._web_log_message_queue.qsize()} in queue.")

    def log_activation_memory_update(
        self,
        original_text_memories: list[str],
        new_text_memories: list[str],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
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
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
            self._submit_web_logs(messages=log_message)
            logger.info(
                f"{len(added_memories)} {LONG_TERM_MEMORY_TYPE} memorie(s) "
                f"transformed to {WORKING_MEMORY_TYPE} memories."
            )

    def log_working_memory_replacement(
        self,
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
    ):
        """Log changes when working memory is replaced."""
        memory_type_map = {
            normalize_name(text=m.memory): m.metadata.memory_type
            for m in original_memory + new_memory
        }

        original_text_memories = [m.memory for m in original_memory]
        new_text_memories = [m.memory for m in new_memory]

        # Convert to sets for efficient difference operations
        original_set = set(original_text_memories)
        new_set = set(new_text_memories)

        # Identify changes
        added_memories = list(new_set - original_set)  # Present in new but not original

        # recording messages
        for mem in added_memories:
            normalized_mem = normalize_name(text=mem)
            if normalized_mem not in memory_type_map:
                logger.error(f"Memory text not found in type mapping: {mem[:50]}...")
            # Get the memory type from the map, default to LONG_TERM_MEMORY_TYPE if not found
            mem_type = memory_type_map.get(normalized_mem, LONG_TERM_MEMORY_TYPE)

            if mem_type == WORKING_MEMORY_TYPE:
                logger.warning(f"Memory already in working memory: {mem[:50]}...")
                continue

            log_message = self.create_autofilled_log_item(
                log_content=mem,
                label=QUERY_LABEL,
                from_memory_type=mem_type,
                to_memory_type=WORKING_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
            self._submit_web_logs(messages=log_message)
            logger.info(
                f"{len(added_memories)} {LONG_TERM_MEMORY_TYPE} memorie(s) "
                f"transformed to {WORKING_MEMORY_TYPE} memories."
            )

    def log_adding_user_inputs(
        self,
        user_inputs: list[str],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
    ):
        """Log changes when working memory is replaced."""

        # recording messages
        for input_str in user_inputs:
            log_message = self.create_autofilled_log_item(
                log_content=input_str,
                label=ADD_LABEL,
                from_memory_type=USER_INPUT_TYPE,
                to_memory_type=TEXT_MEMORY_TYPE,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )
            self._submit_web_logs(messages=log_message)
            logger.info(
                f"{len(user_inputs)} {USER_INPUT_TYPE} memorie(s) "
                f"transformed to {TEXT_MEMORY_TYPE} memories."
            )

    def create_autofilled_log_item(
        self,
        log_content: str,
        label: str,
        from_memory_type: str,
        to_memory_type: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
    ) -> ScheduleLogForWebItem:
        text_mem_base: TreeTextMemory = mem_cube.text_mem
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
            user_id=user_id,
            mem_cube_id=mem_cube_id,
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
        while True:
            try:
                item = self._web_log_message_queue.get_nowait()  # 线程安全的 get
                messages.append(item.to_dict())
            except queue.Empty:
                break
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
        Start the message consumer thread and initialize dispatcher resources.

        Initializes and starts:
        1. Message consumer thread
        2. Dispatcher thread pool (if parallel dispatch enabled)
        """
        if self._running:
            logger.warning("Memory Scheduler is already running")
            return

        # Initialize dispatcher resources
        if self.enable_parallel_dispatch:
            logger.info(f"Initializing dispatcher thread pool with {self.max_workers} workers")

        # Start consumer thread
        self._running = True
        self._consumer_thread = threading.Thread(
            target=self._message_consumer,
            daemon=True,
            name="MessageConsumerThread",
        )
        self._consumer_thread.start()
        logger.info("Message consumer thread started")

    def stop(self) -> None:
        """Stop all scheduler components gracefully.

        1. Stops message consumer thread
        2. Shuts down dispatcher thread pool
        3. Cleans up resources
        """
        if not self._running:
            logger.warning("Memory Scheduler is not running")
            return

        # Signal consumer thread to stop
        self._running = False

        # Wait for consumer thread
        if self._consumer_thread and self._consumer_thread.is_alive():
            self._consumer_thread.join(timeout=5.0)
            if self._consumer_thread.is_alive():
                logger.warning("Consumer thread did not stop gracefully")
            else:
                logger.info("Consumer thread stopped")

        # Shutdown dispatcher
        if hasattr(self, "dispatcher") and self.dispatcher:
            logger.info("Shutting down dispatcher...")
            self.dispatcher.shutdown()

        # Clean up queues
        self._cleanup_queues()
        logger.info("Memory Scheduler stopped completely")

    def _cleanup_queues(self) -> None:
        """Ensure all queues are emptied and marked as closed."""
        try:
            while not self.memos_message_queue.empty():
                self.memos_message_queue.get_nowait()
                self.memos_message_queue.task_done()
        except queue.Empty:
            pass

        try:
            while not self._web_log_message_queue.empty():
                self._web_log_message_queue.get_nowait()
        except queue.Empty:
            pass
