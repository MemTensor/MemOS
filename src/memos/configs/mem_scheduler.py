import logging
import os

from pathlib import Path
from typing import Any, ClassVar

from pydantic import ConfigDict, Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.mem_scheduler.general_modules.misc import DictConversionMixin, EnvConfigMixin
from memos.mem_scheduler.schemas.general_schemas import (
    BASE_DIR,
    DEFAULT_ACT_MEM_DUMP_PATH,
    DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT,
    DEFAULT_CONSUME_BATCH,
    DEFAULT_CONSUME_INTERVAL_SECONDS,
    DEFAULT_CONTEXT_WINDOW_SIZE,
    DEFAULT_MAX_INTERNAL_MESSAGE_QUEUE_SIZE,
    DEFAULT_MULTI_TASK_RUNNING_TIMEOUT,
    DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE,
    DEFAULT_SCHEDULER_RETRIEVER_RETRIES,
    DEFAULT_THREAD_POOL_MAX_WORKERS,
    DEFAULT_TOP_K,
    DEFAULT_USE_REDIS_QUEUE,
    DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT,
)


class BaseSchedulerConfig(BaseConfig):
    """Base configuration class for mem_scheduler."""

    top_k: int = Field(
        default=DEFAULT_TOP_K,
        description="Number of top candidates to consider in initial retrieval",
    )
    enable_parallel_dispatch: bool = Field(
        default=True, description="Whether to enable parallel message processing using thread pool"
    )
    thread_pool_max_workers: int = Field(
        default=DEFAULT_THREAD_POOL_MAX_WORKERS,
        gt=1,
        description=f"Maximum worker threads in pool (default: {DEFAULT_THREAD_POOL_MAX_WORKERS})",
    )
    consume_interval_seconds: float = Field(
        default=DEFAULT_CONSUME_INTERVAL_SECONDS,
        gt=0,
        description=f"Interval for consuming messages from queue in seconds (default: {DEFAULT_CONSUME_INTERVAL_SECONDS})",
    )
    consume_batch: int = Field(
        default=DEFAULT_CONSUME_BATCH,
        gt=0,
        description=f"Number of messages to consume in each batch (default: {DEFAULT_CONSUME_BATCH})",
    )
    auth_config_path: str | None = Field(
        default=None,
        description="Path to the authentication configuration file containing private credentials",
    )
    # Redis queue configuration
    use_redis_queue: bool = Field(
        default=DEFAULT_USE_REDIS_QUEUE,
        description="Whether to use Redis queue instead of local memory queue",
    )
    redis_config: dict[str, Any] = Field(
        default_factory=lambda: {"host": "localhost", "port": 6379, "db": 0},
        description="Redis connection configuration",
    )
    max_internal_message_queue_size: int = Field(
        default=DEFAULT_MAX_INTERNAL_MESSAGE_QUEUE_SIZE,
        description="Maximum size of internal message queue when not using Redis",
    )
    multi_task_running_timeout: int = Field(
        default=DEFAULT_MULTI_TASK_RUNNING_TIMEOUT,
        description="Default timeout for multi-task running operations in seconds",
    )


class GeneralSchedulerConfig(BaseSchedulerConfig):
    model_config = ConfigDict(extra="ignore", strict=True)
    act_mem_update_interval: int | None = Field(
        default=300, description="Interval in seconds for updating activation memory"
    )
    context_window_size: int | None = Field(
        default=DEFAULT_CONTEXT_WINDOW_SIZE,
        description="Size of the context window for conversation history",
    )
    act_mem_dump_path: str | None = Field(
        default=DEFAULT_ACT_MEM_DUMP_PATH,  # Replace with DEFAULT_ACT_MEM_DUMP_PATH
        description="File path for dumping activation memory",
    )
    enable_activation_memory: bool = Field(
        default=False, description="Whether to enable automatic activation memory updates"
    )
    working_mem_monitor_capacity: int = Field(
        default=DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT,
        description="Capacity of the working memory monitor",
    )
    activation_mem_monitor_capacity: int = Field(
        default=DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT,
        description="Capacity of the activation memory monitor",
    )

    # Memory enhancement concurrency & retries configuration
    enhance_batch_size: int | None = Field(
        default=DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE,
        description="Batch size for concurrent memory enhancement; None or <=1 disables batching",
    )
    enhance_retries: int = Field(
        default=DEFAULT_SCHEDULER_RETRIEVER_RETRIES,
        ge=0,
        description="Number of retry attempts per enhancement batch",
    )

    # Database configuration for ORM persistence
    db_path: str | None = Field(
        default=None,
        description="Path to SQLite database file for ORM persistence. If None, uses default scheduler_orm.db",
    )
    db_url: str | None = Field(
        default=None,
        description="Database URL for ORM persistence (e.g., mysql://user:pass@host/db). Takes precedence over db_path",
    )
    enable_orm_persistence: bool = Field(
        default=True, description="Whether to enable ORM-based persistence for monitors"
    )


class OptimizedSchedulerConfig(GeneralSchedulerConfig):
    """Configuration for the optimized scheduler.

    This class inherits all fields from `GeneralSchedulerConfig`
    and is used to distinguish optimized scheduling logic via type.
    """


class SchedulerConfigFactory(BaseConfig):
    """Factory class for creating scheduler configurations."""

    backend: str = Field(..., description="Backend for scheduler")
    config: dict[str, Any] = Field(..., description="Configuration for the scheduler backend")

    model_config = ConfigDict(extra="forbid", strict=True)
    backend_to_class: ClassVar[dict[str, Any]] = {
        "general_scheduler": GeneralSchedulerConfig,
        "optimized_scheduler": OptimizedSchedulerConfig,  # optimized_scheduler uses same config as general_scheduler
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
    DictConversionMixin,
    EnvConfigMixin,
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
    exchange_name: str = Field(
        default="memos-fanout",
        description="Exchange name for RabbitMQ (e.g., memos-fanout, memos-memory-change)",
    )
    exchange_type: str = Field(
        default="fanout", description="Exchange type for RabbitMQ (fanout or direct)"
    )


class GraphDBAuthConfig(BaseConfig, DictConversionMixin, EnvConfigMixin):
    uri: str = Field(
        default="bolt://localhost:7687",
        description="URI for graph database access (e.g., bolt://host:port)",
    )
    user: str = Field(default="neo4j", description="Username for graph database authentication")
    password: str = Field(
        default="",
        description="Password for graph database authentication",
        min_length=8,  # Recommended minimum password length
    )
    db_name: str = Field(default="neo4j", description="Database name to connect to")
    auto_create: bool = Field(
        default=True, description="Whether to automatically create the database if it doesn't exist"
    )


class OpenAIConfig(BaseConfig, DictConversionMixin, EnvConfigMixin):
    api_key: str = Field(default="", description="API key for OpenAI service")
    base_url: str = Field(default="", description="Base URL for API endpoint")
    default_model: str = Field(default="", description="Default model to use")


class AuthConfig(BaseConfig, DictConversionMixin):
    rabbitmq: RabbitMQConfig | None = None
    openai: OpenAIConfig | None = None
    graph_db: GraphDBAuthConfig | None = None
    default_config_path: ClassVar[str] = (
        f"{BASE_DIR}/examples/data/config/mem_scheduler/scheduler_auth.yaml"
    )

    @model_validator(mode="after")
    def validate_partial_initialization(self) -> "AuthConfig":
        """
        Validate that at least one configuration component is successfully initialized.
        Log warnings for any failed initializations but allow partial success.
        """
        logger = logging.getLogger(__name__)

        initialized_components = []
        failed_components = []

        if self.rabbitmq is not None:
            initialized_components.append("rabbitmq")
        else:
            failed_components.append("rabbitmq")

        if self.openai is not None:
            initialized_components.append("openai")
        else:
            failed_components.append("openai")

        if self.graph_db is not None:
            initialized_components.append("graph_db")
        else:
            failed_components.append("graph_db")

        # Allow all components to be None for flexibility, but log a warning
        if not initialized_components:
            logger.warning(
                "All configuration components are None. This may indicate missing environment variables or configuration files."
            )
        elif failed_components:
            logger.warning(
                f"Failed to initialize components: {', '.join(failed_components)}. Successfully initialized: {', '.join(initialized_components)}"
            )

        return self

    @classmethod
    def from_local_config(cls, config_path: str | Path | None = None) -> "AuthConfig":
        """
        Load configuration from either a YAML or JSON file based on file extension.

        Automatically detects file type (YAML or JSON) from the file extension
        and uses the appropriate parser. If no path is provided, uses the default
        configuration path (YAML) or its JSON counterpart.

        Args:
            config_path: Optional path to configuration file.
                         If not provided, uses default configuration path.

        Returns:
            AuthConfig instance populated with data from the configuration file.

        Raises:
            FileNotFoundError: If the specified or default configuration file does not exist.
            ValueError: If file extension is not .yaml/.yml or .json, or if parsing fails.
        """
        # Determine config path
        if config_path is None:
            config_path = cls.default_config_path

        # Validate file existence
        config_path_obj = Path(config_path)
        if not config_path_obj.exists():
            raise FileNotFoundError(f"Configuration file not found: {config_path}")

        # Get file extension and determine parser
        file_ext = config_path_obj.suffix.lower()

        if file_ext in (".yaml", ".yml"):
            return cls.from_yaml_file(yaml_path=str(config_path_obj))
        elif file_ext == ".json":
            return cls.from_json_file(json_path=str(config_path_obj))
        else:
            raise ValueError(
                f"Unsupported file format: {file_ext}. "
                "Please use YAML (.yaml, .yml) or JSON (.json) files."
            )

    @classmethod
    def from_local_env(cls) -> "AuthConfig":
        """Creates an AuthConfig instance by loading configuration from environment variables.

        This method loads configuration for all nested components (RabbitMQ, OpenAI, GraphDB)
        from their respective environment variables using each component's specific prefix.
        If any component fails to initialize, it will be set to None and a warning will be logged.

        Returns:
            AuthConfig: Configured instance with values from environment variables

        Raises:
            ValueError: If all components fail to initialize
        """
        logger = logging.getLogger(__name__)

        rabbitmq_config = None
        openai_config = None
        graph_db_config = None

        # Try to initialize RabbitMQ config - check if any RabbitMQ env vars exist
        try:
            rabbitmq_prefix = RabbitMQConfig.get_env_prefix()
            has_rabbitmq_env = any(key.startswith(rabbitmq_prefix) for key in os.environ)
            if has_rabbitmq_env:
                rabbitmq_config = RabbitMQConfig.from_env()
                logger.info("Successfully initialized RabbitMQ configuration")
            else:
                logger.info(
                    "No RabbitMQ environment variables found, skipping RabbitMQ initialization"
                )
        except (ValueError, Exception) as e:
            logger.warning(f"Failed to initialize RabbitMQ config from environment: {e}")

        # Try to initialize OpenAI config - check if any OpenAI env vars exist
        try:
            openai_prefix = OpenAIConfig.get_env_prefix()
            has_openai_env = any(key.startswith(openai_prefix) for key in os.environ)
            if has_openai_env:
                openai_config = OpenAIConfig.from_env()
                logger.info("Successfully initialized OpenAI configuration")
            else:
                logger.info("No OpenAI environment variables found, skipping OpenAI initialization")
        except (ValueError, Exception) as e:
            logger.warning(f"Failed to initialize OpenAI config from environment: {e}")

        # Try to initialize GraphDB config - check if any GraphDB env vars exist
        try:
            graphdb_prefix = GraphDBAuthConfig.get_env_prefix()
            has_graphdb_env = any(key.startswith(graphdb_prefix) for key in os.environ)
            if has_graphdb_env:
                graph_db_config = GraphDBAuthConfig.from_env()
                logger.info("Successfully initialized GraphDB configuration")
            else:
                logger.info(
                    "No GraphDB environment variables found, skipping GraphDB initialization"
                )
        except (ValueError, Exception) as e:
            logger.warning(f"Failed to initialize GraphDB config from environment: {e}")

        return cls(
            rabbitmq=rabbitmq_config,
            openai=openai_config,
            graph_db=graph_db_config,
        )

    def set_openai_config_to_environment(self):
        # Set environment variables only if openai config is available
        if self.openai is not None:
            os.environ["OPENAI_API_KEY"] = self.openai.api_key
            os.environ["OPENAI_BASE_URL"] = self.openai.base_url
            os.environ["MODEL"] = self.openai.default_model
        else:
            logger = logging.getLogger(__name__)
            logger.warning("OpenAI config is not available, skipping environment variable setup")

    @classmethod
    def default_config_exists(cls) -> bool:
        """
        Check if the default configuration file exists.

        Returns:
            bool: True if the default config file exists, False otherwise
        """
        return Path(cls.default_config_path).exists()
