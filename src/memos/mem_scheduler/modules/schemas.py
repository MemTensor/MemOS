from datetime import datetime
from pathlib import Path
from typing import ClassVar, TypeVar
from uuid import uuid4

from pydantic import BaseModel, Field
from typing_extensions import TypedDict

from memos.mem_cube.general import GeneralMemCube


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent

QUERY_LABEL = "query"
ANSWER_LABEL = "answer"

TreeTextMemory_SEARCH_METHOD = "tree_text_memory_search"
TextMemory_SEARCH_METHOD = "text_memory_search"
DEFAULT_ACTIVATION_MEM_SIZE = 5
DEFAULT_ACT_MEM_DUMP_PATH = f"{BASE_DIR}/outputs/mem_scheduler/mem_cube_scheduler_test.kv_cache"
DEFAULT_THREAD__POOL_MAX_WORKERS = 5
DEFAULT_CONSUME_INTERVAL_SECONDS = 3
NOT_INITIALIZED = -1
BaseModelType = TypeVar("T", bound="BaseModel")


class DictConversionMixin:
    def to_dict(self) -> dict:
        """Convert the instance to a dictionary."""
        return {
            **self.dict(),
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


class ScheduleMessageItem(BaseModel, DictConversionMixin):
    item_id: str = Field(description="uuid", default_factory=lambda: str(uuid4()))
    user_id: str = Field(..., description="user id")
    mem_cube_id: str = Field(..., description="memcube id")
    message_id: str = Field(default=str(uuid4()), description="message id")
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
            "mem_cube_id": self.mem_cube_id,
            "message_id": self.message_id,
            "label": self.label,
            "mem_cube": "Not Applicable",  # Custom cube serialization
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ScheduleMessageItem":
        """Create model from Redis Stream dictionary"""
        return cls(
            item_id=data.get("item_id", str(uuid4())),
            user_id=data["user_id"],
            mem_cube_id=data["mem_cube_id"],
            message_id=data.get("message_id", str(uuid4())),
            label=data["label"],
            mem_cube="Not Applicable",  # Custom cube deserialization
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
        description="Unique identifier for the log entry", default_factory=lambda: str(uuid4())
    )
    user_id: str = Field(..., description="Identifier for the user associated with the log")
    mem_cube_id: str = Field(
        ..., description="Identifier for the memcube associated with this log entry"
    )
    label: str = Field(..., description="Label categorizing the type of log")
    log_title: str = Field(..., description="Title or brief summary of the log content")
    log_content: str = Field(..., description="Detailed content of the log entry")
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
