import queue
import threading
import time

from datetime import datetime
from pathlib import Path

from sqlalchemy.engine import Engine

from memos.configs.mem_scheduler import AuthConfig, BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.general_modules.misc import AutoDroppingQueue as Queue
from memos.mem_scheduler.general_modules.scheduler_logger import SchedulerLoggerModule
from memos.mem_scheduler.memory_manage_modules.retriever import SchedulerRetriever
from memos.mem_scheduler.monitors.dispatcher_monitor import SchedulerDispatcherMonitor
from memos.mem_scheduler.monitors.general_monitor import SchedulerGeneralMonitor
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_ACT_MEM_DUMP_PATH,
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_THREAD__POOL_MAX_WORKERS,
    MemCubeID,
    TreeTextMemory_SEARCH_METHOD,
    UserID,
)
from memos.mem_scheduler.schemas.message_schemas import (
    ScheduleLogForWebItem,
    ScheduleMessageItem,
)
from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorItem
from memos.mem_scheduler.utils.filter_utils import (
    transform_name_to_key,
)
from memos.mem_scheduler.webservice_modules.rabbitmq_service import RabbitMQSchedulerModule
from memos.mem_scheduler.webservice_modules.redis_service import RedisSchedulerModule
from memos.memories.activation.kv import KVCacheMemory
from memos.memories.activation.vllmkv import VLLMKVCacheItem, VLLMKVCacheMemory
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.templates.mem_scheduler_prompts import MEMORY_ASSEMBLY_TEMPLATE


logger = get_logger(__name__)


class BaseScheduler(RabbitMQSchedulerModule, RedisSchedulerModule, SchedulerLoggerModule):
    """Base class for all mem_scheduler."""

    def __init__(self, config: BaseSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__()
        self.config = config

        # hyper-parameters
        self.top_k = self.config.get("top_k", 10)
        self.context_window_size = self.config.get("context_window_size", 5)
        self.enable_activation_memory = self.config.get("enable_activation_memory", False)
        self.act_mem_dump_path = self.config.get("act_mem_dump_path", DEFAULT_ACT_MEM_DUMP_PATH)
        self.search_method = TreeTextMemory_SEARCH_METHOD
        self.enable_parallel_dispatch = self.config.get("enable_parallel_dispatch", False)
        self.thread_pool_max_workers = self.config.get(
            "thread_pool_max_workers", DEFAULT_THREAD__POOL_MAX_WORKERS
        )

        self.retriever: SchedulerRetriever | None = None
        self.db_engine: Engine | None = None
        self.monitor: SchedulerGeneralMonitor | None = None
        self.dispatcher_monitor: SchedulerDispatcherMonitor | None = None
        self.dispatcher = SchedulerDispatcher(
            max_workers=self.thread_pool_max_workers,
            enable_parallel_dispatch=self.enable_parallel_dispatch,
        )

        # internal message queue
        self.max_internal_message_queue_size = self.config.get(
            "max_internal_message_queue_size", 100
        )
        self.memos_message_queue: Queue[ScheduleMessageItem] = Queue(
            maxsize=self.max_internal_message_queue_size
        )
        self.max_web_log_queue_size = self.config.get("max_web_log_queue_size", 50)
        self._web_log_message_queue: Queue[ScheduleLogForWebItem] = Queue(
            maxsize=self.max_web_log_queue_size
        )
        self._consumer_thread = None  # Reference to our consumer thread
        self._running = False
        self._consume_interval = self.config.get(
            "consume_interval_seconds", DEFAULT_CONSUME_INTERVAL_SECONDS
        )

        # other attributes
        self._context_lock = threading.Lock()
        self.current_user_id: UserID | str | None = None
        self.current_mem_cube_id: MemCubeID | str | None = None
        self.current_mem_cube: GeneralMemCube | None = None
        self.auth_config_path: str | Path | None = self.config.get("auth_config_path", None)
        self.auth_config = None
        self.rabbitmq_config = None

    def initialize_modules(
        self,
        chat_llm: BaseLLM,
        process_llm: BaseLLM | None = None,
        db_engine: Engine | None = None,
    ):
        if process_llm is None:
            process_llm = chat_llm

        try:
            # initialize submodules
            self.chat_llm = chat_llm
            self.process_llm = process_llm
            self.db_engine = db_engine
            self.monitor = SchedulerGeneralMonitor(
                process_llm=self.process_llm, config=self.config, db_engine=self.db_engine
            )
            self.db_engine = self.monitor.db_engine
            self.dispatcher_monitor = SchedulerDispatcherMonitor(config=self.config)
            self.retriever = SchedulerRetriever(process_llm=self.process_llm, config=self.config)

            if self.enable_parallel_dispatch:
                self.dispatcher_monitor.initialize(dispatcher=self.dispatcher)
                self.dispatcher_monitor.start()

            # initialize with auth_config
            if self.auth_config_path is not None and Path(self.auth_config_path).exists():
                self.auth_config = AuthConfig.from_local_config(config_path=self.auth_config_path)
            elif AuthConfig.default_config_exists():
                self.auth_config = AuthConfig.from_local_config()
            else:
                self.auth_config = AuthConfig.from_local_env()

            if self.auth_config is not None:
                self.rabbitmq_config = self.auth_config.rabbitmq
                self.initialize_rabbitmq(config=self.rabbitmq_config)

            logger.debug("GeneralScheduler has been initialized")
        except Exception as e:
            logger.error(f"Failed to initialize scheduler modules: {e}", exc_info=True)
            # Clean up any partially initialized resources
            self._cleanup_on_init_failure()
            raise

    def _cleanup_on_init_failure(self):
        """Clean up resources if initialization fails."""
        try:
            if hasattr(self, "dispatcher_monitor") and self.dispatcher_monitor is not None:
                self.dispatcher_monitor.stop()
        except Exception as e:
            logger.warning(f"Error during cleanup: {e}")

    @property
    def mem_cube(self) -> GeneralMemCube:
        """The memory cube associated with this MemChat."""
        return self.current_mem_cube

    @mem_cube.setter
    def mem_cube(self, value: GeneralMemCube) -> None:
        """The memory cube associated with this MemChat."""
        self.current_mem_cube = value
        self.retriever.mem_cube = value

    def _set_current_context_from_message(self, msg: ScheduleMessageItem) -> None:
        """Update current user/cube context from the incoming message (thread-safe)."""
        with self._context_lock:
            self.current_user_id = msg.user_id
            self.current_mem_cube_id = msg.mem_cube_id
            self.current_mem_cube = msg.mem_cube

    def transform_working_memories_to_monitors(
        self, query_keywords, memories: list[TextualMemoryItem]
    ) -> list[MemoryMonitorItem]:
        """
        Convert a list of TextualMemoryItem objects into MemoryMonitorItem objects
        with importance scores based on keyword matching.

        Args:
            memories: List of TextualMemoryItem objects to be transformed.

        Returns:
            List of MemoryMonitorItem objects with computed importance scores.
        """

        result = []
        mem_length = len(memories)
        for idx, mem in enumerate(memories):
            text_mem = mem.memory
            mem_key = transform_name_to_key(name=text_mem)

            # Calculate importance score based on keyword matches
            keywords_score = 0
            if query_keywords and text_mem:
                for keyword, count in query_keywords.items():
                    keyword_count = text_mem.count(keyword)
                    if keyword_count > 0:
                        keywords_score += keyword_count * count
                        logger.debug(
                            f"Matched keyword '{keyword}' {keyword_count} times, added {keywords_score} to keywords_score"
                        )

            # rank score
            sorting_score = mem_length - idx

            mem_monitor = MemoryMonitorItem(
                memory_text=text_mem,
                tree_memory_item=mem,
                tree_memory_item_mapping_key=mem_key,
                sorting_score=sorting_score,
                keywords_score=keywords_score,
                recording_count=1,
            )
            result.append(mem_monitor)

        logger.info(f"Transformed {len(result)} memories to monitors")
        return result

    def replace_working_memory(
        self,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube: GeneralMemCube,
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
    ) -> None | list[TextualMemoryItem]:
        """Replace working memory with new memories after reranking."""
        text_mem_base = mem_cube.text_mem
        if isinstance(text_mem_base, TreeTextMemory):
            text_mem_base: TreeTextMemory = text_mem_base

            # process rerank memories with llm
            query_db_manager = self.monitor.query_monitors[user_id][mem_cube_id]
            # Sync with database to get latest query history
            query_db_manager.sync_with_orm()

            query_history = query_db_manager.obj.get_queries_with_timesort()
            memories_with_new_order, rerank_success_flag = (
                self.retriever.process_and_rerank_memories(
                    queries=query_history,
                    original_memory=original_memory,
                    new_memory=new_memory,
                    top_k=self.top_k,
                )
            )

            # Filter completely unrelated memories according to query_history
            logger.info(f"Filtering memories based on query history: {len(query_history)} queries")
            filtered_memories, filter_success_flag = self.retriever.filter_unrelated_memories(
                query_history=query_history,
                memories=memories_with_new_order,
            )

            if filter_success_flag:
                logger.info(
                    f"Memory filtering completed successfully. "
                    f"Filtered from {len(memories_with_new_order)} to {len(filtered_memories)} memories"
                )
                memories_with_new_order = filtered_memories
            else:
                logger.warning(
                    "Memory filtering failed - keeping all memories as fallback. "
                    f"Original count: {len(memories_with_new_order)}"
                )

            # Update working memory monitors
            query_keywords = query_db_manager.obj.get_keywords_collections()
            logger.info(
                f"Processing {len(memories_with_new_order)} memories with {len(query_keywords)} query keywords"
            )
            new_working_memory_monitors = self.transform_working_memories_to_monitors(
                query_keywords=query_keywords,
                memories=memories_with_new_order,
            )

            if not rerank_success_flag:
                for one in new_working_memory_monitors:
                    one.sorting_score = 0

            logger.info(f"update {len(new_working_memory_monitors)} working_memory_monitors")
            self.monitor.update_working_memory_monitors(
                new_working_memory_monitors=new_working_memory_monitors,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
            )

            mem_monitors: list[MemoryMonitorItem] = self.monitor.working_memory_monitors[user_id][
                mem_cube_id
            ].obj.get_sorted_mem_monitors(reverse=True)
            new_working_memories = [mem_monitor.tree_memory_item for mem_monitor in mem_monitors]

            text_mem_base.replace_working_memory(memories=new_working_memories)

            logger.info(
                f"The working memory has been replaced with {len(memories_with_new_order)} new memories."
            )
            self.log_working_memory_replacement(
                original_memory=original_memory,
                new_memory=new_working_memories,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                log_func_callback=self._submit_web_logs,
            )
        else:
            logger.error("memory_base is not supported")
            memories_with_new_order = new_memory

        return memories_with_new_order

    def update_activation_memory(
        self,
        new_memories: list[str | TextualMemoryItem],
        label: str,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
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
            return

        try:
            if isinstance(mem_cube.act_mem, VLLMKVCacheMemory):
                act_mem: VLLMKVCacheMemory = mem_cube.act_mem
            elif isinstance(mem_cube.act_mem, KVCacheMemory):
                act_mem: KVCacheMemory = mem_cube.act_mem
            else:
                logger.error("Not Implemented.")
                return

            new_text_memory = MEMORY_ASSEMBLY_TEMPLATE.format(
                memory_text="".join(
                    [
                        f"{i + 1}. {sentence.strip()}\n"
                        for i, sentence in enumerate(new_text_memories)
                        if sentence.strip()  # Skip empty strings
                    ]
                )
            )

            # huggingface or vllm kv cache
            original_cache_items: list[VLLMKVCacheItem] = act_mem.get_all()
            original_text_memories = []
            if len(original_cache_items) > 0:
                pre_cache_item: VLLMKVCacheItem = original_cache_items[-1]
                original_text_memories = pre_cache_item.records.text_memories
                original_composed_text_memory = pre_cache_item.records.composed_text_memory
                if original_composed_text_memory == new_text_memory:
                    logger.warning(
                        "Skipping memory update - new composition matches existing cache: %s",
                        new_text_memory[:50] + "..."
                        if len(new_text_memory) > 50
                        else new_text_memory,
                    )
                    return
                act_mem.delete_all()

            cache_item = act_mem.extract(new_text_memory)
            cache_item.records.text_memories = new_text_memories
            cache_item.records.timestamp = datetime.utcnow()

            act_mem.add([cache_item])
            act_mem.dump(self.act_mem_dump_path)

            self.log_activation_memory_update(
                original_text_memories=original_text_memories,
                new_text_memories=new_text_memories,
                label=label,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                log_func_callback=self._submit_web_logs,
            )

        except Exception as e:
            logger.error(f"MOS-based activation memory update failed: {e}", exc_info=True)
            # Re-raise the exception if it's critical for the operation
            # For now, we'll continue execution but this should be reviewed

    def update_activation_memory_periodically(
        self,
        interval_seconds: int,
        label: str,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube: GeneralMemCube,
    ):
        try:
            if (
                self.monitor.last_activation_mem_update_time == datetime.min
                or self.monitor.timed_trigger(
                    last_time=self.monitor.last_activation_mem_update_time,
                    interval_seconds=interval_seconds,
                )
            ):
                logger.info(
                    f"Updating activation memory for user {user_id} and mem_cube {mem_cube_id}"
                )

                if (
                    user_id not in self.monitor.working_memory_monitors
                    or mem_cube_id not in self.monitor.working_memory_monitors[user_id]
                    or len(self.monitor.working_memory_monitors[user_id][mem_cube_id].obj.memories)
                    == 0
                ):
                    logger.warning(
                        "No memories found in working_memory_monitors, activation memory update is skipped"
                    )
                    return

                self.monitor.update_activation_memory_monitors(
                    user_id=user_id, mem_cube_id=mem_cube_id, mem_cube=mem_cube
                )

                # Sync with database to get latest activation memories
                activation_db_manager = self.monitor.activation_memory_monitors[user_id][
                    mem_cube_id
                ]
                activation_db_manager.sync_with_orm()
                new_activation_memories = [
                    m.memory_text for m in activation_db_manager.obj.memories
                ]

                logger.info(
                    f"Collected {len(new_activation_memories)} new memory entries for processing"
                )
                # Print the content of each new activation memory
                for i, memory in enumerate(new_activation_memories[:5], 1):
                    logger.info(
                        f"Part of New Activation Memorires | {i}/{len(new_activation_memories)}: {memory[:20]}"
                    )

                self.update_activation_memory(
                    new_memories=new_activation_memories,
                    label=label,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                )

                self.monitor.last_activation_mem_update_time = datetime.utcnow()

                logger.debug(
                    f"Activation memory update completed at {self.monitor.last_activation_mem_update_time}"
                )

            else:
                logger.info(
                    f"Skipping update - {interval_seconds} second interval not yet reached. "
                    f"Last update time is {self.monitor.last_activation_mem_update_time} and now is"
                    f"{datetime.utcnow()}"
                )
        except Exception as e:
            logger.error(f"Error in update_activation_memory_periodically: {e}", exc_info=True)

    def submit_messages(self, messages: ScheduleMessageItem | list[ScheduleMessageItem]):
        """Submit multiple messages to the message queue."""
        if isinstance(messages, ScheduleMessageItem):
            messages = [messages]  # transform single message to list

        for message in messages:
            if not isinstance(message, ScheduleMessageItem):
                error_msg = f"Invalid message type: {type(message)}, expected ScheduleMessageItem"
                logger.error(error_msg)
                raise TypeError(error_msg)

            self.memos_message_queue.put(message)
            logger.info(f"Submitted message: {message.label} - {message.content}")

    def _submit_web_logs(
        self, messages: ScheduleLogForWebItem | list[ScheduleLogForWebItem]
    ) -> None:
        """Submit log messages to the web log queue and optionally to RabbitMQ.

        Args:
            messages: Single log message or list of log messages
        """
        if isinstance(messages, ScheduleLogForWebItem):
            messages = [messages]  # transform single message to list

        for message in messages:
            if not isinstance(message, ScheduleLogForWebItem):
                error_msg = f"Invalid message type: {type(message)}, expected ScheduleLogForWebItem"
                logger.error(error_msg)
                raise TypeError(error_msg)

            self._web_log_message_queue.put(message)
            message_info = message.debug_info()
            logger.debug(f"Submitted Scheduling log for web: {message_info}")

            if self.is_rabbitmq_connected():
                logger.info(f"Submitted Scheduling log to rabbitmq: {message_info}")
                self.rabbitmq_publish_message(message=message.to_dict())
        logger.debug(f"{len(messages)} submitted. {self._web_log_message_queue.qsize()} in queue.")

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
                # Get all available messages at once (thread-safe approach)
                messages = []
                while True:
                    try:
                        # Use get_nowait() directly without empty() check to avoid race conditions
                        message = self.memos_message_queue.get_nowait()
                        messages.append(message)
                    except queue.Empty:
                        # No more messages available
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
            logger.info(
                f"Initializing dispatcher thread pool with {self.thread_pool_max_workers} workers"
            )

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
        if self.dispatcher:
            logger.info("Shutting down dispatcher...")
            self.dispatcher.shutdown()

        # Shutdown dispatcher_monitor
        if self.dispatcher_monitor:
            logger.info("Shutting down monitor...")
            self.dispatcher_monitor.stop()

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
