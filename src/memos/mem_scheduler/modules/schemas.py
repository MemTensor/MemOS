import os
from uuid import uuid4
from datetime import datetime
from pathlib import Path
from typing_extensions import TypedDict
from typing import ClassVar, TypeVar, List, Optional, NewType
from pydantic import BaseModel, Field, computed_field

from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.utils import parse_yaml
from memos.log import get_logger

logger = get_logger(__name__)


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent

QUERY_LABEL = "query"
ANSWER_LABEL = "answer"
ADD_LABEL = "add"

TreeTextMemory_SEARCH_METHOD = "tree_text_memory_search"
TextMemory_SEARCH_METHOD = "text_memory_search"
DIRECT_EXCHANGE_TYPE = "direct"
FANOUT_EXCHANGE_TYPE = "fanout"
DEFAULT_ACTIVATION_MEM_SIZE = 5
DEFAULT_ACT_MEM_DUMP_PATH = f"{BASE_DIR}/outputs/mem_scheduler/mem_cube_scheduler_test.kv_cache"
DEFAULT_THREAD__POOL_MAX_WORKERS = 5
DEFAULT_CONSUME_INTERVAL_SECONDS = 3
NOT_INITIALIZED = -1
BaseModelType = TypeVar("T", bound="BaseModel")

# memory types
LONG_TERM_MEMORY_TYPE = "LongTermMemory"
USER_MEMORY_TYPE = "UserMemory"
WORKING_MEMORY_TYPE = "WorkingMemory"
TEXT_MEMORY_TYPE = "TextMemory"
ACTIVATION_MEMORY_TYPE = "ActivationMemory"

# monitors
MONITOR_WORKING_MEMORY_TYPE = "MonitorWorkingMemoryType"
MONITOR_ACTIVATION_MEMORY_TYPE = "MonitorActivationMemoryType"

# Backends
ACTIVATION_MEMORY_VLLM_BACKEND = "VLLMForActivationMemory"
ACTIVATION_MEMORY_HF_BACKEND = "HugggingaceForActivationMemory"

# new types
UserID = NewType('UserID', str)
MemCubeID = NewType('CubeID', str)

# ************************* Public *************************
class DictConversionMixin:
    def to_dict(self) -> dict:
        """Convert the instance to a dictionary."""
        return {
            **self.model_dump(),  # 替换 self.dict()
            "timestamp": self.timestamp.isoformat() if hasattr(self, "timestamp") else None,
        }

    @classmethod
    def from_dict(cls: type[BaseModelType], data: dict) -> BaseModelType:
        """Create an instance from a dictionary."""
        if "timestamp" in data:
            data["timestamp"] = datetime.fromisoformat(data["timestamp"])
        return cls(**data)

    def __str__(self) -> str:
        """Convert the instance to a JSON string with indentation of 4 spaces.
        This will be used when str() or print() is called on the instance.

        Returns:
            str: A JSON string representation of the instance with 4-space indentation.
        """
        return json.dumps(
            self.to_dict(),
            indent=4,
            ensure_ascii=False,
            default=str  # 处理无法序列化的对象
        )


    class Config:
        json_encoders: ClassVar[dict[type, object]] = {datetime: lambda v: v.isoformat()}


# ************************* Messages *************************
class ScheduleMessageItem(BaseModel, DictConversionMixin):
    item_id: str = Field(description="uuid", default_factory=lambda: str(uuid4()))
    user_id: str = Field(..., description="user id")
    mem_cube_id: str = Field(..., description="memcube id")
    label: str = Field(..., description="Label of the schedule message")
    mem_cube: GeneralMemCube | str = Field(..., description="memcube for schedule")
    content: str = Field(..., description="Content of the schedule message")
    timestamp: datetime = Field(
        default_factory=datetime.now, description="submit time for schedule_messages"
    )

    class Config:
        arbitrary_types_allowed = True
        json_encoders: ClassVar[dict[type, object]] = {
            datetime: lambda v: v.isoformat(),
            GeneralMemCube: lambda v: f"<GeneralMemCube:{id(v)}>",
        }

    def to_dict(self) -> dict:
        """Convert model to dictionary suitable for Redis Stream"""
        return {
            "item_id": self.item_id,
            "user_id": self.user_id,
            "cube_id": self.mem_cube_id,
            "label": self.label,
            "cube": "Not Applicable",  # Custom cube serialization
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ScheduleMessageItem":
        """Create model from Redis Stream dictionary"""
        return cls(
            item_id=data.get("item_id", str(uuid4())),
            user_id=data["user_id"],
            cube_id=data["cube_id"],
            label=data["label"],
            cube="Not Applicable",  # Custom cube deserialization
            content=data["content"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
        )


class MemorySizes(TypedDict):
    long_term_memory_size: int
    user_memory_size: int
    working_memory_size: int
    transformed_act_memory_size: int


class MemoryCapacities(TypedDict):
    long_term_memory_capacity: int
    user_memory_capacity: int
    working_memory_capacity: int
    transformed_act_memory_capacity: int


DEFAULT_MEMORY_SIZES = {
    "long_term_memory_size": NOT_INITIALIZED,
    "user_memory_size": NOT_INITIALIZED,
    "working_memory_size": NOT_INITIALIZED,
    "transformed_act_memory_size": NOT_INITIALIZED,
    "parameter_memory_size": NOT_INITIALIZED,
}

DEFAULT_MEMORY_CAPACITIES = {
    "long_term_memory_capacity": 10000,
    "user_memory_capacity": 10000,
    "working_memory_capacity": 20,
    "transformed_act_memory_capacity": NOT_INITIALIZED,
    "parameter_memory_capacity": NOT_INITIALIZED,
}


class ScheduleLogForWebItem(BaseModel, DictConversionMixin):
    item_id: str = Field(
        description="Unique identifier for the log entry",
        default_factory=lambda: str(uuid4())
    )
    user_id: str = Field(
        ...,
        description="Identifier for the user associated with the log"
    )
    mem_cube_id: str = Field(
        ...,
        description="Identifier for the memcube associated with this log entry"
    )
    label: str = Field(
        ...,
        description="Label categorizing the type of log"
    )
    from_memory_type: str = Field(
        ...,
        description="Source memory type"
    )
    to_memory_type: str = Field(
        ...,
        description="Destination memory type"
    )
    log_content: str = Field(
        ...,
        description="Detailed content of the log entry"
    )
    current_memory_sizes: MemorySizes = Field(
        default_factory=lambda: dict(DEFAULT_MEMORY_SIZES),
        description="Current utilization of memory partitions",
    )
    memory_capacities: MemoryCapacities = Field(
        default_factory=lambda: dict(DEFAULT_MEMORY_CAPACITIES),
        description="Maximum capacities of memory partitions",
    )
    timestamp: datetime = Field(
        default_factory=datetime.now,
        description="Timestamp indicating when the log entry was created",
    )


# ************************* Monitor *************************
class MemoryMonitorItem(BaseModel, DictConversionMixin):
    item_id: str = Field(
        description="Unique identifier for the memory item",
        default_factory=lambda: str(uuid4())
    )
    memory_text: str = Field(
        ...,
        description="The actual content of the memory",
        min_length=1,
        max_length=10000  # Prevent excessively large memory texts
    )
    importance_score: float = Field(
        default=0.0,
        description="Numerical score representing the memory's importance",
        ge=0.0  # Minimum value of 0
    )
    recording_count: int = Field(
        default=1,
        description="How many times this memory has been recorded",
        ge=1  # Greater than or equal to 1
    )

class MemoryMonitorManager(BaseModel, DictConversionMixin):
    user_id: str = Field(
        ...,
        description="Required user identifier",
        min_length=1
    )
    mem_cube_id: str = Field(
        ...,
        description="Required memory cube identifier",
        min_length=1
    )
    memories: List[MemoryMonitorItem] = Field(
        default_factory=list,
        description="Collection of memory items"
    )
    max_capacity: Optional[int] = Field(
        default=None,
        description="Maximum number of memories allowed (None for unlimited)",
        ge=1
    )

    @computed_field
    @property
    def memory_size(self) -> int:
        """Automatically calculated count of memory items."""
        return len(self.memories)

    def update_memories(
            self,
            text_working_memories: List[str],
            partial_retention_number: int
    ) -> MemoryMonitorItem:
        """
        Update memories based on text_working_memories.

        Args:
            text_working_memories: List of memory texts to update
            partial_retention_number: Number of top memories to keep by recording count

        Returns:
            List of added or updated MemoryMonitorItem instances
        """

        # Validate partial_retention_number
        if partial_retention_number < 0:
            raise ValueError("partial_retention_number must be non-negative")

        # Create text lookup set
        working_memory_set = set(text_working_memories)

        # Step 1: Update existing memories or add new ones
        added_or_updated = []
        memory_text_map = {item.memory_text: item for item in self.memories}

        for text in text_working_memories:
            if text in memory_text_map:
                # Update existing memory
                memory = memory_text_map[text]
                memory.recording_count += 1
                added_or_updated.append(memory)
            else:
                # Add new memory
                new_memory = MemoryMonitorItem(
                    memory_text=text,
                    recording_count=1
                )
                self.memories.append(new_memory)
                added_or_updated.append(new_memory)

        # Step 2: Identify memories to remove
        # Sort memories by recording_count in descending order
        sorted_memories = sorted(
            self.memories,
            key=lambda item: item.recording_count,
            reverse=True
        )

        # Keep the top N memories by recording_count
        records_to_keep = set(memory.memory_text for memory in sorted_memories[:partial_retention_number])

        # Collect memories to remove: not in current working memory and not in top N
        memories_to_remove = [
            memory
            for memory in self.memories
            if memory.memory_text not in working_memory_set and memory.memory_text not in records_to_keep
        ]

        # Step 3: Remove identified memories
        for memory in memories_to_remove:
            self.memories.remove(memory)

        # Step 4: Enforce max_capacity if set
        if self.max_capacity is not None and len(self.memories) > self.max_capacity:
            # Sort by importance and then recording count
            sorted_memories = sorted(
                self.memories,
                key=lambda item: (item.importance_score, item.recording_count),
                reverse=True
            )
            # Keep only the top max_capacity memories
            self.memories = sorted_memories[:self.max_capacity]

        # Log the update result
        logger.info(f"Updated monitor manager for user {self.user_id}, mem_cube {self.mem_cube_id}: "
                    f"Total memories: {len(self.memories)}, "
                    f"Added/Updated: {len(added_or_updated)}, "
                    f"Removed: {len(memories_to_remove)} (excluding top {partial_retention_number} by recording_count)")

        return added_or_updated