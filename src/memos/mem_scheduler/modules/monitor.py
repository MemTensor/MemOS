from datetime import datetime
from typing import Any

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.llms.base import BaseLLM
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.base import BaseSchedulerModule
from memos.mem_scheduler.modules.misc import AutoDroppingQueue as Queue
from memos.mem_scheduler.modules.schemas import (
    DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT,
    DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT,
    MONITOR_ACTIVATION_MEMORY_TYPE,
    MONITOR_WORKING_MEMORY_TYPE,
    MemCubeID,
    MemoryMonitorManager,
    UserID,
)
from memos.mem_scheduler.utils import extract_json_dict
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


logger = get_logger(__name__)




class SchedulerMonitor(BaseSchedulerModule):
    """Monitors and manages scheduling operations with LLM integration."""

    def __init__(self, process_llm: BaseLLM, config: BaseSchedulerConfig):
        super().__init__()

        # hyper-parameters
        self.config: BaseSchedulerConfig = config
        self.act_mem_update_interval = self.config.get("act_mem_update_interval", 300)

        # Partial Retention Strategy
        self.partial_retention_number = 2
        self.working_mem_monitor_capacity = DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT
        self.activation_mem_monitor_capacity = DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT

        # attributes
        self.query_history = Queue(maxsize=self.config.context_window_size)
        self.intent_history = Queue(maxsize=self.config.context_window_size)
        self.working_memory_monitors: dict[UserID, dict[MemCubeID, MemoryMonitorManager]] = {}
        self.activation_memory_monitors: dict[UserID, dict[MemCubeID, MemoryMonitorManager]] = {}

        # Lifecycle monitor
        self._last_activation_mem_update_time = datetime.min

        self._process_llm = process_llm

    def register_memory_manager_if_not_exists(
        self,
        user_id: str,
        mem_cube_id: str,
        memory_monitors: dict[UserID, dict[MemCubeID, MemoryMonitorManager]],
        max_capacity: int,
    ) -> None:
        """
        Register a new MemoryMonitorManager for the given user and memory cube if it doesn't exist.

        Checks if a MemoryMonitorManager already exists for the specified user_id and mem_cube_id.
        If not, creates a new MemoryMonitorManager with appropriate capacity settings and registers it.

        Args:
            user_id: The ID of the user to associate with the memory manager
            mem_cube_id: The ID of the memory cube to monitor

        Note:
            This function will update the loose_max_working_memory_capacity based on the current
            WorkingMemory size plus partial retention number before creating a new manager.
        """
        # Check if a MemoryMonitorManager already exists for the current user_id and mem_cube_id
        # If doesn't exist, create and register a new one
        if (user_id not in memory_monitors) or (mem_cube_id not in memory_monitors[user_id]):
            # Initialize MemoryMonitorManager with user ID, memory cube ID, and max capacity
            monitor_manager = MemoryMonitorManager(
                user_id=user_id, mem_cube_id=mem_cube_id, max_capacity=max_capacity
            )

            # Safely register the new manager in the nested dictionary structure
            memory_monitors.setdefault(user_id, {})[mem_cube_id] = monitor_manager
            logger.info(
                f"Registered new MemoryMonitorManager for user_id={user_id},"
                f" mem_cube_id={mem_cube_id} with max_capacity={max_capacity}"
            )
        else:
            logger.info(
                f"MemoryMonitorManager already exists for user_id={user_id}, "
                f"mem_cube_id={mem_cube_id} in the provided memory_monitors dictionary"
            )

    def update_memory_monitors(self, user_id: str, mem_cube_id: str, mem_cube: GeneralMemCube):
        text_mem_base: TreeTextMemory = mem_cube.text_mem

        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error("Not Implemented")
            return

        self.working_mem_monitor_capacity = min(
            DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT,
            (
                text_mem_base.memory_manager.memory_size["WorkingMemory"]
                + self.partial_retention_number
            ),
        )

        self.update_working_memory_monitors(
            user_id=user_id, mem_cube_id=mem_cube_id, mem_cube=mem_cube
        )

        self.update_activation_memory_monitors(
            user_id=user_id, mem_cube_id=mem_cube_id, mem_cube=mem_cube
        )

    def update_working_memory_monitors(
        self, user_id: str, mem_cube_id: str, mem_cube: GeneralMemCube
    ):
        # register monitors
        self.register_memory_manager_if_not_exists(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            memory_monitors=self.working_memory_monitors,
            max_capacity=self.working_mem_monitor_capacity,
        )

        # === update working memory monitors ===
        # Retrieve current working memory content
        text_mem_base: TreeTextMemory = mem_cube.text_mem
        working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in working_memory]

        self.working_memory_monitors[user_id][mem_cube_id].update_memories(
            text_working_memories=text_working_memory,
            partial_retention_number=self.partial_retention_number,
        )

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
        top_k_memories = sorted(
            self.working_memory_monitors[user_id][mem_cube_id].memories,
            key=lambda m: m.get_score(),
            reverse=True,
        )[: self.activation_mem_monitor_capacity]

        # Extract just the text from these memories
        text_top_k_memories = [m.memory_text for m in top_k_memories]

        # Update the activation memory monitors with these important memories
        self.activation_memory_monitors[user_id][mem_cube_id].update_memories(
            text_working_memories=text_top_k_memories,
            partial_retention_number=self.partial_retention_number,
        )

    def timed_trigger(self, last_time: datetime, interval_seconds: float) -> bool:
        now = datetime.now()
        elapsed = (now - last_time).total_seconds()
        if elapsed >= interval_seconds:
            return True
        logger.debug(f"Time trigger not ready, {elapsed:.1f}s elapsed (needs {interval_seconds}s)")
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

        manager = monitor_dict[user_id][mem_cube_id]
        # Sort memories by recording_count in descending order and return top_k items
        sorted_memories = sorted(manager.memories, key=lambda m: m.recording_count, reverse=True)
        sorted_text_memories = [m.memory_text for m in sorted_memories[:top_k]]
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
        for manager in [
            self.working_memory_monitors[user_id][mem_cube_id],
            self.activation_memory_monitors[user_id][mem_cube_id],
        ]:
            info_dict[str(type(manager))] = {
                "user_id": user_id,
                "mem_cube_id": mem_cube_id,
                "memory_count": manager.memory_size,
                "max_capacity": manager.max_capacity,
                "top_memories": self.get_scheduler_working_memories(user_id, mem_cube_id, top_k=1),
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
