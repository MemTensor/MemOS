import threading

from queue import Empty, Full, Queue
from typing import TypeVar


T = TypeVar("T")


class AutoDroppingQueue(Queue[T]):
    """A thread-safe queue that automatically drops the oldest item when full."""

    def __init__(self, maxsize: int = 0):
        super().__init__(maxsize=maxsize)
        self._lock = threading.Lock()  # Additional lock to prevent race conditions

    def put(self, item: T, block: bool = True, timeout: float | None = None) -> None:
        """Put an item into the queue.

        If the queue is full, the oldest item will be automatically removed to make space.
        This operation is thread-safe.

        Args:
            item: The item to be put into the queue
            block: Ignored (kept for compatibility with Queue interface)
            timeout: Ignored (kept for compatibility with Queue interface)
        """
        with self._lock:  # Ensure atomic operation
            try:
                # First try non-blocking put
                super().put(item, block=False)
            except Full:
                # If queue is full, remove the oldest item
                from contextlib import suppress

                with suppress(Empty):
                    self.get_nowait()  # Remove oldest item
                # Retry putting the new item
                super().put(item, block=False)
