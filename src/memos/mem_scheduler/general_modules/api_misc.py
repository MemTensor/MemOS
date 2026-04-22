from typing import Any

from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.orm_modules.api_redis_model import APIRedisDBManager
from memos.mem_scheduler.schemas.api_schemas import (
    APIMemoryHistoryEntryItem,
    APISearchHistoryManager,
    TaskRunningStatus,
)
from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


class SchedulerAPIModule(BaseSchedulerModule):
    def __init__(self, window_size: int | None = None, history_memory_turns: int | None = None):
        super().__init__()
        self.window_size = window_size
        self.history_memory_turns = history_memory_turns
        self.search_history_managers: dict[str, APIRedisDBManager] = {}

    def get_search_history_manager(self, user_id: str, mem_cube_id: str) -> APIRedisDBManager:
        """Get or create a Redis manager for search history."""
        logger.info(
            f"Getting search history manager for user_id: {user_id}, mem_cube_id: {mem_cube_id}"
        )
        key = f"search_history:{user_id}:{mem_cube_id}"
        if key not in self.search_history_managers:
            logger.info(f"Creating new search history manager for key: {key}")
            self.search_history_managers[key] = APIRedisDBManager(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                obj=APISearchHistoryManager(window_size=self.window_size),
            )
        return self.search_history_managers[key]

    def sync_search_data(
        self,
        item_id: str,
        user_id: str,
        mem_cube_id: str,
        query: str,
        memories: list[TextualMemoryItem],
        formatted_memories: Any,
        session_id: str | None = None,
        conversation_turn: int = 0,
    ) -> Any:
        logger.info(
            f"Syncing search data for item_id: {item_id}, user_id: {user_id}, mem_cube_id: {mem_cube_id}"
        )
        # Get the search history manager
        manager = self.get_search_history_manager(user_id, mem_cube_id)
        manager.sync_with_redis(size_limit=self.window_size)

        search_history = manager.obj

        # Check if entry with item_id already exists
        existing_entry, location = search_history.find_entry_by_item_id(item_id)

        if existing_entry is not None:
            # Update existing entry
            success = search_history.update_entry_by_item_id(
                item_id=item_id,
                query=query,
                formatted_memories=formatted_memories,
                task_status=TaskRunningStatus.COMPLETED,  # Use the provided running_status
                session_id=session_id,
                memories=memories,
            )

            if success:
                logger.info(f"Updated existing entry with item_id: {item_id} in {location} list")
            else:
                logger.warning(f"Failed to update entry with item_id: {item_id}")
        else:
            # Add new entry based on running_status
            entry_item = APIMemoryHistoryEntryItem(
                item_id=item_id,
                query=query,
                formatted_memories=formatted_memories,
                memories=memories,
                task_status=TaskRunningStatus.COMPLETED,
                session_id=session_id,
                conversation_turn=conversation_turn,
            )

            # Add directly to completed list as APIMemoryHistoryEntryItem instance
            search_history.completed_entries.append(entry_item)

            # Maintain window size
            if len(search_history.completed_entries) > search_history.window_size:
                search_history.completed_entries = search_history.completed_entries[
                    -search_history.window_size :
                ]

            # Remove from running task IDs
            if item_id in search_history.running_item_ids:
                search_history.running_item_ids.remove(item_id)

            logger.info(f"Created new entry with item_id: {item_id}")

        # Update manager's object with the modified search history
        manager.obj = search_history

        # Use sync_with_redis to handle Redis synchronization with merging
        manager.sync_with_redis(size_limit=self.window_size)
        return manager

    def get_history_memories(
        self, user_id: str, mem_cube_id: str, turns: int | None = None
    ) -> list:
        """Get history memories for backward compatibility with tests."""
        logger.info(
            f"Getting history memories for user_id: {user_id}, mem_cube_id: {mem_cube_id}, turns: {turns}"
        )
        manager = self.get_search_history_manager(user_id, mem_cube_id)
        existing_data = manager.load_from_db()

        if existing_data is None:
            return []

        if turns is None:
            turns = self.history_memory_turns

        # Handle different data formats
        if isinstance(existing_data, APISearchHistoryManager):
            search_history = existing_data
        else:
            # Try to convert to APISearchHistoryManager
            try:
                search_history = APISearchHistoryManager(**existing_data)
            except Exception:
                return []

        return search_history.get_history_memories(turns=turns)
