from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from memos.log import get_logger
from memos.mem_scheduler.general_modules.misc import DictConversionMixin
from memos.mem_scheduler.utils.db_utils import get_utc_now
from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


class TaskRunningStatus(str, Enum):
    """Enumeration for task running status values."""

    RUNNING = "running"
    COMPLETED = "completed"


class APIMemoryHistoryEntryItem(BaseModel, DictConversionMixin):
    """Data class for search entry items stored in Redis."""

    item_id: str = Field(
        description="Unique identifier for the task", default_factory=lambda: str(uuid4())
    )
    query: str = Field(..., description="Search query string")
    formatted_memories: Any = Field(..., description="Formatted search results")
    memories: list[TextualMemoryItem] = Field(
        default_factory=list, description="List of TextualMemoryItem objects"
    )
    task_status: str = Field(
        default="running", description="Task status: running, completed, failed"
    )
    session_id: str | None = Field(default=None, description="Optional conversation identifier")
    created_time: datetime = Field(description="Entry creation time", default_factory=get_utc_now)
    timestamp: datetime | None = Field(default=None, description="Timestamp for the entry")
    conversation_turn: int = Field(default=0, description="Turn count for the same session_id")

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        validate_assignment=True,
    )

    @field_serializer("created_time")
    def serialize_created_time(self, value: datetime) -> str:
        """Serialize datetime to ISO format string."""
        return value.isoformat()

    def get(self, key: str, default: Any | None = None) -> Any:
        """
        Get attribute value by key name, similar to dict.get().

        Args:
            key: The attribute name to retrieve
            default: Default value to return if attribute doesn't exist

        Returns:
            The attribute value or default if not found
        """
        return getattr(self, key, default)


class APISearchHistoryManager(BaseModel, DictConversionMixin):
    """
    Data structure for managing search history with separate completed and running entries.
    Supports window_size to limit the number of completed entries.
    """

    window_size: int = Field(default=5, description="Maximum number of completed entries to keep")
    completed_entries: list[APIMemoryHistoryEntryItem] = Field(
        default_factory=list, description="List of completed search entries"
    )
    running_item_ids: list[str] = Field(
        default_factory=list, description="List of running task ids"
    )

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        validate_assignment=True,
    )

    def complete_entry(self, task_id: str) -> bool:
        """
        Remove task_id from running list when completed.
        Note: The actual entry data should be managed separately.

        Args:
            task_id: The task ID to complete

        Returns:
            True if task_id was found and removed, False otherwise
        """
        if task_id in self.running_item_ids:
            self.running_item_ids.remove(task_id)
            logger.debug(f"Completed task_id: {task_id}")
            return True

        logger.warning(f"Task ID {task_id} not found in running task ids")
        return False

    def get_running_item_ids(self) -> list[str]:
        """Get all running task IDs"""
        return self.running_item_ids.copy()

    def get_completed_entries(self) -> list[APIMemoryHistoryEntryItem]:
        """Get all completed entries"""
        return self.completed_entries.copy()

    def get_history_memory_entries(
        self, turns: int | None = None
    ) -> list[APIMemoryHistoryEntryItem]:
        """
        Get the most recent n completed search entries, sorted by created_time.

        Args:
            turns: Number of entries to return. If None, returns all completed entries.

        Returns:
            List of completed search entries, sorted by created_time (newest first)
        """
        if not self.completed_entries:
            return []

        # Sort by created_time (newest first)
        sorted_entries = sorted(self.completed_entries, key=lambda x: x.created_time, reverse=True)

        if turns is None:
            return sorted_entries

        return sorted_entries[:turns]

    def get_history_memories(self, turns: int | None = None) -> list[TextualMemoryItem]:
        """
        Get the most recent n completed search entries, sorted by created_time.

        Args:
            turns: Number of entries to return. If None, returns all completed entries.

        Returns:
            List of TextualMemoryItem objects from completed entries, sorted by created_time (newest first)
        """
        sorted_entries = self.get_history_memory_entries(turns=turns)

        memories = []
        for one in sorted_entries:
            memories.extend(one.memories)
        return memories

    def find_entry_by_item_id(self, item_id: str) -> tuple[dict[str, Any] | None, str]:
        """
        Find an entry by item_id in completed list only.
        Running entries are now just task IDs, so we can only search completed entries.

        Args:
            item_id: The item ID to search for

        Returns:
            Tuple of (entry_dict, location) where location is 'completed' or 'not_found'
        """
        # Check completed entries
        for entry in self.completed_entries:
            try:
                if hasattr(entry, "item_id") and entry.item_id == item_id:
                    return entry.to_dict(), "completed"
                elif isinstance(entry, dict) and entry.get("item_id") == item_id:
                    return entry, "completed"
            except AttributeError as e:
                logger.warning(f"Entry missing item_id attribute: {e}, entry type: {type(entry)}")
                continue

        return None, "not_found"

    def update_entry_by_item_id(
        self,
        item_id: str,
        query: str,
        formatted_memories: Any,
        task_status: TaskRunningStatus,
        session_id: str | None = None,
        memories: list[TextualMemoryItem] | None = None,
    ) -> bool:
        """
        Update an existing entry by item_id. Since running entries are now just IDs,
        this method can only update completed entries.

        Args:
            item_id: The item ID to update
            query: New query string
            formatted_memories: New formatted memories
            task_status: New task status
            session_id: New conversation ID
            memories: List of TextualMemoryItem objects

        Returns:
            True if entry was found and updated, False otherwise
        """
        # Find the entry in completed list
        for entry in self.completed_entries:
            if entry.item_id == item_id:
                # Update the entry content
                entry.query = query
                entry.formatted_memories = formatted_memories
                entry.task_status = task_status
                if session_id is not None:
                    entry.session_id = session_id
                if memories is not None:
                    entry.memories = memories

                logger.debug(f"Updated entry with item_id: {item_id}, new status: {task_status}")
                return True

        logger.warning(f"Entry with item_id: {item_id} not found in completed entries")
        return False

    def get_total_count(self) -> dict[str, int]:
        """Get count of entries by status"""
        return {
            "completed": len(self.completed_entries),
            "running": len(self.running_item_ids),
            "total": len(self.completed_entries) + len(self.running_item_ids),
        }

    def __len__(self) -> int:
        """Return total number of entries (completed + running)"""
        return len(self.completed_entries) + len(self.running_item_ids)


# Alias for easier usage
SearchHistoryManager = APISearchHistoryManager
