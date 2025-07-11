import json
from typing import Any, List, Dict

from memos.mem_scheduler.modules.misc import AutoDroppingQueue as Queue
from memos.log import get_logger
from memos.llms.base import BaseLLM
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.base import BaseSchedulerModule
from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.mem_scheduler.utils import extract_json_dict
from memos.memories.textual.tree import TreeTextMemory
from memos.mem_scheduler.modules.schemas import (
    DEFAULT_ACTIVATION_MEM_SIZE,
    MemoryMonitorManager,
    MemoryMonitorItem,
    UserID,
    MemCubeID,
)

logger = get_logger(__name__)




class SchedulerMonitor(BaseSchedulerModule):
    """Monitors and manages scheduling operations with LLM integration."""

    def __init__(self, process_llm: BaseLLM,
                 config: BaseSchedulerConfig):
        super().__init__()

        # hyper-parameters
        self.config: BaseSchedulerConfig = config
        self.activation_mem_size = self.config.get(
            "activation_mem_size", DEFAULT_ACTIVATION_MEM_SIZE
        )

        # attributes
        self.working_memory_monitors: Dict[UserID, Dict[MemCubeID, MemoryMonitorManager]] = {}
        # Partial Retention Strategy
        self.partial_retention_number = 3
        self.loose_max_capacity = 20

        # Others
        self.query_history = Queue(maxsize=self.config.context_window_size)
        self.intent_history = Queue(maxsize=self.config.context_window_size)

        self.activation_memory_freq_list = [
            {"memory": None, "count": 0} for _ in range(self.activation_mem_size)
        ]

        self._process_llm = process_llm

    def update_mem_cube_info(self, user_id: str,  mem_cube: GeneralMemCube):
        mem_cube_id = mem_cube.id
        text_mem_base: TreeTextMemory = mem_cube.text_mem

        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error("Not Implemented")
            return

        # Check if a MemoryMonitorManager already exists for the current user_id and mem_cube_id
        # If exists, reuse it directly; otherwise, create a new one
        if user_id in self.working_memory_monitors and mem_cube_id in self.working_memory_monitors[user_id]:
            monitor_manager = self.working_memory_monitors[user_id][mem_cube_id]
        else:

            self.loose_max_capacity = min(self.loose_max_capacity,
                                          (text_mem_base.memory_manager.memory_size["WorkingMemory"] +
                                            self.partial_retention_number))
            # Initialize MemoryMonitorManager with user ID, memory cube ID, and max capacity (from WorkingMemory size)
            monitor_manager = MemoryMonitorManager(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                max_capacity=self.loose_max_capacity
            )
            # Use setdefault to safely get or create the nested dict for user_id,
            # then assign the monitor_manager to the mem_cube_id key
            # (No side effects if the user_id dict already exists)
            self.working_memory_monitors.setdefault(user_id, {})[mem_cube_id] = monitor_manager

        # Retrieve current working memory content
        working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in working_memory]

        monitor_manager.update_memories(memory_text_list=text_working_memory,
                                        partial_retention_number=partial_retention_number)

    def get_scheduler_working_memories(self, user_id: str, mem_cube_id: str, top_k: int = 10) -> List[MemoryMonitorItem]:
        """Retrieves working memory items managed by the scheduler, sorted by recording count.

        Args:
            user_id: Unique identifier of the user
            mem_cube_id: Unique identifier of the memory cube
            top_k: Maximum number of memory items to return (default: 10)

        Returns:
            List of dictionaries containing memory details, sorted by recording count in descending order.
            Each dictionary includes "memory_text", "recording_count", "importance_score", and "item_id".
            Returns empty list if no MemoryMonitorManager exists for the given user and memory cube.
        """
        if user_id not in self.working_memory_monitors or mem_cube_id not in self.working_memory_monitors[user_id]:
            logger.warning(f"MemoryMonitorManager not found for user {user_id}, mem_cube {mem_cube_id}")
            return []

        manager = self.working_memory_monitors[user_id][mem_cube_id]
        # Sort memories by recording_count in descending order and return top_k items
        sorted_memories = sorted(
            manager.memories,
            key=lambda m: m.recording_count,
            reverse=True
        )
        return sorted_memories[:top_k]

    def get_mem_cube_info(self, user_id: str, mem_cube_id: str) -> Dict[str, Any]:
        """Retrieves monitoring information for a specific memory cube.

        Args:
            user_id: Unique identifier of the user associated with the memory cube
            mem_cube: GeneralMemCube instance to retrieve information for

        Returns:
            Dictionary containing comprehensive memory cube metrics, including:
            - user_id: Associated user identifier
            - mem_cube_id: Memory cube identifier
            - memory_count: Current number of stored memories
            - max_capacity: Maximum allowed memories (or None for unlimited)
            - top_memory: Top 1 memory
            Returns empty dictionary if no monitoring data exists.
        """
        if user_id not in self.working_memory_monitors or mem_cube_id not in self.working_memory_monitors[user_id]:
            logger.warning(f"MemoryMonitorManager not found for user {user_id}, mem_cube {mem_cube_id}")
            return {}

        manager = self.working_memory_monitors[user_id][mem_cube_id]

        return {
            "user_id": user_id,
            "mem_cube_id": mem_cube_id,
            "memory_count": manager.memory_size,
            "max_capacity": manager.max_capacity,
            "top_memories": self.get_scheduler_working_memories(user_id, mem_cube_id, top_k=1),
        }


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
        except:
            logger.error(f"Fail to extract json dict from response: {response}")
            response = {"trigger_retrieval": False, "missing_evidences": q_list}
        return response


    def update_freq(
        self,
        answer: str,
        text_working_memory: list[str],
        activation_memory_freq_list: list[dict],
        prompt_name="freq_detecting",
    ) -> list[dict]:
        """
        Use LLM to detect which memories in activation_memory_freq_list appear in the answer,
        increment their count by 1, and return the updated list.
        """
        # TODO: This is not implemented yet
        prompt = self.build_prompt(
            template_name=prompt_name,
            answer=answer,
            working_memory_list=text_working_memory,
            activation_memory_freq_list=activation_memory_freq_list,
        )
        response = self._process_llm.generate([{"role": "user", "content": prompt}])
        try:
            result = json.loads(response)
        except Exception as e:
            logger.error(e)
            result = activation_memory_freq_list
        return result
