import json
import os

from contextlib import suppress
from datetime import datetime
from queue import Empty, Full, Queue
from typing import TYPE_CHECKING, Any, Generic, TypeVar

from pydantic import field_serializer


if TYPE_CHECKING:
    from pydantic import BaseModel

T = TypeVar("T")

BaseModelType = TypeVar("T", bound="BaseModel")


class EnvConfigMixin(Generic[T]):
    """Abstract base class for environment variable configuration."""

    ENV_PREFIX = "MEMSCHEDULER_"

    @classmethod
    def get_env_prefix(cls) -> str:
        """Automatically generates environment variable prefix from class name.

        Converts the class name to uppercase and appends an underscore.
        If the class name ends with 'Config', that suffix is removed first.

        Examples:
            RabbitMQConfig -> "RABBITMQ_"
            OpenAIConfig -> "OPENAI_"
            GraphDBAuthConfig -> "GRAPH_DB_AUTH_"
        """
        class_name = cls.__name__
        # Remove 'Config' suffix if present
        if class_name.endswith("Config"):
            class_name = class_name[:-6]
        # Convert to uppercase and add trailing underscore

        return f"{cls.ENV_PREFIX}{class_name.upper()}_"

    @classmethod
    def from_env(cls: type[T]) -> T:
        """Creates a config instance from environment variables.

        Reads all environment variables with the class-specific prefix and maps them
        to corresponding configuration fields (converting to the appropriate types).

        Returns:
            An instance of the config class populated from environment variables.

        Raises:
            ValueError: If required environment variables are missing.
        """
        prefix = cls.get_env_prefix()
        field_values = {}

        for field_name, field_info in cls.model_fields.items():
            env_var = f"{prefix}{field_name.upper()}"
            field_type = field_info.annotation

            if field_info.is_required() and env_var not in os.environ:
                raise ValueError(f"Required environment variable {env_var} is missing")

            if env_var in os.environ:
                raw_value = os.environ[env_var]
                field_values[field_name] = cls._parse_env_value(raw_value, field_type)
            elif field_info.default is not None:
                field_values[field_name] = field_info.default
            else:
                raise ValueError()
        return cls(**field_values)

    @classmethod
    def _parse_env_value(cls, value: str, target_type: type) -> Any:
        """Converts environment variable string to appropriate type."""
        if target_type is bool:
            return value.lower() in ("true", "1", "t", "y", "yes")
        if target_type is int:
            return int(value)
        if target_type is float:
            return float(value)
        return value


class DictConversionMixin:
    """
    Provides conversion functionality between Pydantic models and dictionaries,
    including datetime serialization handling.
    """

    @field_serializer("timestamp", check_fields=False)
    def serialize_datetime(self, dt: datetime | None, _info) -> str | None:
        """
        Custom datetime serialization logic.
        - Supports timezone-aware datetime objects
        - Compatible with models without timestamp field (via check_fields=False)
        """
        if dt is None:
            return None
        return dt.isoformat()

    def to_dict(self) -> dict:
        """
        Convert model instance to dictionary.
        - Uses model_dump to ensure field consistency
        - Prioritizes custom serializer for timestamp handling
        """
        dump_data = self.model_dump()
        if hasattr(self, "timestamp") and self.timestamp is not None:
            dump_data["timestamp"] = self.serialize_datetime(self.timestamp, None)
        return dump_data

    def to_json(self, **kwargs) -> str:
        """
        Convert model instance to a JSON string.
        - Accepts the same kwargs as json.dumps (e.g., indent, ensure_ascii)
        - Default settings make JSON human-readable and UTF-8 safe
        """
        return json.dumps(self.to_dict(), ensure_ascii=False, default=lambda o: str(o), **kwargs)

    @classmethod
    def from_json(cls: type[BaseModelType], json_str: str) -> BaseModelType:
        """
        Create model instance from a JSON string.
        - Parses JSON into a dictionary and delegates to from_dict
        """
        try:
            data = json.loads(json_str)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON string: {e}") from e
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls: type[BaseModelType], data: dict) -> BaseModelType:
        """
        Create model instance from dictionary.
        - Automatically converts timestamp strings to datetime objects
        """
        data_copy = data.copy()  # Avoid modifying original dictionary
        if "timestamp" in data_copy and isinstance(data_copy["timestamp"], str):
            try:
                data_copy["timestamp"] = datetime.fromisoformat(data_copy["timestamp"])
            except ValueError:
                # Handle invalid time formats - adjust as needed (e.g., log warning or set to None)
                data_copy["timestamp"] = None

        return cls(**data_copy)

    def __str__(self) -> str:
        """
        Convert to formatted JSON string.
        - Used for user-friendly display in print() or str() calls
        """
        return json.dumps(
            self.to_dict(),
            indent=4,
            ensure_ascii=False,
            default=lambda o: str(o),  # Handle other non-serializable objects
        )


class AutoDroppingQueue(Queue[T]):
    """A thread-safe queue that automatically drops the oldest item when full."""

    def __init__(self, maxsize: int = 0):
        super().__init__(maxsize=maxsize)

    def put(self, item: T, block: bool = False, timeout: float | None = None) -> None:
        """Put an item into the queue.

        If the queue is full, the oldest item will be automatically removed to make space.
        This operation is thread-safe.

        Args:
            item: The item to be put into the queue
            block: Ignored (kept for compatibility with Queue interface)
            timeout: Ignored (kept for compatibility with Queue interface)
        """
        try:
            # First try non-blocking put
            super().put(item, block=block, timeout=timeout)
        except Full:
            with suppress(Empty):
                self.get_nowait()  # Remove oldest item
            # Retry putting the new item
            super().put(item, block=block, timeout=timeout)

    def get_queue_content_without_pop(self) -> list[T]:
        """Return a copy of the queue's contents without modifying it."""
        return list(self.queue)

    def clear(self) -> None:
        """Remove all items from the queue.

        This operation is thread-safe.
        """
        with self.mutex:
            self.queue.clear()
