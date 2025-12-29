import multiprocessing
import os
import threading
import time

from collections.abc import Callable
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Union

from sqlalchemy.engine import Engine

from memos.configs.mem_scheduler import AuthConfig, BaseSchedulerConfig
from memos.context.context import (
    ContextThread,
    RequestContext,
    get_current_context,
    get_current_trace_id,
    set_request_context,
)
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.base import BaseMemCube
from memos.mem_cube.general import GeneralMemCube
from memos.mem_feedback.simple_feedback import SimpleMemFeedback
from memos.mem_scheduler.general_modules.init_components_for_scheduler import init_components
from memos.mem_scheduler.general_modules.misc import AutoDroppingQueue as Queue
from memos.mem_scheduler.general_modules.scheduler_logger import SchedulerLoggerModule
from memos.mem_scheduler.memory_manage_modules.retriever import SchedulerRetriever
from memos.mem_scheduler.monitors.dispatcher_monitor import SchedulerDispatcherMonitor
from memos.mem_scheduler.monitors.general_monitor import SchedulerGeneralMonitor
from memos.mem_scheduler.monitors.task_schedule_monitor import TaskScheduleMonitor
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_ACT_MEM_DUMP_PATH,
    DEFAULT_CONSUME_BATCH,
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_CONTEXT_WINDOW_SIZE,
    DEFAULT_MAX_INTERNAL_MESSAGE_QUEUE_SIZE,
    DEFAULT_MAX_WEB_LOG_QUEUE_SIZE,
    DEFAULT_STARTUP_MODE,
    DEFAULT_THREAD_POOL_MAX_WORKERS,
    DEFAULT_TOP_K,
    DEFAULT_USE_REDIS_QUEUE,
    STARTUP_BY_PROCESS,
    TreeTextMemory_SEARCH_METHOD,
)
from memos.mem_scheduler.schemas.message_schemas import (
    ScheduleLogForWebItem,
    ScheduleMessageItem,
)
from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    MEM_ARCHIVE_TASK_LABEL,
    MEM_ORGANIZE_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
    TaskPriorityLevel,
)
from memos.mem_scheduler.task_schedule_modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.task_schedule_modules.orchestrator import SchedulerOrchestrator
from memos.mem_scheduler.task_schedule_modules.task_queue import ScheduleTaskQueue
from memos.mem_scheduler.utils import metrics
from memos.mem_scheduler.utils.db_utils import get_utc_now
from memos.mem_scheduler.utils.filter_utils import (
    transform_name_to_key,
)
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube
from memos.mem_scheduler.utils.monitor_event_utils import emit_monitor_event, to_iso
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker
from memos.mem_scheduler.webservice_modules.rabbitmq_service import RabbitMQSchedulerModule
from memos.mem_scheduler.webservice_modules.redis_service import RedisSchedulerModule
from memos.memories.activation.kv import KVCacheMemory
from memos.memories.activation.vllmkv import VLLMKVCacheItem, VLLMKVCacheMemory
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.templates.mem_scheduler_prompts import MEMORY_ASSEMBLY_TEMPLATE
from memos.types.general_types import (
    MemCubeID,
    UserID,
)


if TYPE_CHECKING:
    import redis

    from memos.reranker.http_bge import HTTPBGEReranker


logger = get_logger(__name__)


class BaseScheduler(RabbitMQSchedulerModule, RedisSchedulerModule, SchedulerLoggerModule):
    """Base class for all mem_scheduler."""

    def __init__(self, config: BaseSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__()
        self.config = config

        # hyper-parameters
        self.top_k = self.config.get("top_k", DEFAULT_TOP_K)
        self.context_window_size = self.config.get(
            "context_window_size", DEFAULT_CONTEXT_WINDOW_SIZE
        )
        self.enable_activation_memory = self.config.get("enable_activation_memory", False)
        self.act_mem_dump_path = self.config.get("act_mem_dump_path", DEFAULT_ACT_MEM_DUMP_PATH)
        self.search_method = self.config.get("search_method", TreeTextMemory_SEARCH_METHOD)
        self.enable_parallel_dispatch = self.config.get("enable_parallel_dispatch", True)
        self.thread_pool_max_workers = self.config.get(
            "thread_pool_max_workers", DEFAULT_THREAD_POOL_MAX_WORKERS
        )

        # startup mode configuration
        self.scheduler_startup_mode = self.config.get(
            "scheduler_startup_mode", DEFAULT_STARTUP_MODE
        )

        # optional configs
        self.disabled_handlers: list | None = self.config.get("disabled_handlers", None)

        self.max_web_log_queue_size = self.config.get(
            "max_web_log_queue_size", DEFAULT_MAX_WEB_LOG_QUEUE_SIZE
        )
        self._web_log_message_queue: Queue[ScheduleLogForWebItem] = Queue(
            maxsize=self.max_web_log_queue_size
        )
        self._consumer_thread = None  # Reference to our consumer thread/process
        self._consumer_process = None  # Reference to our consumer process
        self._running = False
        self._consume_interval = self.config.get(
            "consume_interval_seconds", DEFAULT_CONSUME_INTERVAL_SECONDS
        )
        self.consume_batch = self.config.get("consume_batch", DEFAULT_CONSUME_BATCH)

        # message queue configuration
        self.use_redis_queue = self.config.get("use_redis_queue", DEFAULT_USE_REDIS_QUEUE)
        self.max_internal_message_queue_size = self.config.get(
            "max_internal_message_queue_size", DEFAULT_MAX_INTERNAL_MESSAGE_QUEUE_SIZE
        )
        self.orchestrator = SchedulerOrchestrator()

        self.searcher: Searcher | None = None
        self.retriever: SchedulerRetriever | None = None
        self.db_engine: Engine | None = None
        self.monitor: SchedulerGeneralMonitor | None = None
        self.dispatcher_monitor: SchedulerDispatcherMonitor | None = None
        self.mem_reader = None  # Will be set by MOSCore
        self._status_tracker: TaskStatusTracker | None = None
        self.metrics = metrics
        self._monitor_thread = None
        self.memos_message_queue = ScheduleTaskQueue(
            use_redis_queue=self.use_redis_queue,
            maxsize=self.max_internal_message_queue_size,
            disabled_handlers=self.disabled_handlers,
            orchestrator=self.orchestrator,
            status_tracker=self._status_tracker,
        )
        self.dispatcher = SchedulerDispatcher(
            config=self.config,
            memos_message_queue=self.memos_message_queue,
            max_workers=self.thread_pool_max_workers,
            enable_parallel_dispatch=self.enable_parallel_dispatch,
            status_tracker=self._status_tracker,
            metrics=self.metrics,
            submit_web_logs=self._submit_web_logs,
            orchestrator=self.orchestrator,
        )
        # Task schedule monitor: initialize with underlying queue implementation
        self.get_status_parallel = self.config.get("get_status_parallel", True)
        self.task_schedule_monitor = TaskScheduleMonitor(
            memos_message_queue=self.memos_message_queue.memos_message_queue,
            dispatcher=self.dispatcher,
            get_status_parallel=self.get_status_parallel,
        )

        # other attributes
        self._context_lock = threading.Lock()
        self.current_user_id: UserID | str | None = None
        self.current_mem_cube_id: MemCubeID | str | None = None
        self.current_mem_cube: BaseMemCube | None = None

        self._mem_cubes: dict[str, BaseMemCube] = {}
        self.auth_config_path: str | Path | None = self.config.get("auth_config_path", None)
        self.auth_config = None
        self.rabbitmq_config = None
        self.feedback_server = None

    def init_mem_cube(
        self,
        mem_cube: BaseMemCube,
        searcher: Searcher | None = None,
        feedback_server: SimpleMemFeedback | None = None,
    ):
        if mem_cube is None:
            logger.error("mem_cube is None, cannot initialize", stack_info=True)
        self.mem_cube = mem_cube
        self.text_mem: TreeTextMemory = self.mem_cube.text_mem
        self.reranker: HTTPBGEReranker = self.text_mem.reranker
        if searcher is None:
            self.searcher: Searcher = self.text_mem.get_searcher(
                manual_close_internet=os.getenv("ENABLE_INTERNET", "true").lower() == "false",
                moscube=False,
                process_llm=self.process_llm,
            )
        else:
            self.searcher = searcher
        self.feedback_server = feedback_server

    def initialize_modules(
        self,
        chat_llm: BaseLLM,
        process_llm: BaseLLM | None = None,
        db_engine: Engine | None = None,
        mem_reader=None,
        redis_client: Union["redis.Redis", None] = None,
    ):
        if process_llm is None:
            process_llm = chat_llm

        try:
            if redis_client:
                self.status_tracker = TaskStatusTracker(redis_client)
                if self.dispatcher:
                    self.dispatcher.status_tracker = self.status_tracker
                if self.memos_message_queue:
                    # Use the setter to propagate to the inner queue (e.g. SchedulerRedisQueue)
                    self.memos_message_queue.set_status_tracker(self.status_tracker)
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

            if mem_reader:
                self.mem_reader = mem_reader

            if self.enable_parallel_dispatch:
                self.dispatcher_monitor.initialize(dispatcher=self.dispatcher)
                self.dispatcher_monitor.start()

            # initialize with auth_config
            try:
                if self.auth_config_path is not None and Path(self.auth_config_path).exists():
                    self.auth_config = AuthConfig.from_local_config(
                        config_path=self.auth_config_path
                    )
                elif AuthConfig.default_config_exists():
                    self.auth_config = AuthConfig.from_local_config()
                else:
                    self.auth_config = AuthConfig.from_local_env()
            except Exception:
                pass

            if self.auth_config is not None:
                self.rabbitmq_config = self.auth_config.rabbitmq
                if self.rabbitmq_config is not None:
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
    def mem_cube(self) -> BaseMemCube:
        """The memory cube associated with this MemChat."""
        if self.current_mem_cube is None:
            logger.error("mem_cube is None when accessed", stack_info=True)
            try:
                self.components = init_components()
                self.current_mem_cube: BaseMemCube = self.components["naive_mem_cube"]
            except Exception:
                logger.info(
                    "No environment available to initialize mem cube. Using fallback naive_mem_cube."
                )
        return self.current_mem_cube

    @property
    def status_tracker(self) -> TaskStatusTracker | None:
        """Lazy-initialized TaskStatusTracker.

        If the tracker is None, attempt to initialize from the Redis client
        available via RedisSchedulerModule. This mirrors the lazy pattern used
        by `mem_cube` so downstream modules can safely access the tracker.
        """
        if self._status_tracker is None:
            try:
                self._status_tracker = TaskStatusTracker(self.redis)
                # Propagate to submodules when created lazily
                if self.dispatcher:
                    self.dispatcher.status_tracker = self._status_tracker
                if self.memos_message_queue:
                    self.memos_message_queue.set_status_tracker(self._status_tracker)
            except Exception as e:
                logger.warning(f"Failed to lazily initialize status_tracker: {e}", exc_info=True)
        return self._status_tracker

    @status_tracker.setter
    def status_tracker(self, value: TaskStatusTracker | None) -> None:
        """Setter that also propagates tracker to dependent modules."""
        self._status_tracker = value
        try:
            if self.dispatcher:
                self.dispatcher.status_tracker = value
            if self.memos_message_queue and value is not None:
                self.memos_message_queue.set_status_tracker(value)
        except Exception as e:
            logger.warning(f"Failed to propagate status_tracker: {e}", exc_info=True)

    @property
    def feedback_server(self) -> SimpleMemFeedback:
        """The memory cube associated with this MemChat."""
        if self._feedback_server is None:
            logger.error("feedback_server is None when accessed", stack_info=True)
            try:
                self.components = init_components()
                self._feedback_server: SimpleMemFeedback = self.components["feedback_server"]
            except Exception:
                logger.info(
                    "No environment available to initialize feedback_server. Using fallback feedback_server."
                )
        return self._feedback_server

    @feedback_server.setter
    def feedback_server(self, value: SimpleMemFeedback) -> None:
        self._feedback_server = value

    @mem_cube.setter
    def mem_cube(self, value: BaseMemCube) -> None:
        """The memory cube associated with this MemChat."""
        self.current_mem_cube = value
        self.retriever.mem_cube = value

    @property
    def mem_cubes(self) -> dict[str, BaseMemCube]:
        """All available memory cubes registered to the scheduler.

        Setting this property will also initialize `current_mem_cube` if it is not
        already set, following the initialization pattern used in component_init.py
        (i.e., calling `init_mem_cube(...)`), without introducing circular imports.
        """
        return self._mem_cubes

    @mem_cubes.setter
    def mem_cubes(self, value: dict[str, BaseMemCube]) -> None:
        self._mem_cubes = value or {}

        # Initialize current_mem_cube if not set yet and mem_cubes are available
        try:
            if self.current_mem_cube is None and self._mem_cubes:
                selected_cube: BaseMemCube | None = None

                # Prefer the cube matching current_mem_cube_id if provided
                if self.current_mem_cube_id and self.current_mem_cube_id in self._mem_cubes:
                    selected_cube = self._mem_cubes[self.current_mem_cube_id]
                else:
                    # Fall back to the first available cube deterministically
                    first_id, first_cube = next(iter(self._mem_cubes.items()))
                    self.current_mem_cube_id = first_id
                    selected_cube = first_cube

                if selected_cube is not None:
                    # Use init_mem_cube to mirror component_init.py behavior
                    # This sets self.mem_cube (and retriever.mem_cube), text_mem, and searcher.
                    self.init_mem_cube(mem_cube=selected_cube)
        except Exception as e:
            logger.warning(
                f"Failed to initialize current_mem_cube from mem_cubes: {e}", exc_info=True
            )

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

            original_count = len(original_memory)
            # Filter out memories tagged with "mode:fast"
            filtered_original_memory = []
            for origin_mem in original_memory:
                if "mode:fast" not in origin_mem.metadata.tags:
                    filtered_original_memory.append(origin_mem)
                else:
                    logger.debug(
                        f"Filtered out memory - ID: {getattr(origin_mem, 'id', 'unknown')}, Tags: {origin_mem.metadata.tags}"
                    )
            # Calculate statistics
            filtered_count = original_count - len(filtered_original_memory)
            remaining_count = len(filtered_original_memory)

            logger.info(
                f"Filtering complete. Removed {filtered_count} memories with tag 'mode:fast'. Remaining memories: {remaining_count}"
            )
            original_memory = filtered_original_memory

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
            cache_item.records.timestamp = get_utc_now()

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

                self.monitor.last_activation_mem_update_time = get_utc_now()

                logger.debug(
                    f"Activation memory update completed at {self.monitor.last_activation_mem_update_time}"
                )

            else:
                logger.info(
                    f"Skipping update - {interval_seconds} second interval not yet reached. "
                    f"Last update time is {self.monitor.last_activation_mem_update_time} and now is "
                    f"{get_utc_now()}"
                )
        except Exception as e:
            logger.error(f"Error in update_activation_memory_periodically: {e}", exc_info=True)

    def submit_messages(self, messages: ScheduleMessageItem | list[ScheduleMessageItem]):
        """Submit messages for processing, with priority-aware dispatch.

        - LEVEL_1 tasks dispatch immediately to the appropriate handler.
        - Lower-priority tasks are enqueued via the configured message queue.
        """
        if isinstance(messages, ScheduleMessageItem):
            messages = [messages]

        if not messages:
            return

        current_trace_id = get_current_trace_id()

        immediate_msgs: list[ScheduleMessageItem] = []
        queued_msgs: list[ScheduleMessageItem] = []

        for msg in messages:
            # propagate request trace_id when available so monitor logs align with request logs
            if current_trace_id:
                msg.trace_id = current_trace_id

            # basic metrics and status tracking
            with suppress(Exception):
                self.metrics.task_enqueued(user_id=msg.user_id, task_type=msg.label)

            # ensure timestamp exists for monitoring
            if getattr(msg, "timestamp", None) is None:
                msg.timestamp = get_utc_now()

            if self.status_tracker:
                try:
                    self.status_tracker.task_submitted(
                        task_id=msg.item_id,
                        user_id=msg.user_id,
                        task_type=msg.label,
                        mem_cube_id=msg.mem_cube_id,
                        business_task_id=msg.task_id,
                    )
                except Exception:
                    logger.warning("status_tracker.task_submitted failed", exc_info=True)

            # honor disabled handlers
            if self.disabled_handlers and msg.label in self.disabled_handlers:
                logger.info(f"Skipping disabled handler: {msg.label} - {msg.content}")
                continue

            # decide priority path
            task_priority = self.orchestrator.get_task_priority(task_label=msg.label)
            if task_priority == TaskPriorityLevel.LEVEL_1:
                immediate_msgs.append(msg)
            else:
                queued_msgs.append(msg)

        # Dispatch high-priority tasks immediately
        if immediate_msgs:
            # emit enqueue events for consistency
            for m in immediate_msgs:
                emit_monitor_event(
                    "enqueue",
                    m,
                    {
                        "enqueue_ts": to_iso(getattr(m, "timestamp", None)),
                        "event_duration_ms": 0,
                        "total_duration_ms": 0,
                    },
                )

            # simulate dequeue for immediately dispatched messages so monitor logs stay complete
            for m in immediate_msgs:
                try:
                    now = time.time()
                    enqueue_ts_obj = getattr(m, "timestamp", None)
                    enqueue_epoch = None
                    if isinstance(enqueue_ts_obj, int | float):
                        enqueue_epoch = float(enqueue_ts_obj)
                    elif hasattr(enqueue_ts_obj, "timestamp"):
                        dt = enqueue_ts_obj
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        enqueue_epoch = dt.timestamp()

                    queue_wait_ms = None
                    if enqueue_epoch is not None:
                        queue_wait_ms = max(0.0, now - enqueue_epoch) * 1000

                    object.__setattr__(m, "_dequeue_ts", now)
                    emit_monitor_event(
                        "dequeue",
                        m,
                        {
                            "enqueue_ts": to_iso(enqueue_ts_obj),
                            "dequeue_ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                            "queue_wait_ms": queue_wait_ms,
                            "event_duration_ms": queue_wait_ms,
                            "total_duration_ms": queue_wait_ms,
                        },
                    )
                    self.metrics.task_dequeued(user_id=m.user_id, task_type=m.label)
                except Exception:
                    logger.debug("Failed to emit dequeue for immediate task", exc_info=True)

            user_cube_groups = group_messages_by_user_and_mem_cube(immediate_msgs)
            for user_id, cube_groups in user_cube_groups.items():
                for mem_cube_id, user_cube_msgs in cube_groups.items():
                    label_groups: dict[str, list[ScheduleMessageItem]] = {}
                    for m in user_cube_msgs:
                        label_groups.setdefault(m.label, []).append(m)

                    for label, msgs_by_label in label_groups.items():
                        handler = self.dispatcher.handlers.get(
                            label, self.dispatcher._default_message_handler
                        )
                        self.dispatcher.execute_task(
                            user_id=user_id,
                            mem_cube_id=mem_cube_id,
                            task_label=label,
                            msgs=msgs_by_label,
                            handler_call_back=handler,
                        )

        # Enqueue lower-priority tasks
        if queued_msgs:
            self.memos_message_queue.submit_messages(messages=queued_msgs)

    def _submit_web_logs(
        self,
        messages: ScheduleLogForWebItem | list[ScheduleLogForWebItem],
        additional_log_info: str | None = None,
    ) -> None:
        """Submit log messages to the web log queue and optionally to RabbitMQ.

        Args:
            messages: Single log message or list of log messages
        """
        if isinstance(messages, ScheduleLogForWebItem):
            messages = [messages]  # transform single message to list

        for message in messages:
            try:
                # Always call publish; the publisher now caches when offline and flushes after reconnect
                logger.info(
                    f"[DIAGNOSTIC] base_scheduler._submit_web_logs: enqueue publish {message.model_dump_json(indent=2)}"
                )
                self.rabbitmq_publish_message(message=message.to_dict())
                logger.info(
                    "[DIAGNOSTIC] base_scheduler._submit_web_logs: publish dispatched "
                    "item_id=%s task_id=%s label=%s",
                    message.item_id,
                    message.task_id,
                    message.label,
                )
            except Exception as e:
                logger.error(
                    f"[DIAGNOSTIC] base_scheduler._submit_web_logs failed: {e}", exc_info=True
                )

        logger.debug(
            f"{len(messages)} submitted. {self._web_log_message_queue.qsize()} in queue. additional_log_info: {additional_log_info}"
        )

    def get_web_log_messages(self) -> list[dict]:
        """
        Retrieve structured log messages from the queue and return JSON-serializable dicts.
        """
        raw_items: list[ScheduleLogForWebItem] = []
        while True:
            try:
                raw_items.append(self._web_log_message_queue.get_nowait())
            except Exception:
                break

        def _map_label(label: str) -> str:
            mapping = {
                QUERY_TASK_LABEL: "addMessage",
                ANSWER_TASK_LABEL: "addMessage",
                ADD_TASK_LABEL: "addMemory",
                MEM_UPDATE_TASK_LABEL: "updateMemory",
                MEM_ORGANIZE_TASK_LABEL: "mergeMemory",
                MEM_ARCHIVE_TASK_LABEL: "archiveMemory",
            }
            return mapping.get(label, label)

        def _normalize_item(item: ScheduleLogForWebItem) -> dict:
            data = item.to_dict()
            data["label"] = _map_label(data.get("label"))
            memcube_content = getattr(item, "memcube_log_content", None) or []
            metadata = getattr(item, "metadata", None) or []

            memcube_name = getattr(item, "memcube_name", None)
            if not memcube_name and hasattr(self, "_map_memcube_name"):
                memcube_name = self._map_memcube_name(item.mem_cube_id)
            data["memcube_name"] = memcube_name

            memory_len = getattr(item, "memory_len", None)
            if memory_len is None:
                if data["label"] == "mergeMemory":
                    memory_len = len([c for c in memcube_content if c.get("type") != "postMerge"])
                elif memcube_content:
                    memory_len = len(memcube_content)
                else:
                    memory_len = 1 if item.log_content else 0

            data["memcube_log_content"] = memcube_content
            data["memory_len"] = memory_len

            def _with_memory_time(meta: dict) -> dict:
                enriched = dict(meta)
                if "memory_time" not in enriched:
                    enriched["memory_time"] = enriched.get("updated_at") or enriched.get(
                        "update_at"
                    )
                return enriched

            data["metadata"] = [_with_memory_time(m) for m in metadata]
            data["log_title"] = ""
            return data

        return [_normalize_item(it) for it in raw_items]

    def _message_consumer(self) -> None:
        """
        Continuously checks the queue for messages and dispatches them.

        Runs in a dedicated thread to process messages at regular intervals.
        For Redis queue, this method starts the Redis listener.
        """

        # Original local queue logic
        while self._running:  # Use a running flag for graceful shutdown
            try:
                # Get messages in batches based on consume_batch setting

                messages = self.memos_message_queue.get_messages(batch_size=self.consume_batch)

                if messages:
                    now = time.time()
                    for msg in messages:
                        prev_context = get_current_context()
                        try:
                            # Set context for this message
                            msg_context = RequestContext(
                                trace_id=msg.trace_id,
                                user_name=msg.user_name,
                            )
                            set_request_context(msg_context)

                            enqueue_ts_obj = getattr(msg, "timestamp", None)
                            enqueue_epoch = None
                            if isinstance(enqueue_ts_obj, int | float):
                                enqueue_epoch = float(enqueue_ts_obj)
                            elif hasattr(enqueue_ts_obj, "timestamp"):
                                dt = enqueue_ts_obj
                                if dt.tzinfo is None:
                                    dt = dt.replace(tzinfo=timezone.utc)
                                enqueue_epoch = dt.timestamp()

                            queue_wait_ms = None
                            if enqueue_epoch is not None:
                                queue_wait_ms = max(0.0, now - enqueue_epoch) * 1000

                            # Avoid pydantic field enforcement by using object.__setattr__
                            object.__setattr__(msg, "_dequeue_ts", now)
                            emit_monitor_event(
                                "dequeue",
                                msg,
                                {
                                    "enqueue_ts": to_iso(enqueue_ts_obj),
                                    "dequeue_ts": datetime.fromtimestamp(
                                        now, tz=timezone.utc
                                    ).isoformat(),
                                    "queue_wait_ms": queue_wait_ms,
                                    "event_duration_ms": queue_wait_ms,
                                    "total_duration_ms": queue_wait_ms,
                                },
                            )
                            self.metrics.task_dequeued(user_id=msg.user_id, task_type=msg.label)
                        finally:
                            # Restore the prior context of the consumer thread
                            set_request_context(prev_context)
                    try:
                        import contextlib

                        with contextlib.suppress(Exception):
                            if messages:
                                self.dispatcher.on_messages_enqueued(messages)

                        self.dispatcher.dispatch(messages)
                    except Exception as e:
                        logger.error(f"Error dispatching messages: {e!s}")

                # Sleep briefly to prevent busy waiting
                time.sleep(self._consume_interval)  # Adjust interval as needed

            except Exception as e:
                # Don't log error for "No messages available in Redis queue" as it's expected
                if "No messages available in Redis queue" not in str(e):
                    logger.error(f"Unexpected error in message consumer: {e!s}", exc_info=True)
                time.sleep(self._consume_interval)  # Prevent tight error loops

    def _monitor_loop(self):
        while self._running:
            try:
                q_sizes = self.memos_message_queue.qsize()

                for stream_key, queue_length in q_sizes.items():
                    # Skip aggregate keys like 'total_size'
                    if stream_key == "total_size":
                        continue

                    # Key format: ...:{user_id}:{mem_cube_id}:{task_label}
                    # We want to extract user_id, which is the 3rd component from the end.
                    parts = stream_key.split(":")
                    if len(parts) >= 3:
                        user_id = parts[-3]
                        self.metrics.update_queue_length(queue_length, user_id)
                    else:
                        # Fallback for unexpected key formats (e.g. legacy or testing)
                        # Try to use the key itself if it looks like a user_id (no colons)
                        # or just log a warning?
                        # For now, let's assume if it's not total_size and short, it might be a direct user_id key
                        # (though that shouldn't happen with current queue implementations)
                        if ":" not in stream_key:
                            self.metrics.update_queue_length(queue_length, stream_key)

            except Exception as e:
                logger.error(f"Error in metrics monitor loop: {e}", exc_info=True)

            time.sleep(15)  # 每 15 秒采样一次

    def start(self) -> None:
        """
        Start the message consumer thread/process and initialize dispatcher resources.

        Initializes and starts:
        1. Message consumer thread or process (based on startup_mode)
        2. Dispatcher thread pool (if parallel dispatch enabled)
        """
        # Initialize dispatcher resources
        if self.enable_parallel_dispatch:
            logger.info(
                f"Initializing dispatcher thread pool with {self.thread_pool_max_workers} workers"
            )

        self.start_consumer()
        self.start_background_monitor()

    def start_background_monitor(self):
        if self._monitor_thread and self._monitor_thread.is_alive():
            return
        self._monitor_thread = ContextThread(
            target=self._monitor_loop, daemon=True, name="SchedulerMetricsMonitor"
        )
        self._monitor_thread.start()
        logger.info("Scheduler metrics monitor thread started.")

    def start_consumer(self) -> None:
        """
        Start only the message consumer thread/process.

        This method can be used to restart the consumer after it has been stopped
        with stop_consumer(), without affecting other scheduler components.
        """
        if self._running:
            logger.warning("Memory Scheduler consumer is already running")
            return

        # Start consumer based on startup mode
        self._running = True

        if self.scheduler_startup_mode == STARTUP_BY_PROCESS:
            # Start consumer process
            self._consumer_process = multiprocessing.Process(
                target=self._message_consumer,
                daemon=True,
                name="MessageConsumerProcess",
            )
            self._consumer_process.start()
            logger.info("Message consumer process started")
        else:
            # Default to thread mode
            self._consumer_thread = ContextThread(
                target=self._message_consumer,
                daemon=True,
                name="MessageConsumerThread",
            )
            self._consumer_thread.start()
            logger.info("Message consumer thread started")

    def stop_consumer(self) -> None:
        """Stop only the message consumer thread/process gracefully.

        This method stops the consumer without affecting other components like
        dispatcher or monitors. Useful when you want to pause message processing
        while keeping other scheduler components running.
        """
        if not self._running:
            logger.warning("Memory Scheduler consumer is not running")
            return

        # Signal consumer thread/process to stop
        self._running = False

        # Wait for consumer thread or process
        if self.scheduler_startup_mode == STARTUP_BY_PROCESS and self._consumer_process:
            if self._consumer_process.is_alive():
                self._consumer_process.join(timeout=5.0)
                if self._consumer_process.is_alive():
                    logger.warning("Consumer process did not stop gracefully, terminating...")
                    self._consumer_process.terminate()
                    self._consumer_process.join(timeout=2.0)
                    if self._consumer_process.is_alive():
                        logger.error("Consumer process could not be terminated")
                    else:
                        logger.info("Consumer process terminated")
                else:
                    logger.info("Consumer process stopped")
            self._consumer_process = None
        elif self._consumer_thread and self._consumer_thread.is_alive():
            self._consumer_thread.join(timeout=5.0)
            if self._consumer_thread.is_alive():
                logger.warning("Consumer thread did not stop gracefully")
            else:
                logger.info("Consumer thread stopped")
            self._consumer_thread = None

        logger.info("Memory Scheduler consumer stopped")

    def stop(self) -> None:
        """Stop all scheduler components gracefully.

        1. Stops message consumer thread/process
        2. Shuts down dispatcher thread pool
        3. Cleans up resources
        """
        if not self._running:
            logger.warning("Memory Scheduler is not running")
            return

        # Stop consumer first
        self.stop_consumer()

        if self._monitor_thread:
            self._monitor_thread.join(timeout=2.0)

        # Shutdown dispatcher
        if self.dispatcher:
            logger.info("Shutting down dispatcher...")
            self.dispatcher.shutdown()

        # Shutdown dispatcher_monitor
        if self.dispatcher_monitor:
            logger.info("Shutting down monitor...")
            self.dispatcher_monitor.stop()

    @property
    def handlers(self) -> dict[str, Callable]:
        """
        Access the dispatcher's handlers dictionary.

        Returns:
            dict[str, Callable]: Dictionary mapping labels to handler functions
        """
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, returning empty handlers dict")
            return {}

        return self.dispatcher.handlers

    def register_handlers(
        self, handlers: dict[str, Callable[[list[ScheduleMessageItem]], None]]
    ) -> None:
        """
        Bulk register multiple handlers from a dictionary.

        Args:
            handlers: Dictionary mapping labels to handler functions
                      Format: {label: handler_callable}
        """
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, cannot register handlers")
            return

        self.dispatcher.register_handlers(handlers)

    def unregister_handlers(self, labels: list[str]) -> dict[str, bool]:
        """
        Unregister handlers from the dispatcher by their labels.

        Args:
            labels: List of labels to unregister handlers for

        Returns:
            dict[str, bool]: Dictionary mapping each label to whether it was successfully unregistered
        """
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, cannot unregister handlers")
            return dict.fromkeys(labels, False)

        return self.dispatcher.unregister_handlers(labels)

    def get_running_tasks(self, filter_func: Callable | None = None) -> dict[str, dict]:
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, returning empty tasks dict")
            return {}

        running_tasks = self.dispatcher.get_running_tasks(filter_func=filter_func)

        # Convert RunningTaskItem objects to dictionaries for easier consumption
        result = {}
        for task_id, task_item in running_tasks.items():
            result[task_id] = {
                "item_id": task_item.item_id,
                "user_id": task_item.user_id,
                "mem_cube_id": task_item.mem_cube_id,
                "task_info": task_item.task_info,
                "task_name": task_item.task_name,
                "start_time": task_item.start_time,
                "end_time": task_item.end_time,
                "status": task_item.status,
                "result": task_item.result,
                "error_message": task_item.error_message,
                "messages": task_item.messages,
            }

        return result

    def get_tasks_status(self):
        """Delegate status collection to TaskScheduleMonitor."""
        return self.task_schedule_monitor.get_tasks_status()

    def print_tasks_status(self, tasks_status: dict | None = None) -> None:
        """Delegate pretty printing to TaskScheduleMonitor."""
        self.task_schedule_monitor.print_tasks_status(tasks_status=tasks_status)

    def _gather_queue_stats(self) -> dict:
        """Collect queue/dispatcher stats for reporting."""
        memos_message_queue = self.memos_message_queue.memos_message_queue
        stats: dict[str, int | float | str] = {}
        stats["use_redis_queue"] = bool(self.use_redis_queue)
        # local queue metrics
        if not self.use_redis_queue:
            try:
                stats["qsize"] = int(memos_message_queue.qsize())
            except Exception:
                stats["qsize"] = -1
            # unfinished_tasks if available
            try:
                stats["unfinished_tasks"] = int(
                    getattr(memos_message_queue, "unfinished_tasks", 0) or 0
                )
            except Exception:
                stats["unfinished_tasks"] = -1
            stats["maxsize"] = int(self.max_internal_message_queue_size)
            try:
                maxsize = int(self.max_internal_message_queue_size) or 1
                qsize = int(stats.get("qsize", 0))
                stats["utilization"] = min(1.0, max(0.0, qsize / maxsize))
            except Exception:
                stats["utilization"] = 0.0
        # dispatcher stats
        try:
            d_stats = self.dispatcher.stats()
            stats.update(
                {
                    "running": int(d_stats.get("running", 0)),
                    "inflight": int(d_stats.get("inflight", 0)),
                    "handlers": int(d_stats.get("handlers", 0)),
                }
            )
        except Exception:
            stats.update({"running": 0, "inflight": 0, "handlers": 0})
        return stats
