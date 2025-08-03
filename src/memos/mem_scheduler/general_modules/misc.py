import json

from contextlib import suppress
from datetime import datetime
from queue import Empty, Full, Queue
from typing import TYPE_CHECKING, TypeVar

from pydantic import field_serializer


if TYPE_CHECKING:
    from pydantic import BaseModel

T = TypeVar("T")

BaseModelType = TypeVar("T", bound="BaseModel")


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
