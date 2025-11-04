from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, computed_field

from memos.log import get_logger
from memos.mem_scheduler.general_modules.misc import DictConversionMixin


logger = get_logger(__name__)

FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent


# ============== Running Tasks ==============
class RunningTaskItem(BaseModel, DictConversionMixin):
    """Data class for tracking running tasks in SchedulerDispatcher."""

    item_id: str = Field(
        description="Unique identifier for the task item", default_factory=lambda: str(uuid4())
    )
    user_id: str = Field(..., description="Required user identifier", min_length=1)
    mem_cube_id: str = Field(..., description="Required memory cube identifier", min_length=1)
    task_info: str = Field(..., description="Information about the task being executed")
    task_name: str = Field(..., description="Name/type of the task handler")
    start_time: datetime = Field(description="Task start time", default_factory=datetime.utcnow)
    end_time: datetime | None = Field(default=None, description="Task completion time")
    status: str = Field(default="running", description="Task status: running, completed, failed")
    result: Any | None = Field(default=None, description="Task execution result")
    error_message: str | None = Field(default=None, description="Error message if task failed")
    messages: list[Any] | None = Field(
        default=None, description="List of messages being processed by this task"
    )

    def mark_completed(self, result: Any | None = None) -> None:
        """Mark task as completed with optional result."""
        self.end_time = datetime.utcnow()
        self.status = "completed"
        self.result = result

    def mark_failed(self, error_message: str) -> None:
        """Mark task as failed with error message."""
        self.end_time = datetime.utcnow()
        self.status = "failed"
        self.error_message = error_message

    @computed_field
    @property
    def duration_seconds(self) -> float | None:
        """Calculate task duration in seconds."""
        if self.end_time:
            return (self.end_time - self.start_time).total_seconds()
        return None

    def get_execution_info(self) -> str:
        """Get formatted execution information for logging."""
        duration = self.duration_seconds
        duration_str = f"{duration:.2f}s" if duration else "ongoing"

        return (
            f"Task {self.task_name} (ID: {self.item_id[:8]}) "
            f"for user {self.user_id}, cube {self.mem_cube_id} - "
            f"Status: {self.status}, Duration: {duration_str}"
        )
