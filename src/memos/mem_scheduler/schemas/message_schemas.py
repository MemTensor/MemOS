from datetime import datetime
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_serializer
from typing_extensions import TypedDict

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.misc import DictConversionMixin

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
        default_factory=lambda: datetime.utcnow(), description="submit time for schedule_messages"
    )

    # Pydantic V2 model configuration
    model_config = ConfigDict(
        # Allows arbitrary Python types as model fields without validation
        # Required when using custom types like GeneralMemCube that aren't Pydantic models
        arbitrary_types_allowed=True,
        # Additional metadata for JSON Schema generation
        json_schema_extra={
            # Example payload demonstrating the expected structure and sample values
            # Used for API documentation, testing, and developer reference
            "example": {
                "item_id": "123e4567-e89b-12d3-a456-426614174000",  # Sample UUID
                "user_id": "user123",  # Example user identifier
                "mem_cube_id": "cube456",  # Sample memory cube ID
                "label": "sample_label",  # Demonstration label value
                "mem_cube": "obj of GeneralMemCube",  # Added mem_cube example
                "content": "sample content",  # Example message content
                "timestamp": "2024-07-22T12:00:00Z",  # Added timestamp example
            }
        },
    )

    @field_serializer("mem_cube")
    def serialize_mem_cube(self, cube: GeneralMemCube | str, _info) -> str:
        """Custom serializer for GeneralMemCube objects to string representation"""
        if isinstance(cube, str):
            return cube
        return f"<GeneralMemCube:{id(cube)}>"

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
        default_factory=lambda: datetime.utcnow(),
        description="Timestamp indicating when the log entry was created",
    )

    def debug_info(self) -> dict[str, Any]:
        """Return structured debug information for logging purposes."""
        return {
            "log_id": self.item_id,
            "user_id": self.user_id,
            "mem_cube_id": self.mem_cube_id,
            "operation": f"{self.from_memory_type} → {self.to_memory_type}",
            "label": self.label,
            "content_length": len(self.log_content),
            "timestamp": self.timestamp.isoformat(),
        }
