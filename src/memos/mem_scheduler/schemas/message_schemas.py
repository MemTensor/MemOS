from datetime import datetime
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from typing_extensions import TypedDict

from memos.context.context import generate_trace_id
from memos.log import get_logger
from memos.mem_scheduler.general_modules.misc import DictConversionMixin
from memos.mem_scheduler.utils.db_utils import get_utc_now

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
    redis_message_id: str = Field(default="", description="the message get from redis stream")
    stream_key: str = Field("", description="stream_key for identifying the queue in line")
    user_id: str = Field(..., description="user id")
    trace_id: str = Field(default_factory=generate_trace_id, description="trace id for logging")
    mem_cube_id: str = Field(..., description="memcube id")
    session_id: str = Field(default="", description="Session ID for soft-filtering memories")
    label: str = Field(..., description="Label of the schedule message")
    content: str = Field(..., description="Content of the schedule message")
    timestamp: datetime = Field(
        default_factory=get_utc_now, description="submit time for schedule_messages"
    )
    user_name: str = Field(
        default="",
        description="user name / display name (optional)",
    )
    info: dict | None = Field(default=None, description="user custom info")
    task_id: str | None = Field(
        default=None,
        description="Optional business-level task ID. Multiple items can share the same task_id.",
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
                "content": "sample content",  # Example message content
                "timestamp": "2024-07-22T12:00:00Z",  # Added timestamp example
                "user_name": "Alice",  # Added username example
            }
        },
    )

    def to_dict(self) -> dict:
        """Convert model to dictionary suitable for Redis Stream"""
        return {
            "item_id": self.item_id,
            "user_id": self.user_id,
            "cube_id": self.mem_cube_id,
            "trace_id": self.trace_id,
            "label": self.label,
            "cube": "Not Applicable",  # Custom cube serialization
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "user_name": self.user_name,
            "task_id": self.task_id if self.task_id is not None else "",
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ScheduleMessageItem":
        """Create model from Redis Stream dictionary"""
        return cls(
            item_id=data.get("item_id", str(uuid4())),
            user_id=data["user_id"],
            mem_cube_id=data["cube_id"],
            trace_id=data.get("trace_id", generate_trace_id()),
            label=data["label"],
            content=data["content"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
            user_name=data.get("user_name"),
            task_id=data.get("task_id"),
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
    task_id: str | None = Field(default=None, description="Identifier for the parent task")
    user_id: str = Field(..., description="Identifier for the user associated with the log")
    mem_cube_id: str = Field(
        ..., description="Identifier for the memcube associated with this log entry"
    )
    label: str = Field(..., description="Label categorizing the type of log")
    from_memory_type: str | None = Field(None, description="Source memory type")
    to_memory_type: str | None = Field(None, description="Destination memory type")
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
        default_factory=get_utc_now,
        description="Timestamp indicating when the log entry was created",
    )
    memcube_log_content: list[dict] | None = Field(
        default=None, description="Structured memcube log content list"
    )
    metadata: list[dict] | None = Field(
        default=None, description="Structured metadata list for each log item"
    )
    memcube_name: str | None = Field(default=None, description="Display name for memcube")
    memory_len: int | None = Field(default=None, description="Count of items involved in the event")
    status: str | None = Field(
        default=None, description="Completion status of the task (e.g., 'completed', 'failed')"
    )
    source_doc_id: str | None = Field(default=None, description="Source document ID")

    def debug_info(self) -> dict[str, Any]:
        """Return structured debug information for logging purposes."""
        return {
            "content_preview:": self.log_content[:50],
            "log_id": self.item_id,
            "user_id": self.user_id,
            "mem_cube_id": self.mem_cube_id,
            "operation": f"{self.from_memory_type} → {self.to_memory_type}",
            "label": self.label,
            "content_length": len(self.log_content),
            "timestamp": self.timestamp.isoformat(),
        }
