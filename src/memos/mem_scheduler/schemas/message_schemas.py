from datetime import datetime
from typing import ClassVar
from uuid import uuid4

from pydantic import BaseModel, Field
from typing_extensions import TypedDict

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.misc import DictConversionMixin

from .general_schemas import NOT_INITIALIZED


logger = get_logger(__name__)

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


class ScheduleLogForWebItem(BaseModel, DictConversionMixin):
    item_id: str = Field(
        description="Unique identifier for the log entry", default_factory=lambda: str(uuid4())
    )
    user_id: str = Field(..., description="Identifier for the user associated with the log")
    mem_cube_id: str = Field(
        ..., description="Identifier for the memcube associated with this log entry"
    )
    label: str = Field(..., description="Label categorizing the type of log")
    from_memory_type: str = Field(..., description="Source memory type")
    to_memory_type: str = Field(..., description="Destination memory type")
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
