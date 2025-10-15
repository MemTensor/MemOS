from typing import Any, ClassVar

from pydantic import BaseModel, Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseUserManagerConfig(BaseConfig):
    """Base configuration class for user managers."""

    user_id: str = Field(default="root", description="Default user ID for initialization")


class SQLiteUserManagerConfig(BaseUserManagerConfig):
    """SQLite user manager configuration."""

    db_path: str | None = Field(
        default=None,
        description="Path to SQLite database file. If None, uses default path in MEMOS_DIR",
    )


class MySQLUserManagerConfig(BaseUserManagerConfig):
    """MySQL user manager configuration."""

    host: str = Field(default="localhost", description="MySQL server host")
    port: int = Field(default=3306, description="MySQL server port")
    username: str = Field(default="root", description="MySQL username")
    password: str = Field(default="", description="MySQL password")
    database: str = Field(default="memos_users", description="MySQL database name")
    charset: str = Field(default="utf8mb4", description="MySQL charset")


class RedisUserManagerConfig(BaseUserManagerConfig):
    """Redis user manager configuration."""

    host: str = Field(default="localhost", description="Redis server host")
    port: int = Field(default=6379, description="Redis server port")
    username: str = Field(default="root", description="Redis username")
    password: str = Field(default="", description="Redis password")
    database: str = Field(default="memos_users", description="Redis database name")
    charset: str = Field(default="utf8mb4", description="Redis charset")


class UserManagerConfigFactory(BaseModel):
    """Factory for user manager configurations."""

    backend: str = Field(default="sqlite", description="Backend for user manager")
    config: dict[str, Any] = Field(
        default_factory=dict, description="Configuration for the user manager backend"
    )

    backend_to_class: ClassVar[dict[str, Any]] = {
        "sqlite": SQLiteUserManagerConfig,
        "mysql": MySQLUserManagerConfig,
        "redis": RedisUserManagerConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        if backend not in cls.backend_to_class:
            raise ValueError(f"Unsupported user manager backend: {backend}")
        return backend

    @model_validator(mode="after")
    def instantiate_config(self):
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
