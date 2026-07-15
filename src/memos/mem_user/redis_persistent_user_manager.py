"""Redis-based persistent user management system for MemOS with configuration storage.

This module provides persistent storage for user configurations using Redis.
"""

import json

from memos.configs.mem_os import MOSConfig
from memos.dependency import require_python_package
from memos.log import get_logger


logger = get_logger(__name__)


class RedisPersistentUserManager:
    """Redis-based user configuration manager with persistence."""

    @require_python_package(
        import_name="redis",
        install_command="pip install redis",
        install_link="https://redis.readthedocs.io/en/stable/",
    )
    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        password: str = "",
        db: int = 0,
        decode_responses: bool = True,
    ):
        """Initialize the Redis persistent user manager.

        Args:
            user_id (str, optional): User ID. Defaults to "root".
            host (str): Redis server host. Defaults to "localhost".
            port (int): Redis server port. Defaults to 6379.
            password (str): Redis password. Defaults to "".
            db (int): Redis database number. Defaults to 0.
            decode_responses (bool): Whether to decode responses to strings. Defaults to True.
        """
        import redis

        self.host = host
        self.port = port
        self.db = db

        try:
            # Create Redis connection
            self._redis_client = redis.Redis(
                host=host,
                port=port,
                password=password if password else None,
                db=db,
                decode_responses=decode_responses,
            )

            # Test connection
            if not self._redis_client.ping():
                raise ConnectionError("Redis connection failed")

            logger.info(
                f"RedisPersistentUserManager initialized successfully, connected to {host}:{port}/{db}"
            )

        except Exception as e:
            logger.error(f"Redis connection error: {e}")
            raise

    def _get_config_key(self, user_id: str) -> str:
        """Generate Redis key for user configuration.

        Args:
            user_id (str): User ID.

        Returns:
            str: Redis key name.
        """
        return user_id

    def save_user_config(self, user_id: str, config: MOSConfig) -> bool:
        """Save user configuration to Redis.

        Args:
            user_id (str): User ID.
            config (MOSConfig): User's MOS configuration.

        Returns:
            bool: True if successful, False otherwise.
        """
        try:
            # Convert config to JSON string
            config_dict = config.model_dump(mode="json")
            config_json = json.dumps(config_dict, ensure_ascii=False, indent=2)

            # Save to Redis
            key = self._get_config_key(user_id)
            self._redis_client.set(key, config_json)

            logger.info(f"Successfully saved configuration for user {user_id} to Redis")
            return True

        except Exception as e:
            logger.error(f"Error saving configuration for user {user_id}: {e}")
            return False

    def get_user_config(self, user_id: str) -> dict | None:
        """Get user configuration from Redis (search interface).

        Args:
            user_id (str): User ID.

        Returns:
            MOSConfig | None: User's configuration object, or None if not found.
        """
        try:
            # Get configuration from Redis
            key = self._get_config_key(user_id)
            config_json = self._redis_client.get(key)

            if config_json is None:
                logger.info(f"Configuration for user {user_id} does not exist")
                return None

            # Parse JSON and create MOSConfig object
            config_dict = json.loads(config_json)

            logger.info(f"Successfully retrieved configuration for user {user_id}")
            return config_dict

        except json.JSONDecodeError as e:
            logger.error(f"Error parsing JSON configuration for user {user_id}: {e}")
            return None
        except Exception as e:
            logger.error(f"Error retrieving configuration for user {user_id}: {e}")
            return None

    def delete_user_config(self, user_id: str) -> bool:
        """Delete user configuration from Redis.

        Args:
            user_id (str): User ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        try:
            key = self._get_config_key(user_id)
            result = self._redis_client.delete(key)

            if result > 0:
                logger.info(f"Successfully deleted configuration for user {user_id}")
                return True
            else:
                logger.warning(f"Configuration for user {user_id} does not exist, cannot delete")
                return False

        except Exception as e:
            logger.error(f"Error deleting configuration for user {user_id}: {e}")
            return False

    def exists_user_config(self, user_id: str) -> bool:
        """Check if user configuration exists.

        Args:
            user_id (str): User ID.

        Returns:
            bool: True if exists, False otherwise.
        """
        try:
            key = self._get_config_key(user_id)
            return self._redis_client.exists(key) > 0
        except Exception as e:
            logger.error(f"Error checking if configuration exists for user {user_id}: {e}")
            return False

    def list_user_configs(
        self, pattern: str = "user_config:*", count: int = 100
    ) -> dict[str, dict]:
        """List all user configurations.

        Args:
            pattern (str): Redis key matching pattern. Defaults to "user_config:*".
            count (int): Number of keys to return per scan. Defaults to 100.

        Returns:
            dict[str, dict]: Dictionary mapping user_id to dict objects.
        """
        result = {}
        try:
            # Use SCAN command to iterate through all matching keys
            cursor = 0
            while True:
                cursor, keys = self._redis_client.scan(cursor, match=pattern, count=count)

                for key in keys:
                    # Extract user_id (remove "user_config:" prefix)
                    user_id = key.replace("user_config:", "")
                    config = self.get_user_config(user_id)
                    if config:
                        result[user_id] = config

                if cursor == 0:
                    break

            logger.info(f"Successfully listed {len(result)} user configurations")
            return result

        except Exception as e:
            logger.error(f"Error listing user configurations: {e}")
            return {}

    def close(self) -> None:
        """Close Redis connection.

        This method should be called when the RedisPersistentUserManager is no longer needed
        to ensure proper cleanup of Redis connections.
        """
        try:
            if hasattr(self, "_redis_client") and self._redis_client:
                self._redis_client.close()
                logger.info("Redis connection closed")
        except Exception as e:
            logger.error(f"Error closing Redis connection: {e}")
