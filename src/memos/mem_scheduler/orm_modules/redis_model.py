import json
import time

from typing import Any, TypeVar

from sqlalchemy.engine import Engine
from sqlalchemy.orm import declarative_base

from memos.log import get_logger
from memos.mem_scheduler.orm_modules.base_model import BaseDBManager
from memos.mem_scheduler.schemas.monitor_schemas import MemoryMonitorManager
from memos.mem_scheduler.utils.db_utils import get_utc_now


T = TypeVar("T")  # The model type (MemoryMonitorManager, QueryMonitorManager, etc.)
ORM = TypeVar("ORM")  # The ORM model type

logger = get_logger(__name__)

Base = declarative_base()


class SimpleListManager:
    """Simple wrapper class for list[str] to work with RedisDBManager"""

    def __init__(self, items: list[str] | None = None):
        self.items = items or []

    def to_json(self) -> str:
        """Serialize to JSON string"""
        return json.dumps({"items": self.items})

    @classmethod
    def from_json(cls, json_str: str) -> "SimpleListManager":
        """Deserialize from JSON string"""
        data = json.loads(json_str)
        return cls(items=data.get("items", []))

    def add_item(self, item: str):
        """Add an item to the list"""
        self.items.append(item)

    def __len__(self):
        return len(self.items)

    def __str__(self):
        return f"SimpleListManager(items={self.items})"


class RedisLockableORM:
    """Redis-based implementation of LockableORM interface

    This class provides Redis-based storage for lockable ORM objects,
    mimicking the SQLAlchemy LockableORM interface but using Redis as the backend.
    """

    def __init__(self, redis_client, user_id: str, mem_cube_id: str):
        self.redis_client = redis_client
        self.user_id = user_id
        self.mem_cube_id = mem_cube_id
        self.serialized_data = None
        self.lock_acquired = False
        self.lock_expiry = None
        self.version_control = "0"

    def _get_key_prefix(self) -> str:
        """Generate Redis key prefix for this ORM instance"""
        return f"lockable_orm:{self.user_id}:{self.mem_cube_id}"

    def _get_data_key(self) -> str:
        """Get Redis key for serialized data"""
        return f"{self._get_key_prefix()}:data"

    def _get_lock_key(self) -> str:
        """Get Redis key for lock information"""
        return f"{self._get_key_prefix()}:lock"

    def _get_version_key(self) -> str:
        """Get Redis key for version control"""
        return f"{self._get_key_prefix()}:version"

    def save(self):
        """Save this ORM instance to Redis"""
        try:
            # Save serialized data
            if self.serialized_data:
                self.redis_client.set(self._get_data_key(), self.serialized_data)

            # Note: Lock information is now managed by acquire_lock/release_locks methods
            # We don't save lock info here to avoid conflicts with atomic lock operations

            # Save version control
            self.redis_client.set(self._get_version_key(), self.version_control)

            logger.debug(f"Saved RedisLockableORM to Redis: {self._get_key_prefix()}")

        except Exception as e:
            logger.error(f"Failed to save RedisLockableORM to Redis: {e}")
            raise

    def load(self):
        """Load this ORM instance from Redis"""
        try:
            # Load serialized data
            data = self.redis_client.get(self._get_data_key())
            if data:
                self.serialized_data = data.decode() if isinstance(data, bytes) else data
            else:
                self.serialized_data = None

            # Note: Lock information is now managed by acquire_lock/release_locks methods
            # We don't load lock info here to avoid conflicts with atomic lock operations
            self.lock_acquired = False
            self.lock_expiry = None

            # Load version control
            version = self.redis_client.get(self._get_version_key())
            if version:
                self.version_control = version.decode() if isinstance(version, bytes) else version
            else:
                self.version_control = "0"

            logger.debug(f"Loaded RedisLockableORM from Redis: {self._get_key_prefix()}")
            # Return True if we found any data, False otherwise
            return self.serialized_data is not None

        except Exception as e:
            logger.error(f"Failed to load RedisLockableORM from Redis: {e}")
            return False

    def delete(self):
        """Delete this ORM instance from Redis"""
        try:
            keys_to_delete = [self._get_data_key(), self._get_lock_key(), self._get_version_key()]
            self.redis_client.delete(*keys_to_delete)
            logger.debug(f"Deleted RedisLockableORM from Redis: {self._get_key_prefix()}")
        except Exception as e:
            logger.error(f"Failed to delete RedisLockableORM from Redis: {e}")
            raise


class RedisDBManager(BaseDBManager):
    """Redis-based database manager for any serializable object

    This class handles persistence, synchronization, and locking
    for any object that implements to_json/from_json methods using Redis as the backend storage.
    """

    def __init__(
        self,
        engine: Engine | None = None,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
        obj: Any | None = None,
        lock_timeout: int = 10,
        redis_client=None,
        redis_config: dict | None = None,
    ):
        """Initialize the Redis database manager

        Args:
            engine: SQLAlchemy engine (not used for Redis, kept for compatibility)
            user_id: Unique identifier for the user
            mem_cube_id: Unique identifier for the memory cube
            obj: Optional object instance to manage (must have to_json/from_json methods)
            lock_timeout: Timeout in seconds for lock acquisition
            redis_client: Redis client instance (optional)
            redis_config: Redis configuration dictionary (optional)
        """
        # Initialize Redis client
        self.redis_client = redis_client
        self.redis_config = redis_config or {}

        if self.redis_client is None:
            self._init_redis_client()

        # Initialize base attributes without calling parent's init_manager
        self.user_id = user_id
        self.mem_cube_id = mem_cube_id
        self.obj = obj
        self.obj_type = type(obj) if obj is not None else None  # Store the actual object type
        self.lock_timeout = lock_timeout
        self.engine = engine  # Keep for compatibility but not used
        self.SessionLocal = None  # Not used for Redis
        self.last_version_control = None

        logger.info(
            f"RedisDBManager initialized for user_id: {user_id}, mem_cube_id: {mem_cube_id}"
        )
        logger.info(f"Redis client: {type(self.redis_client).__name__}")

        # Test Redis connection
        try:
            self.redis_client.ping()
            logger.info("Redis connection successful")
        except Exception as e:
            logger.warning(f"Redis ping failed: {e}")
            # Don't raise error here as it might be a mock client in tests

    def _init_redis_client(self):
        """Initialize Redis client from config or environment"""
        try:
            import redis

            # Try to get Redis client from environment first
            if not self.redis_client:
                self.redis_client = self.load_redis_engine_from_env()

            # If still no client, try from config
            if not self.redis_client and self.redis_config:
                redis_kwargs = {
                    "host": self.redis_config.get("host", "localhost"),
                    "port": self.redis_config.get("port", 6379),
                    "db": self.redis_config.get("db", 0),
                    "decode_responses": True,
                }

                if self.redis_config.get("password"):
                    redis_kwargs["password"] = self.redis_config["password"]

                self.redis_client = redis.Redis(**redis_kwargs)

            # Final fallback to localhost
            if not self.redis_client:
                logger.warning("No Redis configuration found, using localhost defaults")
                self.redis_client = redis.Redis(
                    host="localhost", port=6379, db=0, decode_responses=True
                )

            # Test connection
            if not self.redis_client.ping():
                raise ConnectionError("Redis ping failed")

            logger.info("Redis client initialized successfully")

        except ImportError:
            logger.error("Redis package not installed. Install with: pip install redis")
            raise
        except Exception as e:
            logger.error(f"Failed to initialize Redis client: {e}")
            raise

    @property
    def orm_class(self) -> type[RedisLockableORM]:
        """Return the Redis-based ORM class"""
        return RedisLockableORM

    @property
    def obj_class(self) -> type:
        """Return the actual object class"""
        return self.obj_type if self.obj_type is not None else MemoryMonitorManager

    def merge_items(
        self,
        orm_instance: RedisLockableORM,
        obj_instance: Any,
        size_limit: int,
    ):
        """Merge items from Redis with current object instance

        This method provides a generic way to merge data from Redis with the current
        object instance. It handles different object types and their specific merge logic.

        Args:
            orm_instance: Redis ORM instance from database
            obj_instance: Current object instance (any type with to_json/from_json methods)
            size_limit: Maximum number of items to keep after merge
        """
        logger.debug(f"Starting merge_items with size_limit={size_limit}")

        try:
            if not orm_instance.serialized_data:
                logger.warning("No serialized data in Redis ORM instance to merge")
                return obj_instance

            # Deserialize the database object using the actual object type
            if self.obj_type is not None:
                db_obj = self.obj_type.from_json(orm_instance.serialized_data)
            else:
                db_obj = MemoryMonitorManager.from_json(orm_instance.serialized_data)

            # Handle different object types with specific merge logic based on type
            obj_type = type(obj_instance)
            if obj_type.__name__ == "MemoryMonitorManager" or hasattr(obj_instance, "memories"):
                # MemoryMonitorManager-like objects
                return self._merge_memory_monitor_items(obj_instance, db_obj, size_limit)
            elif obj_type.__name__ == "SimpleListManager" or hasattr(obj_instance, "items"):
                # SimpleListManager-like objects
                return self._merge_list_items(obj_instance, db_obj, size_limit)
            else:
                # Generic objects - just return the current instance
                logger.info(
                    f"No specific merge logic for object type {obj_type.__name__}, returning current instance"
                )
                return obj_instance

        except Exception as e:
            logger.error(f"Failed to deserialize database instance: {e}", exc_info=True)
            logger.warning("Skipping merge due to deserialization error, using current object only")
            return obj_instance

    def _merge_memory_monitor_items(self, obj_instance, db_obj, size_limit: int):
        """Merge MemoryMonitorManager items"""
        # Create a mapping of existing memories by their mapping key
        current_memories_dict = obj_instance.memories_mapping_dict

        # Add memories from database that don't exist in current object
        for db_memory in db_obj.memories:
            if db_memory.tree_memory_item_mapping_key not in current_memories_dict:
                obj_instance.memories.append(db_memory)

        # Apply size limit if specified
        if size_limit and len(obj_instance.memories) > size_limit:
            # Sort by recording_count and keep the most recorded ones
            obj_instance.memories.sort(key=lambda x: x.recording_count, reverse=True)
            obj_instance.memories = obj_instance.memories[:size_limit]
            logger.info(
                f"Applied size limit {size_limit}, kept {len(obj_instance.memories)} memories"
            )

        logger.info(f"Merged {len(obj_instance.memories)} memory items")
        return obj_instance

    def _merge_list_items(self, obj_instance, db_obj, size_limit: int):
        """Merge SimpleListManager-like items"""
        merged_items = []
        seen_items = set()

        # First, add all items from current object (higher priority)
        for item in obj_instance.items:
            if item not in seen_items:
                merged_items.append(item)
                seen_items.add(item)

        # Then, add items from database that aren't in current object
        for item in db_obj.items:
            if item not in seen_items:
                merged_items.append(item)
                seen_items.add(item)

        # Apply size limit if specified (keep most recent items)
        if size_limit is not None and size_limit > 0 and len(merged_items) > size_limit:
            merged_items = merged_items[:size_limit]
            logger.debug(f"Applied size limit of {size_limit}, kept {len(merged_items)} items")

        # Update the object with merged items
        obj_instance.items = merged_items

        logger.info(f"Merged {len(merged_items)} list items (size_limit: {size_limit})")
        return obj_instance

    def _get_redis_orm_instance(self) -> RedisLockableORM:
        """Get or create a Redis ORM instance"""
        orm_instance = RedisLockableORM(
            redis_client=self.redis_client, user_id=self.user_id, mem_cube_id=self.mem_cube_id
        )
        return orm_instance

    def _get_key_prefix(self) -> str:
        """Generate Redis key prefix for this ORM instance"""
        return f"lockable_orm:{self.user_id}:{self.mem_cube_id}"

    def acquire_lock(self, block: bool = True, **kwargs) -> bool:
        """Acquire a distributed lock using Redis with atomic operations

        Args:
            block: Whether to block until lock is acquired
            **kwargs: Additional filter criteria (ignored for Redis)

        Returns:
            True if lock was acquired, False otherwise
        """
        try:
            lock_key = f"{self._get_key_prefix()}:lock"
            now = get_utc_now()

            # Use Redis SET with NX (only if not exists) and EX (expiry) for atomic lock acquisition
            lock_value = f"{self.user_id}:{self.mem_cube_id}:{now.timestamp()}"

            while True:
                # Try to acquire lock atomically
                result = self.redis_client.set(
                    lock_key,
                    lock_value,
                    nx=True,  # Only set if key doesn't exist
                    ex=self.lock_timeout,  # Set expiry in seconds
                )

                if result:
                    # Successfully acquired lock
                    logger.info(f"Redis lock acquired for {self.user_id}/{self.mem_cube_id}")
                    return True

                if not block:
                    logger.warning(
                        f"Redis lock is held for {self.user_id}/{self.mem_cube_id}, cannot acquire"
                    )
                    return False

                # Wait a bit before retrying
                logger.info(
                    f"Waiting for Redis lock to be released for {self.user_id}/{self.mem_cube_id}"
                )
                time.sleep(0.1)

        except Exception as e:
            logger.error(f"Failed to acquire Redis lock for {self.user_id}/{self.mem_cube_id}: {e}")
            return False

    def release_locks(self, user_id: str, mem_cube_id: str, **kwargs):
        """Release Redis locks for the specified user and memory cube

        Args:
            user_id: User identifier
            mem_cube_id: Memory cube identifier
            **kwargs: Additional filter criteria (ignored for Redis)
        """
        try:
            lock_key = f"lockable_orm:{user_id}:{mem_cube_id}:lock"

            # Delete the lock key to release the lock
            result = self.redis_client.delete(lock_key)

            if result:
                logger.info(f"Redis lock released for {user_id}/{mem_cube_id}")
            else:
                logger.warning(f"No Redis lock found to release for {user_id}/{mem_cube_id}")

        except Exception as e:
            logger.error(f"Failed to release Redis lock for {user_id}/{mem_cube_id}: {e}")

    def sync_with_orm(self, size_limit: int | None = None) -> None:
        """Synchronize data between Redis and the business object

        Args:
            size_limit: Optional maximum number of items to keep after synchronization
        """
        logger.info(
            f"Starting Redis sync_with_orm for {self.user_id}/{self.mem_cube_id} with size_limit={size_limit}"
        )

        try:
            # Acquire lock before any operations
            lock_status = self.acquire_lock(block=True)
            if not lock_status:
                logger.error("Failed to acquire Redis lock for synchronization")
                return

            # Get existing data from Redis
            orm_instance = self._get_redis_orm_instance()
            exists = orm_instance.load()

            # If no existing record, create a new one
            if not exists:
                if self.obj is None:
                    logger.warning("No object to synchronize and no existing Redis record")
                    return

                orm_instance.serialized_data = self.obj.to_json()
                orm_instance.version_control = "0"
                orm_instance.save()

                logger.info("No existing Redis record found. Created a new one.")
                self.last_version_control = "0"
                return

            # Check version control and merge data
            if self.obj is not None:
                current_redis_tag = orm_instance.version_control
                new_tag = self._increment_version_control(current_redis_tag)

                # Check if this is the first sync or if we need to merge
                if self.last_version_control is None:
                    logger.info("First Redis sync, merging data from Redis")
                    # Always merge on first sync to load data from Redis
                    try:
                        self.merge_items(
                            orm_instance=orm_instance, obj_instance=self.obj, size_limit=size_limit
                        )
                    except Exception as merge_error:
                        logger.error(
                            f"Error during Redis merge_items: {merge_error}", exc_info=True
                        )
                        logger.warning("Continuing with current object data without merge")
                elif current_redis_tag == self.last_version_control:
                    logger.info(
                        f"Redis version control unchanged ({current_redis_tag}), directly update"
                    )
                else:
                    logger.info(
                        f"Redis version control changed from {self.last_version_control} to {current_redis_tag}, merging data"
                    )
                    try:
                        self.merge_items(
                            orm_instance=orm_instance, obj_instance=self.obj, size_limit=size_limit
                        )
                    except Exception as merge_error:
                        logger.error(
                            f"Error during Redis merge_items: {merge_error}", exc_info=True
                        )
                        logger.warning("Continuing with current object data without merge")

                # Write merged data back to Redis
                orm_instance.serialized_data = self.obj.to_json()
                orm_instance.version_control = new_tag
                orm_instance.save()

                logger.info(f"Updated Redis serialized_data for {self.user_id}/{self.mem_cube_id}")
                self.last_version_control = orm_instance.version_control
            else:
                logger.warning("No current object to merge with Redis data")

            logger.info(f"Redis synchronization completed for {self.user_id}/{self.mem_cube_id}")

        except Exception as e:
            logger.error(
                f"Error during Redis synchronization for {self.user_id}/{self.mem_cube_id}: {e}",
                exc_info=True,
            )
        finally:
            # Always release locks
            self.release_locks(user_id=self.user_id, mem_cube_id=self.mem_cube_id)

    def save_to_db(self, obj_instance: Any) -> None:
        """Save the current state of the business object to Redis

        Args:
            obj_instance: The object instance to save (must have to_json method)
        """
        try:
            # Acquire lock before operations
            lock_status = self.acquire_lock(block=True)
            if not lock_status:
                logger.error("Failed to acquire Redis lock for saving")
                return

            # Get or create Redis ORM instance
            orm_instance = self._get_redis_orm_instance()
            exists = orm_instance.load()

            if not exists:
                # Create new record
                orm_instance.serialized_data = obj_instance.to_json()
                orm_instance.version_control = "0"
                orm_instance.save()

                logger.info(f"Created new Redis record for {self.user_id}/{self.mem_cube_id}")
                self.last_version_control = "0"
            else:
                # Update existing record with version control
                current_version = orm_instance.version_control
                new_version = self._increment_version_control(current_version)

                orm_instance.serialized_data = obj_instance.to_json()
                orm_instance.version_control = new_version
                orm_instance.save()

                logger.info(
                    f"Updated existing Redis record for {self.user_id}/{self.mem_cube_id} with version {new_version}"
                )
                self.last_version_control = new_version

        except Exception as e:
            logger.error(f"Error saving to Redis for {self.user_id}/{self.mem_cube_id}: {e}")
        finally:
            # Always release locks
            self.release_locks(user_id=self.user_id, mem_cube_id=self.mem_cube_id)

    def load_from_db(self, acquire_lock: bool = False) -> Any | None:
        """Load the business object from Redis

        Args:
            acquire_lock: Whether to acquire a lock during the load operation

        Returns:
            The deserialized object instance, or None if not found
        """
        try:
            if acquire_lock:
                lock_status = self.acquire_lock(block=True)
                if not lock_status:
                    logger.error("Failed to acquire Redis lock for loading")
                    return None

            # Load from Redis
            orm_instance = self._get_redis_orm_instance()
            exists = orm_instance.load()

            if not exists or not orm_instance.serialized_data:
                logger.info(f"No Redis record found for {self.user_id}/{self.mem_cube_id}")
                return None

            # Deserialize the business object using the actual object type
            if self.obj_type is not None:
                db_instance = self.obj_type.from_json(orm_instance.serialized_data)
            else:
                db_instance = MemoryMonitorManager.from_json(orm_instance.serialized_data)
            self.last_version_control = orm_instance.version_control

            logger.info(
                f"Successfully loaded object from Redis for {self.user_id}/{self.mem_cube_id} with version {orm_instance.version_control}"
            )
            return db_instance

        except Exception as e:
            logger.error(f"Error loading from Redis for {self.user_id}/{self.mem_cube_id}: {e}")
            return None
        finally:
            if acquire_lock:
                self.release_locks(user_id=self.user_id, mem_cube_id=self.mem_cube_id)

    def close(self):
        """Close the Redis manager and clean up resources"""
        try:
            # Release any locks held by this manager instance
            if self.user_id and self.mem_cube_id:
                self.release_locks(user_id=self.user_id, mem_cube_id=self.mem_cube_id)
                logger.info(f"Released Redis locks for {self.user_id}/{self.mem_cube_id}")

            # Close Redis connection
            if self.redis_client:
                self.redis_client.close()
                logger.info("Redis connection closed")

            # Call parent close method for any additional cleanup
            super().close()

        except Exception as e:
            logger.error(f"Error during Redis close operation: {e}")

    @classmethod
    def from_env(
        cls,
        user_id: str,
        mem_cube_id: str,
        obj: Any | None = None,
        lock_timeout: int = 10,
        env_file_path: str | None = None,
    ) -> "RedisDBManager":
        """Create RedisDBManager from environment variables

        Args:
            user_id: User identifier
            mem_cube_id: Memory cube identifier
            obj: Optional MemoryMonitorManager instance
            lock_timeout: Lock timeout in seconds
            env_file_path: Optional path to .env file

        Returns:
                RedisDBManager instance
        """
        try:
            redis_client = cls.load_redis_engine_from_env(env_file_path)
            return cls(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                obj=obj,
                lock_timeout=lock_timeout,
                redis_client=redis_client,
            )
        except Exception as e:
            logger.error(f"Failed to create RedisDBManager from environment: {e}")
            raise

    def list_keys(self, pattern: str | None = None) -> list[str]:
        """List all Redis keys for this manager's data

        Args:
            pattern: Optional pattern to filter keys

        Returns:
            List of Redis keys
        """
        try:
            if pattern is None:
                pattern = f"lockable_orm:{self.user_id}:{self.mem_cube_id}:*"

            keys = self.redis_client.keys(pattern)
            return [key.decode() if isinstance(key, bytes) else key for key in keys]

        except Exception as e:
            logger.error(f"Error listing Redis keys: {e}")
            return []

    def health_check(self) -> dict[str, bool]:
        """Check the health of Redis connection

        Returns:
            Dictionary with health status
        """
        try:
            redis_healthy = self.redis_client.ping()
            return {
                "redis": redis_healthy,
                "mysql": False,  # Not applicable for Redis manager
            }
        except Exception as e:
            logger.error(f"Redis health check failed: {e}")
            return {"redis": False, "mysql": False}
