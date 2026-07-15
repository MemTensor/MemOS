"""Persistent user management system for MemOS with configuration storage.

This module extends the base UserManager to provide persistent storage
for user configurations and MOS instances.
"""

import json

from datetime import datetime
from typing import Any

from sqlalchemy import Column, String, Text

from memos.configs.mem_os import MOSConfig
from memos.log import get_logger
from memos.mem_user.user_manager import Base, UserManager


logger = get_logger(__name__)


class UserConfig(Base):
    """User configuration model for the database."""

    __tablename__ = "user_configs"

    user_id = Column(String, primary_key=True)
    config_data = Column(Text, nullable=False)  # JSON string of MOSConfig
    created_at = Column(String, nullable=False)  # ISO format timestamp
    updated_at = Column(String, nullable=False)  # ISO format timestamp

    def __repr__(self):
        return f"<UserConfig(user_id='{self.user_id}')>"


class PersistentUserManager(UserManager):
    """Extended UserManager with configuration persistence."""

    def __init__(self, db_path: str | None = None, user_id: str = "root"):
        """Initialize the persistent user manager.

        Args:
            db_path (str, optional): Path to the SQLite database file.
                If None, uses default path in MEMOS_DIR.
            user_id (str, optional): User ID. If None, uses default user ID.
        """
        super().__init__(db_path, user_id)

        # Create user_configs table
        Base.metadata.create_all(bind=self.engine)
        logger.info("PersistentUserManager initialized with configuration storage")

    def _convert_datetime_strings(self, obj: Any) -> Any:
        """Recursively convert datetime strings back to datetime objects in config dict.

        Args:
            obj: The object to process (dict, list, or primitive type)

        Returns:
            The object with datetime strings converted to datetime objects
        """
        if isinstance(obj, dict):
            result = {}
            for key, value in obj.items():
                if key == "created_at" and isinstance(value, str):
                    try:
                        result[key] = datetime.fromisoformat(value)
                    except ValueError:
                        # If parsing fails, keep the original string
                        result[key] = value
                else:
                    result[key] = self._convert_datetime_strings(value)
            return result
        elif isinstance(obj, list):
            return [self._convert_datetime_strings(item) for item in obj]
        else:
            return obj

    def save_user_config(self, user_id: str, config: MOSConfig) -> bool:
        """Save user configuration to database.

        Args:
            user_id (str): The user ID.
            config (MOSConfig): The user's MOS configuration.

        Returns:
            bool: True if successful, False otherwise.
        """
        session = self._get_session()
        try:
            # Convert config to JSON string with proper datetime handling
            config_dict = config.model_dump(mode="json")
            config_json = json.dumps(config_dict, indent=2)

            from datetime import datetime

            now = datetime.now().isoformat()

            # Check if config already exists
            existing_config = (
                session.query(UserConfig).filter(UserConfig.user_id == user_id).first()
            )

            if existing_config:
                # Update existing config
                existing_config.config_data = config_json
                existing_config.updated_at = now
                logger.info(f"Updated configuration for user {user_id}")
            else:
                # Create new config
                user_config = UserConfig(
                    user_id=user_id, config_data=config_json, created_at=now, updated_at=now
                )
                session.add(user_config)
                logger.info(f"Saved new configuration for user {user_id}")

            session.commit()
            return True

        except Exception as e:
            session.rollback()
            logger.error(f"Error saving user config for {user_id}: {e}")
            return False
        finally:
            session.close()

    def get_user_config(self, user_id: str) -> MOSConfig | None:
        """Get user configuration from database.

        Args:
            user_id (str): The user ID.

        Returns:
            MOSConfig | None: The user's configuration or None if not found.
        """
        session = self._get_session()
        try:
            user_config = session.query(UserConfig).filter(UserConfig.user_id == user_id).first()

            if user_config:
                config_dict = json.loads(user_config.config_data)
                # Convert datetime strings back to datetime objects
                config_dict = self._convert_datetime_strings(config_dict)
                return MOSConfig(**config_dict)
            return None

        except Exception as e:
            logger.error(f"Error loading user config for {user_id}: {e}")
            return None
        finally:
            session.close()

    def delete_user_config(self, user_id: str) -> bool:
        """Delete user configuration from database.

        Args:
            user_id (str): The user ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        session = self._get_session()
        try:
            user_config = session.query(UserConfig).filter(UserConfig.user_id == user_id).first()

            if user_config:
                session.delete(user_config)
                session.commit()
                logger.info(f"Deleted configuration for user {user_id}")
                return True
            return False

        except Exception as e:
            session.rollback()
            logger.error(f"Error deleting user config for {user_id}: {e}")
            return False
        finally:
            session.close()

    def list_user_configs(self, limit: int = 1) -> dict[str, MOSConfig]:
        """List all user configurations.

        Returns:
            Dict[str, MOSConfig]: Dictionary mapping user_id to MOSConfig.
        """
        session = self._get_session()
        try:
            user_configs = session.query(UserConfig).limit(limit).all()
            result = {}

            for user_config in user_configs:
                try:
                    config_dict = json.loads(user_config.config_data)
                    # Convert datetime strings back to datetime objects
                    config_dict = self._convert_datetime_strings(config_dict)
                    result[user_config.user_id] = MOSConfig(**config_dict)
                except Exception as e:
                    logger.error(f"Error parsing config for user {user_config.user_id}: {e}")
                    continue

            return result

        except Exception as e:
            logger.error(f"Error listing user configs: {e}")
            return {}
        finally:
            session.close()

    def create_user_with_config(
        self, user_name: str, config: MOSConfig, role=None, user_id: str | None = None
    ) -> str:
        """Create a new user with configuration.

        Args:
            user_name (str): Name of the user.
            config (MOSConfig): The user's configuration.
            role: User role (optional, uses default from UserManager).
            user_id (str, optional): Custom user ID.

        Returns:
            str: The created user ID.

        Raises:
            ValueError: If user_name already exists.
        """
        # Create user using parent method
        created_user_id = self.create_user(user_name, role, user_id)

        # Save configuration
        if not self.save_user_config(created_user_id, config):
            logger.error(f"Failed to save configuration for user {created_user_id}")

        return created_user_id

    def delete_user(self, user_id: str) -> bool:
        """Delete a user and their configuration.

        Args:
            user_id (str): The user ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        # Delete configuration first
        self.delete_user_config(user_id)

        # Delete user using parent method
        return super().delete_user(user_id)

    def get_user_cube_access(self, user_id: str) -> list[str]:
        """Get list of cube IDs that a user has access to.

        Args:
            user_id (str): The user ID.

        Returns:
            list[str]: List of cube IDs the user can access.
        """
        cubes = self.get_user_cubes(user_id)
        return [cube.cube_id for cube in cubes]
