from typing import Any, ClassVar

from memos.configs.mem_user import UserManagerConfigFactory
from memos.mem_user.mysql_user_manager import MySQLUserManager
from memos.mem_user.user_manager import UserManager


class UserManagerFactory:
    """Factory class for creating user manager instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "sqlite": UserManager,
        "mysql": MySQLUserManager,
    }

    @classmethod
    def from_config(
        cls, config_factory: UserManagerConfigFactory
    ) -> UserManager | MySQLUserManager:
        """Create a user manager instance from configuration.

        Args:
            config_factory: Configuration factory containing backend and config

        Returns:
            User manager instance

        Raises:
            ValueError: If backend is not supported
        """
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid user manager backend: {backend}")

        user_manager_class = cls.backend_to_class[backend]
        config = config_factory.config

        # Use model_dump() to convert Pydantic model to dict and unpack as kwargs
        return user_manager_class(**config.model_dump())

    @classmethod
    def create_sqlite(cls, db_path: str | None = None, user_id: str = "root") -> UserManager:
        """Create SQLite user manager with default configuration.

        Args:
            db_path: Path to SQLite database file
            user_id: Default user ID for initialization

        Returns:
            SQLite user manager instance
        """
        config_factory = UserManagerConfigFactory(
            backend="sqlite", config={"db_path": db_path, "user_id": user_id}
        )
        return cls.from_config(config_factory)

    @classmethod
    def create_mysql(
        cls,
        user_id: str = "root",
        host: str = "localhost",
        port: int = 3306,
        username: str = "root",
        password: str = "",
        database: str = "memos_users",
        charset: str = "utf8mb4",
    ) -> MySQLUserManager:
        """Create MySQL user manager with specified configuration.

        Args:
            user_id: Default user ID for initialization
            host: MySQL server host
            port: MySQL server port
            username: MySQL username
            password: MySQL password
            database: MySQL database name
            charset: MySQL charset

        Returns:
            MySQL user manager instance
        """
        config_factory = UserManagerConfigFactory(
            backend="mysql",
            config={
                "user_id": user_id,
                "host": host,
                "port": port,
                "username": username,
                "password": password,
                "database": database,
                "charset": charset,
            },
        )
        return cls.from_config(config_factory)
