import os
import threading

from pathlib import Path
from typing import TYPE_CHECKING, Union

from sqlalchemy.engine import Engine

from memos.configs.mem_scheduler import AuthConfig, BaseSchedulerConfig
from memos.mem_scheduler.base_mixins import (
    BaseSchedulerMemoryMixin,
    BaseSchedulerQueueMixin,
    BaseSchedulerWebLogMixin,
)
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.base import BaseMemCube
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
    TreeTextMemory_SEARCH_METHOD,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleLogForWebItem
from memos.mem_scheduler.task_schedule_modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.task_schedule_modules.orchestrator import SchedulerOrchestrator
from memos.mem_scheduler.task_schedule_modules.task_queue import ScheduleTaskQueue
from memos.mem_scheduler.utils import metrics
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker
from memos.mem_scheduler.webservice_modules.rabbitmq_service import RabbitMQSchedulerModule
from memos.mem_scheduler.webservice_modules.redis_service import RedisSchedulerModule
from memos.memories.textual.tree import TreeTextMemory
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.types.general_types import (
    MemCubeID,
    UserID,
)


if TYPE_CHECKING:
    import redis

    from memos.reranker.http_bge import HTTPBGEReranker


logger = get_logger(__name__)


class BaseScheduler(
    RabbitMQSchedulerModule,
    RedisSchedulerModule,
    SchedulerLoggerModule,
    BaseSchedulerWebLogMixin,
    BaseSchedulerMemoryMixin,
    BaseSchedulerQueueMixin,
):
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
        self.reranker: HTTPBGEReranker = getattr(self.text_mem, "reranker", None)
        if searcher is None:
            if hasattr(self.text_mem, "get_searcher"):
                self.searcher: Searcher = self.text_mem.get_searcher(
                    manual_close_internet=os.getenv("ENABLE_INTERNET", "true").lower() == "false",
                    moscube=False,
                    process_llm=self.process_llm,
                )
            else:
                self.searcher = None
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
            if redis_client and self.use_redis_queue:
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
        if self._status_tracker is None and self.use_redis_queue:
            try:
                self._status_tracker = TaskStatusTracker(self.redis)
                # Propagate to submodules when created lazily
                if self.dispatcher:
                    self.dispatcher.status_tracker = self._status_tracker
                if self.memos_message_queue:
                    self.memos_message_queue.set_status_tracker(self._status_tracker)
            except Exception as e:
                logger.warning(f"Failed to lazy-initialize status_tracker: {e}", exc_info=True)

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


    # Methods moved to mixins in mem_scheduler.base_mixins.
