import json
import os

from contextlib import suppress
from datetime import datetime
from queue import Empty, Full, Queue
from typing import TYPE_CHECKING, Any, Generic, TypeVar

from dotenv import load_dotenv
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
            GraphDBAuthConfig -> "GRAPHDBAUTH_"
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
        load_dotenv()

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

    @classmethod
    def print_env_mapping(cls) -> None:
        """Print the mapping between class fields and their corresponding environment variable names.

        Displays each field's name, type, whether it's required, default value, and corresponding environment variable name.
        """
        prefix = cls.get_env_prefix()
        print(f"\n=== {cls.__name__} Environment Variable Mapping ===")
        print(f"Environment Variable Prefix: {prefix}")
        print("-" * 60)

        if not hasattr(cls, "model_fields"):
            print("This class does not define model_fields, may not be a Pydantic model")
            return

        for field_name, field_info in cls.model_fields.items():
            env_var = f"{prefix}{field_name.upper()}"
            field_type = field_info.annotation
            is_required = field_info.is_required()
            default_value = field_info.default if field_info.default is not None else "None"

            print(f"Field Name: {field_name}")
            print(f"  Environment Variable: {env_var}")
            print(f"  Type: {field_type}")
            print(f"  Required: {'Yes' if is_required else 'No'}")
            print(f"  Default Value: {default_value}")
            print(f"  Current Environment Value: {os.environ.get(env_var, 'Not Set')}")
            print("-" * 40)


class DictConversionMixin:
    """
    Provides conversion functionality between Pydantic models and dictionaries,
    including datetime serialization handling.
    """

    @field_serializer("timestamp", check_fields=False)
    def serialize_datetime(self, dt: datetime | None, _info) -> str | None:
        """
        Custom timestamp serialization logic.
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
        # If maxsize <= 0, set to 0 (unlimited queue size)
        if maxsize <= 0:
            maxsize = 0
        super().__init__(maxsize=maxsize)

    def put(self, item: T, block: bool = False, timeout: float | None = None) -> None:
        """Put an item into the queue.

        If the queue is full, the oldest item will be automatically removed to make space.
        IMPORTANT: When we drop an item we also call `task_done()` to keep
        the internal `unfinished_tasks` counter consistent (the dropped task
        will never be processed).

        Args:
            item: The item to be put into the queue
            block: Ignored (kept for compatibility with Queue interface)
            timeout: Ignored (kept for compatibility with Queue interface)
        """
        while True:
            try:
                # First try non-blocking put
                super().put(item, block=block, timeout=timeout)
                return
            except Full:
                # Remove the oldest item and mark it done to avoid leaking unfinished_tasks
                with suppress(Empty):
                    _ = self.get_nowait()
                    # If the removed item had previously incremented unfinished_tasks,
                    # we must decrement here since it will never be processed.
                    with suppress(ValueError):
                        self.task_done()
                # Continue loop to retry putting the item

    def get(
        self, block: bool = True, timeout: float | None = None, batch_size: int | None = None
    ) -> list[T]:
        """Get items from the queue.

        Args:
            block: Whether to block if no items are available (default: True)
            timeout: Timeout in seconds for blocking operations (default: None)
            batch_size: Number of items to retrieve (default: 1)

        Returns:
            List of items (always returns a list for consistency)

        Raises:
            Empty: If no items are available and block=False or timeout expires
        """

        if batch_size is None:
            return super().get(block=block, timeout=timeout)
        items = []
        for _ in range(batch_size):
            try:
                items.append(super().get(block=block, timeout=timeout))
            except Empty:
                if not items and block:
                    # If we haven't gotten any items and we're blocking, re-raise Empty
                    raise
                break
        return items

    def get_nowait(self, batch_size: int | None = None) -> list[T]:
        """Get items from the queue without blocking.

        Args:
            batch_size: Number of items to retrieve (default: 1)

        Returns:
            List of items (always returns a list for consistency)
        """
        if batch_size is None:
            return super().get_nowait()

        items = []
        for _ in range(batch_size):
            try:
                items.append(super().get_nowait())
            except Empty:
                break
        return items

    def get_queue_content_without_pop(self) -> list[T]:
        """Return a copy of the queue's contents without modifying it."""
        # Ensure a consistent snapshot by holding the mutex
        with self.mutex:
            return list(self.queue)

    def qsize(self) -> int:
        """Return the approximate size of the queue.

        Returns:
            Number of items currently in the queue
        """
        return super().qsize()

    def clear(self) -> None:
        """Remove all items from the queue.

        This operation is thread-safe.
        IMPORTANT: We also decrement `unfinished_tasks` by the number of
        items cleared, since those tasks will never be processed.
        """
        with self.mutex:
            dropped = len(self.queue)
            self.queue.clear()
        # Call task_done() outside of the mutex to avoid deadlocks because
        # Queue.task_done() acquires the same condition bound to `self.mutex`.
        for _ in range(dropped):
            with suppress(ValueError):
                self.task_done()
