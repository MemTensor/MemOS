from datetime import datetime
from threading import Lock
from typing import Any

from sqlalchemy.engine import Engine

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.orm_modules.base_model import BaseDBManager
from memos.mem_scheduler.orm_modules.monitor_models import (
    DBManagerForMemoryMonitorManager,
    DBManagerForQueryMonitorQueue,
)
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT,
    DEFAULT_WEIGHT_VECTOR_FOR_RANKING,
    DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT,
    MONITOR_ACTIVATION_MEMORY_TYPE,
    MONITOR_WORKING_MEMORY_TYPE,
    MemCubeID,
    UserID,
)
from memos.mem_scheduler.schemas.monitor_schemas import (
    MemoryMonitorItem,
    MemoryMonitorManager,
    QueryMonitorQueue,
)
from memos.mem_scheduler.utils.misc_utils import extract_json_dict
from memos.memories.textual.tree import TreeTextMemory


logger = get_logger(__name__)


class SchedulerGeneralMonitor(BaseSchedulerModule):
    """Monitors and manages scheduling operations with LLM integration."""

    def __init__(
        self, process_llm: BaseLLM, config: BaseSchedulerConfig, db_engine: Engine | None = None
    ):
        super().__init__()

        # hyper-parameters
        self.config: BaseSchedulerConfig = config
        self.act_mem_update_interval = self.config.get("act_mem_update_interval", 30)
        self.query_trigger_interval = self.config.get("query_trigger_interval", 10)

        # Partial Retention Strategy
        self.partial_retention_number = 2
        self.working_mem_monitor_capacity = self.config.get(
            "working_mem_monitor_capacity", DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT
        )
        self.activation_mem_monitor_capacity = self.config.get(
            "activation_mem_monitor_capacity", DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT
        )

        # ORM-based monitor managers
        self.db_engine = db_engine
        if self.db_engine is None:
            logger.warning(
                "No database engine provided; falling back to default temporary SQLite engine. "
                "This is intended for testing only. Consider providing a configured engine for production use."
            )
            self.db_engine = BaseDBManager.create_default_engine()

        self.query_monitors: dict[UserID, dict[MemCubeID, DBManagerForQueryMonitorQueue]] = {}
        self.working_memory_monitors: dict[
            UserID, dict[MemCubeID, DBManagerForMemoryMonitorManager]
        ] = {}
        self.activation_memory_monitors: dict[
            UserID, dict[MemCubeID, DBManagerForMemoryMonitorManager]
        ] = {}

        # Lifecycle monitor
        self.last_activation_mem_update_time = datetime.min
        self.last_query_consume_time = datetime.min

        self._register_lock = Lock()
        self._process_llm = process_llm

    def extract_query_keywords(self, query: str) -> list:
        """Extracts core keywords from a user query based on specific semantic rules."""
        prompt_name = "query_keywords_extraction"
        prompt = self.build_prompt(
            template_name=prompt_name,
            query=query,
        )
        llm_response = self._process_llm.generate([{"role": "user", "content": prompt}])
        try:
            # Parse JSON output from LLM response
            keywords = extract_json_dict(llm_response)
            assert isinstance(keywords, list)
        except Exception as e:
            logger.error(
                f"Failed to parse keywords from LLM response: {llm_response}. Error: {e!s}"
            )
            keywords = [query]
        return keywords

    def register_query_monitor_if_not_exists(
        self,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
    ) -> None:
        # First check (lock-free, fast path)
        if user_id in self.query_monitors and mem_cube_id in self.query_monitors[user_id]:
            return

        # Second check (with lock, ensures uniqueness)
        with self._register_lock:
            if user_id not in self.query_monitors:
                self.query_monitors[user_id] = {}
            if mem_cube_id not in self.query_monitors[user_id]:
                if self.db_engine:
                    # Create ORM manager with initial QueryMonitorQueue
                    initial_queue = QueryMonitorQueue(maxsize=self.config.context_window_size)
                    db_manager = DBManagerForQueryMonitorQueue(
                        engine=self.db_engine,
                        user_id=str(user_id),
                        mem_cube_id=str(mem_cube_id),
                        obj=initial_queue,
                    )
                    self.query_monitors[user_id][mem_cube_id] = db_manager
                else:
                    # Fallback to in-memory (this shouldn't happen with proper config)
                    logger.warning("ORM persistence disabled, using in-memory fallback")
                    # For backward compatibility, we'll need to handle this case differently
                    raise RuntimeError("ORM persistence is required but not properly configured")

    def register_memory_manager_if_not_exists(
        self,
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        memory_monitors: dict[UserID, dict[MemCubeID, DBManagerForMemoryMonitorManager]],
        max_capacity: int,
    ) -> None:
        """
        Register a new MemoryMonitorManager ORM manager for the given user and memory cube if it doesn't exist.
        Thread-safe implementation using double-checked locking pattern.

        Checks if a MemoryMonitorManager ORM manager already exists for the specified user_id and mem_cube_id.
        If not, creates a new ORM manager with appropriate capacity settings and registers it.

        Args:
            user_id: The ID of the user to associate with the memory manager
            mem_cube_id: The ID of the memory cube to monitor
            memory_monitors: Dictionary storing existing memory monitor ORM managers
            max_capacity: Maximum capacity for the new memory monitor manager
        """
        # First check (lock-free, fast path)
        # Quickly verify existence without lock overhead
        if user_id in memory_monitors and mem_cube_id in memory_monitors[user_id]:
            logger.info(
                f"MemoryMonitorManager ORM manager already exists for user_id={user_id}, "
                f"mem_cube_id={mem_cube_id} in the provided memory_monitors dictionary"
            )
            return

        # Second check (with lock, ensures uniqueness)
        # Acquire lock before modification and verify again to prevent race conditions
        with self._register_lock:
            # Re-check after acquiring lock, as another thread might have created it
            if user_id in memory_monitors and mem_cube_id in memory_monitors[user_id]:
                logger.info(
                    f"MemoryMonitorManager ORM manager already exists for user_id={user_id}, "
                    f"mem_cube_id={mem_cube_id} in the provided memory_monitors dictionary"
                )
                return

            if self.db_engine:
                # Initialize MemoryMonitorManager with user ID, memory cube ID, and max capacity
                monitor_manager = MemoryMonitorManager(
                    user_id=user_id, mem_cube_id=mem_cube_id, max_capacity=max_capacity
                )

                # Create ORM manager
                db_manager = DBManagerForMemoryMonitorManager(
                    engine=self.db_engine,
                    user_id=str(user_id),
                    mem_cube_id=str(mem_cube_id),
                    obj=monitor_manager,
                )

                # Safely register the new ORM manager in the nested dictionary structure
                memory_monitors.setdefault(user_id, {})[mem_cube_id] = db_manager
                logger.info(
                    f"Registered new MemoryMonitorManager ORM manager for user_id={user_id},"
                    f" mem_cube_id={mem_cube_id} with max_capacity={max_capacity}"
                )
            else:
                raise RuntimeError("ORM persistence is required but not properly configured")

    def update_working_memory_monitors(
        self,
        new_working_memory_monitors: list[MemoryMonitorItem],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
    ):
        text_mem_base: TreeTextMemory = mem_cube.text_mem
        assert isinstance(text_mem_base, TreeTextMemory)
        self.working_mem_monitor_capacity = min(
            DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT,
            (
                text_mem_base.memory_manager.memory_size["WorkingMemory"]
                + self.partial_retention_number
            ),
        )

        # register monitors
        self.register_memory_manager_if_not_exists(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            memory_monitors=self.working_memory_monitors,
            max_capacity=self.working_mem_monitor_capacity,
        )

        # Get the ORM manager and update memories with database sync
        db_manager = self.working_memory_monitors[user_id][mem_cube_id]
        db_manager.obj.update_memories(
            new_memory_monitors=new_working_memory_monitors,
            partial_retention_number=self.partial_retention_number,
        )
        # Sync with database
        db_manager.sync_with_orm(size_limit=self.working_mem_monitor_capacity)

    def update_activation_memory_monitors(
        self, user_id: str, mem_cube_id: str, mem_cube: GeneralMemCube
    ):
        self.register_memory_manager_if_not_exists(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            memory_monitors=self.activation_memory_monitors,
            max_capacity=self.activation_mem_monitor_capacity,
        )

        # === update activation memory monitors ===
        # Sort by importance_score in descending order and take top k
        working_db_manager = self.working_memory_monitors[user_id][mem_cube_id]
        top_k_memories = sorted(
            working_db_manager.obj.memories,
            key=lambda m: m.get_importance_score(weight_vector=DEFAULT_WEIGHT_VECTOR_FOR_RANKING),
            reverse=True,
        )[: self.activation_mem_monitor_capacity]

        # Update the activation memory monitors with these important memories
        activation_db_manager = self.activation_memory_monitors[user_id][mem_cube_id]
        activation_db_manager.obj.update_memories(
            new_memory_monitors=top_k_memories,
            partial_retention_number=self.partial_retention_number,
        )
        # Sync with database
        activation_db_manager.sync_with_orm(size_limit=self.activation_mem_monitor_capacity)

    def timed_trigger(self, last_time: datetime, interval_seconds: float) -> bool:
        now = datetime.utcnow()
        elapsed = (now - last_time).total_seconds()
        if elapsed >= interval_seconds:
            return True
        logger.info(f"Time trigger not ready, {elapsed:.1f}s elapsed (needs {interval_seconds}s)")
        return False

    def get_monitor_memories(
        self,
        user_id: str,
        mem_cube_id: str,
        memory_type: str = MONITOR_WORKING_MEMORY_TYPE,
        top_k: int = 10,
    ) -> list[str]:
        """Retrieves memory items managed by the scheduler, sorted by recording count.

        Args:
            user_id: Unique identifier of the user
            mem_cube_id: Unique identifier of the memory cube
            memory_type: Type of memory to retrieve (MONITOR_WORKING_MEMORY_TYPE or
                       MONITOR_ACTIVATION_MEMORY_TYPE)
            top_k: Maximum number of memory items to return (default: 10)

        Returns:
            List of memory texts, sorted by recording count in descending order.
            Returns empty list if no MemoryMonitorManager exists for the given parameters.
        """
        # Select the appropriate monitor dictionary based on memory_type
        if memory_type == MONITOR_WORKING_MEMORY_TYPE:
            monitor_dict = self.working_memory_monitors
        elif memory_type == MONITOR_ACTIVATION_MEMORY_TYPE:
            monitor_dict = self.activation_memory_monitors
        else:
            logger.warning(f"Invalid memory type: {memory_type}")
            return []

        if user_id not in monitor_dict or mem_cube_id not in monitor_dict[user_id]:
            logger.warning(
                f"MemoryMonitorManager not found for user {user_id}, "
                f"mem_cube {mem_cube_id}, type {memory_type}"
            )
            return []

        db_manager: DBManagerForMemoryMonitorManager = monitor_dict[user_id][mem_cube_id]
        # Load latest data from database before accessing
        db_manager.sync_with_orm()

        # Sort memories by recording_count in descending order and return top_k items
        sorted_memory_monitors = db_manager.obj.get_sorted_mem_monitors(reverse=True)
        sorted_text_memories = [m.memory_text for m in sorted_memory_monitors[:top_k]]
        return sorted_text_memories

    def get_monitors_info(self, user_id: str, mem_cube_id: str) -> dict[str, Any]:
        """Retrieves monitoring information for a specific memory cube."""
        if (
            user_id not in self.working_memory_monitors
            or mem_cube_id not in self.working_memory_monitors[user_id]
        ):
            logger.warning(
                f"MemoryMonitorManager not found for user {user_id}, mem_cube {mem_cube_id}"
            )
            return {}

        info_dict = {}
        for db_manager in [
            self.working_memory_monitors[user_id][mem_cube_id],
            self.activation_memory_monitors[user_id][mem_cube_id],
        ]:
            # Sync with database to get latest data
            db_manager.sync_with_orm()
            manager = db_manager.obj
            info_dict[str(type(manager))] = {
                "user_id": user_id,
                "mem_cube_id": mem_cube_id,
                "memory_count": manager.memory_size,
                "max_capacity": manager.max_capacity,
                "top_memories": self.get_monitor_memories(user_id, mem_cube_id, top_k=1),
            }
        return info_dict

    def detect_intent(
        self,
        q_list: list[str],
        text_working_memory: list[str],
        prompt_name="intent_recognizing",
    ) -> dict[str, Any]:
        """
        Detect the intent of the user input.
        """
        prompt = self.build_prompt(
            template_name=prompt_name,
            q_list=q_list,
            working_memory_list=text_working_memory,
        )
        response = self._process_llm.generate([{"role": "user", "content": prompt}])
        try:
            response = extract_json_dict(response)
            assert ("trigger_retrieval" in response) and ("missing_evidences" in response)
        except Exception:
            logger.error(f"Fail to extract json dict from response: {response}")
            response = {"trigger_retrieval": False, "missing_evidences": q_list}
        return response

    def close(self):
        """Close all database connections and clean up resources"""
        logger.info("Closing database connections for all monitors")

        # Close all query monitor database managers
        for user_monitors in self.query_monitors.values():
            for db_manager in user_monitors.values():
                try:
                    db_manager.close()
                except Exception as e:
                    logger.error(f"Error closing query monitor DB manager: {e}")

        # Close all working memory monitor database managers
        for user_monitors in self.working_memory_monitors.values():
            for db_manager in user_monitors.values():
                try:
                    db_manager.close()
                except Exception as e:
                    logger.error(f"Error closing working memory monitor DB manager: {e}")

        # Close all activation memory monitor database managers
        for user_monitors in self.activation_memory_monitors.values():
            for db_manager in user_monitors.values():
                try:
                    db_manager.close()
                except Exception as e:
                    logger.error(f"Error closing activation memory monitor DB manager: {e}")

        logger.info("All database connections closed")
