import os
import time

from typing import Any

from sqlalchemy.orm import declarative_base

from memos.log import get_logger
from memos.mem_scheduler.orm_modules.base_model import DatabaseError
from memos.mem_scheduler.schemas.api_schemas import (
    APISearchHistoryManager,
)
from memos.mem_scheduler.utils.db_utils import get_utc_now


logger = get_logger(__name__)

Base = declarative_base()


class APIRedisDBManager:
    """Redis-based database manager for any serializable object

    This class handles persistence, synchronization, and locking
    for any object that implements to_json/from_json methods using Redis as the backend storage.
    """

    # Add orm_class attribute for compatibility
    orm_class = None

    def __init__(
        self,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
        obj: APISearchHistoryManager | None = None,
        lock_timeout: int = 10,
        redis_client=None,
        redis_config: dict | None = None,
        window_size: int = 5,
    ):
        """Initialize the Redis database manager

        Args:
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
        self.lock_timeout = lock_timeout
        self.engine = None  # Keep for compatibility but not used
        self.SessionLocal = None  # Not used for Redis
        self.window_size = window_size
        self.lock_key = f"{self._get_key_prefix()}:lock"

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

    def _get_key_prefix(self) -> str:
        """Generate Redis key prefix for this user and memory cube

        Returns:
            Redis key prefix string
        """
        return f"redis_api:{self.user_id}:{self.mem_cube_id}"

    def _get_data_key(self) -> str:
        """Generate Redis key for storing serialized data

        Returns:
            Redis data key string
        """
        return f"{self._get_key_prefix()}:data"

    def _init_redis_client(self):
        """Initialize Redis client from config or environment"""
        try:
            import redis
        except ImportError:
            logger.error("Redis package not installed. Install with: pip install redis")
            raise

        # Try to get Redis client from environment first
        if not self.redis_client:
            self.redis_client = APIRedisDBManager.load_redis_engine_from_env()

        # If still no client, try from config
        if not self.redis_client and self.redis_config:
            redis_kwargs = {
                "host": self.redis_config.get("host"),
                "port": self.redis_config.get("port"),
                "db": self.redis_config.get("db"),
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

    def acquire_lock(self, block: bool = True, **kwargs) -> bool:
        """Acquire a distributed lock using Redis with atomic operations

        Args:
            block: Whether to block until lock is acquired
            **kwargs: Additional filter criteria (ignored for Redis)

        Returns:
            True if lock was acquired, False otherwise
        """

        now = get_utc_now()

        # Use Redis SET with NX (only if not exists) and EX (expiry) for atomic lock acquisition
        lock_value = f"{self._get_key_prefix()}:{now.timestamp()}"

        while True:
            result = self.redis_client.get(self.lock_key)
            if result:
                # Wait a bit before retrying
                logger.info(
                    f"Waiting for Redis lock to be released for {self.user_id}/{self.mem_cube_id}"
                )
                if not block:
                    logger.warning(
                        f"Redis lock is held for {self.user_id}/{self.mem_cube_id}, cannot acquire"
                    )
                    return False
                else:
                    time.sleep(0.1)
                    continue
            else:
                # Try to acquire lock atomically
                result = self.redis_client.set(
                    self.lock_key,
                    lock_value,
                    ex=self.lock_timeout,  # Set expiry in seconds
                )
                logger.info(f"Redis lock acquired for {self._get_key_prefix()}")
                return True

    def release_locks(self, **kwargs):
        # Delete the lock key to release the lock
        result = self.redis_client.delete(self.lock_key)

        # Redis DELETE returns the number of keys deleted (0 or 1)
        if result > 0:
            logger.info(f"Redis lock released for {self._get_key_prefix()}")
        else:
            logger.info(f"No Redis lock found to release for {self._get_key_prefix()}")

    def merge_items(
        self,
        redis_data: str,
        obj_instance: APISearchHistoryManager,
        size_limit: int,
    ):
        """Merge Redis data with current object instance

        Args:
            redis_data: JSON string from Redis containing serialized APISearchHistoryManager
            obj_instance: Current APISearchHistoryManager instance
            size_limit: Maximum number of completed entries to keep

        Returns:
            APISearchHistoryManager: Merged and synchronized manager instance
        """

        # Parse Redis data
        redis_manager = APISearchHistoryManager.from_json(redis_data)
        logger.debug(
            f"Loaded Redis manager with {len(redis_manager.completed_entries)} completed and {len(redis_manager.running_item_ids)} running task IDs"
        )

        # Create a new merged manager with the original window size from obj_instance
        # Use size_limit only for limiting entries, not as window_size
        original_window_size = obj_instance.window_size
        merged_manager = APISearchHistoryManager(window_size=original_window_size)

        # Merge completed entries - combine both sources and deduplicate by task_id
        # Ensure all entries are APIMemoryHistoryEntryItem instances
        from memos.mem_scheduler.schemas.api_schemas import APIMemoryHistoryEntryItem

        all_completed = {}

        # Add Redis completed entries
        for entry in redis_manager.completed_entries:
            if isinstance(entry, dict):
                # Convert dict to APIMemoryHistoryEntryItem instance
                try:
                    entry_obj = APIMemoryHistoryEntryItem(**entry)
                    task_id = entry_obj.item_id
                    all_completed[task_id] = entry_obj
                except Exception as e:
                    logger.warning(
                        f"Failed to convert dict entry to APIMemoryHistoryEntryItem: {e}"
                    )
                    continue
            else:
                task_id = entry.item_id
                all_completed[task_id] = entry

        # Add current instance completed entries (these take priority if duplicated)
        for entry in obj_instance.completed_entries:
            if isinstance(entry, dict):
                # Convert dict to APIMemoryHistoryEntryItem instance
                try:
                    entry_obj = APIMemoryHistoryEntryItem(**entry)
                    task_id = entry_obj.item_id
                    all_completed[task_id] = entry_obj
                except Exception as e:
                    logger.warning(
                        f"Failed to convert dict entry to APIMemoryHistoryEntryItem: {e}"
                    )
                    continue
            else:
                task_id = entry.item_id
                all_completed[task_id] = entry

        # Sort by created_time and apply size limit
        completed_list = list(all_completed.values())

        def get_created_time(entry):
            """Helper function to safely extract created_time for sorting"""
            from datetime import datetime

            # All entries should now be APIMemoryHistoryEntryItem instances
            return getattr(entry, "created_time", datetime.min)

        completed_list.sort(key=get_created_time, reverse=True)
        merged_manager.completed_entries = completed_list[:size_limit]

        # Merge running task IDs - combine both sources and deduplicate
        all_running_item_ids = set()

        # Add Redis running task IDs
        all_running_item_ids.update(redis_manager.running_item_ids)

        # Add current instance running task IDs
        all_running_item_ids.update(obj_instance.running_item_ids)

        merged_manager.running_item_ids = list(all_running_item_ids)

        logger.info(
            f"Merged manager: {len(merged_manager.completed_entries)} completed, {len(merged_manager.running_item_ids)} running task IDs"
        )
        return merged_manager

    def sync_with_redis(self, size_limit: int | None = None) -> None:
        """Synchronize data between Redis and the business object

        Args:
            size_limit: Optional maximum number of items to keep after synchronization
        """

        # Use window_size from the object if size_limit is not provided
        if size_limit is None:
            size_limit = self.window_size

        # Acquire lock before operations
        lock_status = self.acquire_lock(block=True)
        if not lock_status:
            logger.error("Failed to acquire Redis lock for synchronization")
            return

        # Load existing data from Redis
        data_key = self._get_data_key()
        redis_data = self.redis_client.get(data_key)

        if redis_data:
            # Merge Redis data with current object
            merged_obj = self.merge_items(
                redis_data=redis_data, obj_instance=self.obj, size_limit=size_limit
            )

            # Update the current object with merged data
            self.obj = merged_obj
            logger.info(
                f"Successfully synchronized with Redis data for {self.user_id}/{self.mem_cube_id}"
            )
        else:
            logger.info(
                f"No existing Redis data found for {self.user_id}/{self.mem_cube_id}, using current object"
            )

        # Save the synchronized object back to Redis
        self.save_to_db(self.obj)

        self.release_locks()

    def save_to_db(self, obj_instance: Any) -> None:
        """Save the current state of the business object to Redis

        Args:
            obj_instance: The object instance to save (must have to_json method)
        """

        data_key = self._get_data_key()

        self.redis_client.set(data_key, obj_instance.to_json())

        logger.info(f"Updated existing Redis record for {data_key}")

    def load_from_db(self) -> Any | None:
        data_key = self._get_data_key()

        # Load from Redis
        serialized_data = self.redis_client.get(data_key)

        if not serialized_data:
            logger.info(f"No Redis record found for {data_key}")
            return None

        # Deserialize the business object using the actual object type
        if hasattr(self, "obj_type") and self.obj_type is not None:
            db_instance = self.obj_type.from_json(serialized_data)
        else:
            # Default to APISearchHistoryManager for this class
            db_instance = APISearchHistoryManager.from_json(serialized_data)

        logger.info(f"Successfully loaded object from Redis for {data_key} ")

        return db_instance

    @classmethod
    def from_env(
        cls,
        user_id: str,
        mem_cube_id: str,
        obj: Any | None = None,
        lock_timeout: int = 10,
        env_file_path: str | None = None,
    ) -> "APIRedisDBManager":
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

        redis_client = APIRedisDBManager.load_redis_engine_from_env(env_file_path)
        return cls(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            obj=obj,
            lock_timeout=lock_timeout,
            redis_client=redis_client,
        )

    def close(self):
        """Close the Redis connection and clean up resources"""
        try:
            if hasattr(self.redis_client, "close"):
                self.redis_client.close()
            logger.info(
                f"Redis connection closed for user_id: {self.user_id}, mem_cube_id: {self.mem_cube_id}"
            )
        except Exception as e:
            logger.warning(f"Error closing Redis connection: {e}")

    @staticmethod
    def load_redis_engine_from_env(env_file_path: str | None = None) -> Any:
        """Load Redis connection from environment variables

        Args:
            env_file_path: Path to .env file (optional, defaults to loading from current environment)

        Returns:
            Redis connection instance

        Raises:
            DatabaseError: If required environment variables are missing or connection fails
        """
        try:
            import redis
        except ImportError as e:
            error_msg = "Redis package not installed. Install with: pip install redis"
            logger.error(error_msg)
            raise DatabaseError(error_msg) from e

        # Load environment variables from file if provided
        if env_file_path:
            if os.path.exists(env_file_path):
                from dotenv import load_dotenv

                load_dotenv(env_file_path)
                logger.info(f"Loaded environment variables from {env_file_path}")
            else:
                logger.warning(
                    f"Environment file not found: {env_file_path}, using current environment variables"
                )
        else:
            logger.info("Using current environment variables (no env_file_path provided)")

        # Get Redis configuration from environment variables
        redis_host = os.getenv("REDIS_HOST") or os.getenv("MEMSCHEDULER_REDIS_HOST")
        redis_port_str = os.getenv("REDIS_PORT") or os.getenv("MEMSCHEDULER_REDIS_PORT")
        redis_db_str = os.getenv("REDIS_DB") or os.getenv("MEMSCHEDULER_REDIS_DB")
        redis_password = os.getenv("REDIS_PASSWORD") or os.getenv("MEMSCHEDULER_REDIS_PASSWORD")

        # Check required environment variables
        if not redis_host:
            error_msg = (
                "Missing required Redis environment variable: REDIS_HOST or MEMSCHEDULER_REDIS_HOST"
            )
            logger.error(error_msg)
            return None

        # Parse port with validation
        try:
            redis_port = int(redis_port_str) if redis_port_str else 6379
        except ValueError:
            error_msg = f"Invalid REDIS_PORT value: {redis_port_str}. Must be a valid integer."
            logger.error(error_msg)
            return None

        # Parse database with validation
        try:
            redis_db = int(redis_db_str) if redis_db_str else 0
        except ValueError:
            error_msg = f"Invalid REDIS_DB value: {redis_db_str}. Must be a valid integer."
            logger.error(error_msg)
            return None

        # Optional timeout settings
        socket_timeout = os.getenv(
            "REDIS_SOCKET_TIMEOUT", os.getenv("MEMSCHEDULER_REDIS_TIMEOUT", None)
        )
        socket_connect_timeout = os.getenv(
            "REDIS_SOCKET_CONNECT_TIMEOUT", os.getenv("MEMSCHEDULER_REDIS_CONNECT_TIMEOUT", None)
        )

        try:
            # Build Redis connection parameters
            redis_kwargs = {
                "host": redis_host,
                "port": redis_port,
                "db": redis_db,
                "decode_responses": True,
            }

            if redis_password:
                redis_kwargs["password"] = redis_password

            if socket_timeout:
                try:
                    redis_kwargs["socket_timeout"] = float(socket_timeout)
                except ValueError:
                    logger.warning(
                        f"Invalid REDIS_SOCKET_TIMEOUT value: {socket_timeout}, ignoring"
                    )

            if socket_connect_timeout:
                try:
                    redis_kwargs["socket_connect_timeout"] = float(socket_connect_timeout)
                except ValueError:
                    logger.warning(
                        f"Invalid REDIS_SOCKET_CONNECT_TIMEOUT value: {socket_connect_timeout}, ignoring"
                    )

            # Create Redis connection
            redis_client = redis.Redis(**redis_kwargs)

            # Test connection
            if not redis_client.ping():
                raise ConnectionError("Redis ping failed")

            logger.info(
                f"Successfully created Redis connection: {redis_host}:{redis_port}/{redis_db}"
            )
            return redis_client

        except Exception as e:
            error_msg = f"Failed to create Redis connection from environment variables: {e}"
            logger.error(error_msg)
            raise DatabaseError(error_msg) from e
