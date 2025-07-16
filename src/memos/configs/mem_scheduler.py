import os

from pathlib import Path
from typing import Any, ClassVar
from pathlib import Path
from pydantic import ConfigDict, Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.mem_scheduler.utils import parse_yaml
from memos.mem_scheduler.modules.schemas import (
    BASE_DIR,
    DEFAULT_ACT_MEM_DUMP_PATH,
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_THREAD__POOL_MAX_WORKERS,
    DictConversionMixin,
)


class BaseSchedulerConfig(BaseConfig):
    """Base configuration class for mem_scheduler."""

    top_k: int = Field(
        default=10, description="Number of top candidates to consider in initial retrieval"
    )
    top_n: int = Field(default=5, description="Number of final results to return after processing")
    enable_parallel_dispatch: bool = Field(
        default=True, description="Whether to enable parallel message processing using thread pool"
    )
    thread_pool_max_workers: int = Field(
        default=DEFAULT_THREAD__POOL_MAX_WORKERS,
        gt=1,
        lt=20,
        description=f"Maximum worker threads in pool (default: {DEFAULT_THREAD__POOL_MAX_WORKERS})",
    )
    consume_interval_seconds: int = Field(
        default=DEFAULT_CONSUME_INTERVAL_SECONDS,
        gt=0,
        le=60,
        description=f"Interval for consuming messages from queue in seconds (default: {DEFAULT_CONSUME_INTERVAL_SECONDS})",
    )
    auth_config_path: str | None = Field(
        default=None,
        description="Path to the authentication configuration file containing private credentials",
    )


class GeneralSchedulerConfig(BaseSchedulerConfig):
    act_mem_update_interval: int | None = Field(
        default=300, description="Interval in seconds for updating activation memory"
    )
    context_window_size: int | None = Field(
        default=5, description="Size of the context window for conversation history"
    )
    act_mem_dump_path: str | None = Field(
        default=DEFAULT_ACT_MEM_DUMP_PATH,  # Replace with DEFAULT_ACT_MEM_DUMP_PATH
        description="File path for dumping activation memory",
    )
    enable_act_memory_update: bool = Field(
        default=False, description="Whether to enable automatic activation memory updates"
    )


class SchedulerConfigFactory(BaseConfig):
    """Factory class for creating scheduler configurations."""

    backend: str = Field(..., description="Backend for scheduler")
    config: dict[str, Any] = Field(..., description="Configuration for the scheduler backend")

    model_config = ConfigDict(extra="forbid", strict=True)
    backend_to_class: ClassVar[dict[str, Any]] = {
        "general_scheduler": GeneralSchedulerConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "SchedulerConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self


# ************************* Auth *************************
class RabbitMQConfig(
    BaseConfig,
):
    host_name: str = Field(default="", description="Endpoint for RabbitMQ instance access")
    user_name: str = Field(default="", description="Static username for RabbitMQ instance")
    password: str = Field(default="", description="Password for the static username")
    virtual_host: str = Field(default="", description="Vhost name for RabbitMQ instance")
    erase_on_connect: bool = Field(
        default=True, description="Whether to clear connection state or buffers upon connecting"
    )
    port: int = Field(
        default=5672,
        description="Port number for RabbitMQ instance access",
        ge=1,  # Port must be >= 1
        le=65535,  # Port must be <= 65535
    )


class GraphDBAuthConfig(BaseConfig):
    uri: str = Field(default="localhost", description="URI for graph database access")


class OpenAIConfig(BaseConfig):
    api_key: str = Field(default="", description="API key for OpenAI service")
    base_url: str = Field(default="", description="Base URL for API endpoint")
    default_model: str = Field(default="", description="Default model to use")


class AuthConfig(BaseConfig, DictConversionMixin):
    rabbitmq: RabbitMQConfig
    openai: OpenAIConfig
    graph_db: GraphDBAuthConfig
    default_config_path: ClassVar[str] = (
        f"{BASE_DIR}/examples/data/config/mem_scheduler/scheduler_auth.yaml"
    )

    @classmethod
    def from_local_yaml(cls, config_path: str | None = None) -> "AuthConfig":
        """
        Load configuration from YAML file

        Args:
            config_path: Path to YAML configuration file

        Returns:
            AuthConfig instance

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If YAML parsing or validation fails
        """

        if config_path is None:
            config_path = cls.default_config_path

        # Check file exists
        if not Path(config_path).exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")

        return cls.from_yaml_file(yaml_path=config_path)

    def set_openai_config_to_environment(self):
        # Set environment variables
        os.environ["OPENAI_API_KEY"] = self.openai.api_key
        os.environ["OPENAI_BASE_URL"] = self.openai.base_url
        os.environ["MODEL"] = self.openai.default_model

    @classmethod
    def default_config_exists(cls) -> bool:
        """
        Check if the default configuration file exists.

        Returns:
            bool: True if the default config file exists, False otherwise
        """
        return Path(cls.default_config_path).exists()
