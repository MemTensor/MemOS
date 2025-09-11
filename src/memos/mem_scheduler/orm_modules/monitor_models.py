from typing import TypeVar

from sqlalchemy import Index
from sqlalchemy.engine import Engine

from memos.log import get_logger
from memos.mem_scheduler.schemas.monitor_schemas import (
    MemoryMonitorItem,
    MemoryMonitorManager,
    QueryMonitorItem,
    QueryMonitorQueue,
)

from .base_model import BaseDBManager, LockableORM


logger = get_logger(__name__)

# Type variables for generic type hints
T = TypeVar("T")  # The model type (MemoryMonitorManager, QueryMonitorManager, etc.)
ORM = TypeVar("ORM")  # The ORM model type


class MemoryMonitorManagerORM(LockableORM):
    """ORM model for MemoryMonitorManager persistence

    This table stores serialized MemoryMonitorManager instances with
    proper indexing for efficient user and memory cube lookups.
    """

    __tablename__ = "memory_monitor_manager"

    # Database indexes for performance optimization
    __table_args__ = (Index("idx_memory_monitor_user_memcube", "user_id", "mem_cube_id"),)


class QueryMonitorQueueORM(LockableORM):
    """ORM model for QueryMonitorQueue persistence

    This table stores serialized QueryMonitorQueue instances with
    proper indexing for efficient user and memory cube lookups.
    """

    __tablename__ = "query_monitor_queue"

    # Database indexes for performance optimization
    __table_args__ = (Index("idx_query_monitor_user_memcube", "user_id", "mem_cube_id"),)


class DBManagerForMemoryMonitorManager(BaseDBManager):
    """Database manager for MemoryMonitorManager objects

    This class handles persistence, synchronization, and locking
    for MemoryMonitorManager instances in the database.
    """

    def __init__(
        self,
        engine: Engine,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
        obj: MemoryMonitorManager | None = None,
        lock_timeout: int = 10,
    ):
        """
        Initialize the MemoryMonitorManager database manager.

        Args:
            engine: SQLAlchemy engine instance
            user_id: Unique identifier for the user
            mem_cube_id: Unique identifier for the memory cube
            obj: Optional MemoryMonitorManager instance to manage
            lock_timeout: Timeout in seconds for lock acquisition
        """
        super().__init__(
            engine=engine, user_id=user_id, mem_cube_id=mem_cube_id, lock_timeout=lock_timeout
        )
        self.obj: MemoryMonitorManager | None = obj

    @property
    def orm_class(self) -> type[MemoryMonitorManagerORM]:
        return MemoryMonitorManagerORM

    @property
    def obj_class(self) -> type[MemoryMonitorManager]:
        return MemoryMonitorManager

    def merge_items(
        self,
        orm_instance: MemoryMonitorManagerORM,
        obj_instance: MemoryMonitorManager,
        size_limit: int,
    ):
        """Merge memory monitor items from database with current object

        This method combines items from the database with items in the current
        object, prioritizing current object items and applying size limits.

        Args:
            orm_instance: ORM instance containing serialized database data
            obj_instance: Current MemoryMonitorManager instance
            size_limit: Maximum number of items to keep after merge

        Returns:
            Updated obj_instance with merged items
        """
        logger.debug(f"Starting merge_items for MemoryMonitorManager with size_limit={size_limit}")

        try:
            # Deserialize the database instance
            db_instance: MemoryMonitorManager = MemoryMonitorManager.from_json(
                orm_instance.serialized_data
            )
        except Exception as e:
            logger.error(f"Failed to deserialize database instance: {e}", exc_info=True)
            logger.warning("Skipping merge due to deserialization error, using current object only")
            return obj_instance

        # Merge items - prioritize existing ones in current object
        merged_items: list[MemoryMonitorItem] = []
        seen_ids = set()

        # First, add all items from current object (higher priority)
        for item in obj_instance.memories:
            if item.item_id not in seen_ids:
                merged_items.append(item)
                seen_ids.add(item.item_id)

        # Then, add items from database that aren't in current object
        for item in db_instance.memories:
            if item.item_id not in seen_ids:
                merged_items.append(item)
                seen_ids.add(item.item_id)

        # Apply size limit if specified (keep most recent items)
        if size_limit is not None and size_limit > 0:
            try:
                # Sort by sorting_score descending (highest priority first) and take top N
                # Note: MemoryMonitorItem doesn't have timestamp, so we use sorting_score instead
                merged_items = sorted(merged_items, key=lambda x: x.sorting_score, reverse=True)[
                    :size_limit
                ]
                logger.debug(f"Applied size limit of {size_limit}, kept {len(merged_items)} items")
            except AttributeError as e:
                logger.error(f"Error sorting MemoryMonitorItem objects: {e}")
                logger.error(
                    "Available attributes: "
                    + ", ".join(dir(merged_items[0]) if merged_items else [])
                )
                raise
            except Exception as e:
                logger.error(f"Unexpected error during sorting: {e}")
                raise

        # Update the object with merged items
        obj_instance.memories = merged_items

        logger.info(
            f"Merged {len(merged_items)} memory items for {obj_instance} (size_limit: {size_limit})"
        )

        return obj_instance


class DBManagerForQueryMonitorQueue(BaseDBManager):
    """Database manager for QueryMonitorQueue objects

    This class handles persistence, synchronization, and locking
    for QueryMonitorQueue instances in the database.
    """

    def __init__(
        self,
        engine: Engine,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
        obj: QueryMonitorQueue | None = None,
        lock_timeout: int = 10,
    ):
        """
        Initialize the QueryMonitorQueue database manager.

        Args:
            engine: SQLAlchemy engine instance
            user_id: Unique identifier for the user
            mem_cube_id: Unique identifier for the memory cube
            obj: Optional QueryMonitorQueue instance to manage
            lock_timeout: Timeout in seconds for lock acquisition
        """
        super().__init__(
            engine=engine, user_id=user_id, mem_cube_id=mem_cube_id, lock_timeout=lock_timeout
        )
        self.obj: QueryMonitorQueue | None = obj

    @property
    def orm_class(self) -> type[QueryMonitorQueueORM]:
        return QueryMonitorQueueORM

    @property
    def obj_class(self) -> type[QueryMonitorQueue]:
        return QueryMonitorQueue

    def merge_items(
        self, orm_instance: QueryMonitorQueueORM, obj_instance: QueryMonitorQueue, size_limit: int
    ):
        """Merge query monitor items from database with current queue

        This method combines items from the database with items in the current
        queue, prioritizing current queue items and applying size limits.

        Args:
            orm_instance: ORM instance containing serialized database data
            obj_instance: Current QueryMonitorQueue instance
            size_limit: Maximum number of items to keep after merge

        Returns:
            Updated obj_instance with merged items
        """
        try:
            # Deserialize the database instance
            db_instance: QueryMonitorQueue = QueryMonitorQueue.from_json(
                orm_instance.serialized_data
            )
        except Exception as e:
            logger.error(f"Failed to deserialize database instance: {e}")
            logger.warning("Skipping merge due to deserialization error, using current object only")
            return obj_instance

        # Merge items - prioritize existing ones in current object
        merged_items: list[QueryMonitorItem] = []
        seen_ids = set()

        # First, add all items from current queue (higher priority)
        for item in obj_instance.get_queue_content_without_pop():
            if item.item_id not in seen_ids:
                merged_items.append(item)
                seen_ids.add(item.item_id)

        # Then, add items from database queue that aren't in current queue
        for item in db_instance.get_queue_content_without_pop():
            if item.item_id not in seen_ids:
                merged_items.append(item)
                seen_ids.add(item.item_id)

        # Apply size limit if specified (keep most recent items)
        if size_limit is not None and size_limit > 0:
            # Sort by timestamp descending (newest first) and take top N
            merged_items = sorted(merged_items, key=lambda x: x.timestamp, reverse=True)[
                :size_limit
            ]

        # Update the queue with merged items
        obj_instance.clear()  # Clear existing items
        for item in merged_items:
            obj_instance.put(item)  # Add merged items back

        logger.info(
            f"Merged {len(merged_items)} query items for {obj_instance} (size_limit: {size_limit})"
        )

        return obj_instance
