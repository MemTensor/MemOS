import json

from contextlib import suppress
from datetime import datetime
from queue import Empty, Full, Queue
from typing import TYPE_CHECKING, ClassVar, TypeVar


if TYPE_CHECKING:
    from pydantic import BaseModel

T = TypeVar("T")

BaseModelType = TypeVar("T", bound="BaseModel")


class DictConversionMixin:
    def to_dict(self) -> dict:
        """Convert the instance to a dictionary."""
        return {
            **self.model_dump(),  # 替换 self.dict()
            "timestamp": self.timestamp.isoformat() if hasattr(self, "timestamp") else None,
        }

    @classmethod
    def from_dict(cls: type[BaseModelType], data: dict) -> BaseModelType:
        """Create an instance from a dictionary."""
        if "timestamp" in data:
            data["timestamp"] = datetime.fromisoformat(data["timestamp"])
        return cls(**data)

    def __str__(self) -> str:
        """Convert the instance to a JSON string with indentation of 4 spaces.
        This will be used when str() or print() is called on the instance.

        Returns:
            str: A JSON string representation of the instance with 4-space indentation.
        """
        return json.dumps(
            self.to_dict(),
            indent=4,
            ensure_ascii=False,
            default=str,  # 处理无法序列化的对象
        )

    class Config:
        json_encoders: ClassVar[dict[type, object]] = {datetime: lambda v: v.isoformat()}


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
