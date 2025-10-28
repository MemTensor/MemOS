import threading

from typing import Any

from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.orm_modules.redis_model import RedisDBManager, SimpleListManager


logger = get_logger(__name__)


class SchedulerAPIModule(BaseSchedulerModule):
    def __init__(self):
        super().__init__()

        self.search_history_managers: dict[str, RedisDBManager] = {}

    def get_search_history_manager(self, user_id: str, mem_cube_id: str) -> RedisDBManager:
        """Get or create a Redis manager for search history."""
        key = f"search_history:{user_id}:{mem_cube_id}"
        if key not in self.search_history_managers:
            self.search_history_managers[key] = RedisDBManager(
                user_id=user_id, mem_cube_id=mem_cube_id
            )
        return self.search_history_managers[key]

    def sync_search_data(
        self, user_id: str, mem_cube_id: str, query: str, formatted_memories: Any
    ) -> None:
        """
        Sync search data to Redis, maintaining a list of size 5.

        Args:
            user_id: User identifier
            mem_cube_id: Memory cube identifier
            query: Search query string
            formatted_memories: Formatted search results
        """
        try:
            # Get the search history manager
            manager = self.get_search_history_manager(user_id, mem_cube_id)

            # Create search data entry
            search_entry = {
                "query": query,
                "formatted_memories": formatted_memories,
                "timestamp": threading.current_thread().ident,  # Use thread ID as simple timestamp
            }

            # Load existing search history
            existing_data = manager.load_from_db()

            if existing_data is None:
                search_history = SimpleListManager([])
            else:
                # If existing data is a SimpleListManager, use it; otherwise create new one
                if isinstance(existing_data, SimpleListManager):
                    search_history = existing_data
                else:
                    search_history = SimpleListManager([])

            # Add new entry and keep only latest 5
            search_history.add_item(str(search_entry))
            if len(search_history) > 5:
                # Keep only the latest 5 items
                search_history.items = search_history.items[-5:]

            # Save back to Redis
            manager.save_to_db(search_history)

            logger.info(
                f"Synced search data for user {user_id}, mem_cube {mem_cube_id}. History size: {len(search_history)}"
            )

        except Exception as e:
            logger.error(f"Failed to sync search data: {e}", exc_info=True)

    def get_pre_fine_memories(self, user_id: str, mem_cube_id: str) -> list:
        """
        Get the most recent pre-computed fine memories from search history.

        Args:
            user_id: User identifier
            mem_cube_id: Memory cube identifier

        Returns:
            List of formatted memories from the most recent search, or empty list if none found
        """
        try:
            manager = self.get_search_history_manager(user_id, mem_cube_id)
            search_history_key = "search_history_list"
            existing_data = manager.load_from_db(search_history_key)

            if existing_data is None:
                return []

            search_history = (
                existing_data.obj_instance
                if hasattr(existing_data, "obj_instance")
                else existing_data
            )

            if not search_history or len(search_history) == 0:
                return []

            # Return the formatted_memories from the most recent search
            latest_entry = search_history[-1]
            return (
                latest_entry.get("formatted_memories", []) if isinstance(latest_entry, dict) else []
            )

        except Exception as e:
            logger.error(f"Failed to get pre-computed fine memories: {e}", exc_info=True)
            return []
