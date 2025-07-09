import os
from datetime import datetime
from pathlib import Path
from typing import ClassVar, TypeVar, List, Optional
from uuid import uuid4

from pydantic import BaseModel, Field, computed_field
from typing_extensions import TypedDict

from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.utils import parse_yaml


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent

QUERY_LABEL = "query"
ANSWER_LABEL = "answer"

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
    recording_count: int = Field(
        default=1,
        description="How many times this memory has been recorded",
        ge=1  # Greater than or equal to 1
    )

class MemoryMonitorManager(BaseModel, DictConversionMixin):
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

    def add_memory(self, memory_text: str) -> MemoryMonitorItem:
        """Add a new memory or increment count if it already exists."""
        if self.max_capacity is not None and self.memory_size >= self.max_capacity:
            raise ValueError(f"Memory capacity reached (max {self.max_capacity})")

        memory_text = memory_text.strip()
        for item in self.memories:
            if item.memory_text.lower() == memory_text.lower():
                item.increment_count()
                return item

        new_item = MemoryMonitorItem(memory_text=memory_text)
        self.memories.append(new_item)
        return new_item

    def get_memory(self, item_id: str) -> Optional[MemoryMonitorItem]:
        """Retrieve a memory by its ID."""
        return next((item for item in self.memories if item.item_id == item_id), None)

    def remove_memory(self, item_id: str) -> bool:
        """Remove a memory by its ID, returns True if found and removed."""
        for i, item in enumerate(self.memories):
            if item.item_id == item_id:
                self.memories.pop(i)
                return True
        return False