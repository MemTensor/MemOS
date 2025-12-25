import os

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, computed_field

from memos.log import get_logger
from memos.mem_scheduler.general_modules.misc import DictConversionMixin
from memos.mem_scheduler.utils.db_utils import get_utc_now


logger = get_logger(__name__)

FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent


# ============== Schedule Task Definitaion ==============
class TaskPriorityLevel(Enum):
    # priority top
    LEVEL_1 = 1
    LEVEL_2 = 2
    LEVEL_3 = 3
    # priority bottom


QUERY_TASK_LABEL = "query"
ANSWER_TASK_LABEL = "answer"
ADD_TASK_LABEL = "add"
MEM_READ_TASK_LABEL = "mem_read"
MEM_ORGANIZE_TASK_LABEL = "mem_organize"
MEM_UPDATE_TASK_LABEL = "mem_update"
MEM_ARCHIVE_TASK_LABEL = "mem_archive"
API_MIX_SEARCH_TASK_LABEL = "api_mix_search"
PREF_ADD_TASK_LABEL = "pref_add"
MEM_FEEDBACK_TASK_LABEL = "mem_feedback"

# Additional constants moved from general_schemas
DEFAULT_MAX_QUERY_KEY_WORDS = 1000
LONG_TERM_MEMORY_TYPE = "LongTermMemory"
USER_INPUT_TYPE = "UserInput"
NOT_APPLICABLE_TYPE = "NotApplicable"


# scheduler daemon defaults
# Interval in seconds for periodically releasing stale pending messages
DEFAULT_PENDING_REQUEUE_INTERVAL_SEC = 30.0

# Interval in seconds for refreshing cached Redis stream keys
DEFAULT_STREAM_KEYS_REFRESH_INTERVAL_SEC = 30.0

# Interval in seconds for batching and cleaning up deletions (xdel)
DEFAULT_DELETE_CLEANUP_INTERVAL_SEC = 30.0

# pending claim configuration
# Only claim pending messages whose idle time exceeds this threshold.
# Unit: milliseconds. Default: 1 hour.
DEFAULT_PENDING_CLAIM_MIN_IDLE_MS = 3_600_000


# Recency threshold for active streams
# Consider a stream "active" if its last message is within this window.
# Unit: seconds. Default: 1 hours.
DEFAULT_STREAM_RECENT_ACTIVE_SECONDS = 3_600.0


# Inactivity threshold for stream deletion
# Delete streams whose last message ID timestamp is older than this threshold.
# Unit: seconds. Default: 2 hour.
DEFAULT_STREAM_INACTIVITY_DELETE_SECONDS = 7_200.0


# task queue
DEFAULT_STREAM_KEY_PREFIX = os.getenv(
    "MEMSCHEDULER_STREAM_KEY_PREFIX", "scheduler:messages:stream:v2.0"
)


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
    start_time: datetime = Field(description="Task start time", default_factory=get_utc_now)
    end_time: datetime | None = Field(default=None, description="Task completion time")
    status: str = Field(default="running", description="Task status: running, completed, failed")
    result: Any | None = Field(default=None, description="Task execution result")
    error_message: str | None = Field(default=None, description="Error message if task failed")
    messages: list[Any] | None = Field(
        default=None, description="List of messages being processed by this task"
    )

    def mark_completed(self, result: Any | None = None) -> None:
        """Mark task as completed with optional result."""
        self.end_time = get_utc_now()
        self.status = "completed"
        self.result = result

    def mark_failed(self, error_message: str) -> None:
        """Mark task as failed with error message."""
        self.end_time = get_utc_now()
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
