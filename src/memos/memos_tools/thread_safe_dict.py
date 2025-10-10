"""
Thread-safe dictionary wrapper for concurrent access with optimized read-write locks.
"""

import threading

from collections.abc import ItemsView, Iterator, KeysView, ValuesView
from typing import Generic, TypeVar

from memos.log import get_logger
from memos.utils import timed


K = TypeVar("K")
V = TypeVar("V")

logger = get_logger(__name__)


class ReadWriteLock:
    """A simple read-write lock implementation. use for product-server scenario"""

    def __init__(self):
        self._read_ready = threading.Condition(threading.RLock())
        self._readers = 0

    @timed
    def acquire_read(self):
        """Acquire a read lock. Multiple readers can hold the lock simultaneously."""
        self._read_ready.acquire()
        try:
            self._readers += 1
        finally:
            self._read_ready.release()

    def release_read(self):
        """Release a read lock."""
        self._read_ready.acquire()
        try:
            self._readers -= 1
            if self._readers == 0:
                self._read_ready.notify_all()
        finally:
            self._read_ready.release()

    @timed
    def acquire_write(self):
        """Acquire a write lock. Only one writer can hold the lock."""
        self._read_ready.acquire()
        while self._readers > 0:
            self._read_ready.wait()

    def release_write(self):
        """Release a write lock."""
        self._read_ready.release()


class ThreadSafeDict(Generic[K, V]):
    """
    A thread-safe dictionary wrapper with optimized read-write locks.

    This class allows multiple concurrent readers while ensuring exclusive access for writers.
    Read operations (get, contains, iteration) can happen concurrently.
    Write operations (set, delete, update) are exclusive.
    """

    def __init__(self, initial_dict: dict[K, V] | None = None):
        """
        Initialize the thread-safe dictionary.

        Args:
            initial_dict: Optional initial dictionary to copy from
        """
        self._dict: dict[K, V] = initial_dict.copy() if initial_dict else {}
        self._lock = ReadWriteLock()

    @timed
    def __getitem__(self, key: K) -> V:
        """Get item by key."""
        self._lock.acquire_read()
        try:
            return self._dict[key]
        finally:
            self._lock.release_read()

    @timed
    def __setitem__(self, key: K, value: V) -> None:
        """Set item by key."""
        self._lock.acquire_write()
        try:
            self._dict[key] = value
        finally:
            self._lock.release_write()

    @timed
    def __delitem__(self, key: K) -> None:
        """Delete item by key."""
        self._lock.acquire_write()
        try:
            del self._dict[key]
        finally:
            self._lock.release_write()

    @timed
    def __contains__(self, key: K) -> bool:
        """Check if key exists in dictionary."""
        self._lock.acquire_read()
        try:
            return key in self._dict
        finally:
            self._lock.release_read()

    @timed
    def __len__(self) -> int:
        """Get length of dictionary."""
        self._lock.acquire_read()
        try:
            return len(self._dict)
        finally:
            self._lock.release_read()

    def __bool__(self) -> bool:
        """Check if dictionary is not empty."""
        self._lock.acquire_read()
        try:
            return bool(self._dict)
        finally:
            self._lock.release_read()

    @timed
    def __iter__(self) -> Iterator[K]:
        """Iterate over keys. Returns a snapshot to avoid iteration issues."""
        self._lock.acquire_read()
        try:
            # Return a snapshot of keys to avoid iteration issues
            return iter(list(self._dict.keys()))
        finally:
            self._lock.release_read()

    @timed
    def get(self, key: K, default: V | None = None) -> V:
        """Get item by key with optional default."""
        self._lock.acquire_read()
        try:
            return self._dict.get(key, default)
        finally:
            self._lock.release_read()

    @timed
    def pop(self, key: K, *args) -> V:
        """Pop item by key."""
        self._lock.acquire_write()
        try:
            return self._dict.pop(key, *args)
        finally:
            self._lock.release_write()

    @timed
    def update(self, *args, **kwargs) -> None:
        """Update dictionary."""
        self._lock.acquire_write()
        try:
            self._dict.update(*args, **kwargs)
        finally:
            self._lock.release_write()

    @timed
    def clear(self) -> None:
        """Clear all items."""
        self._lock.acquire_write()
        try:
            self._dict.clear()
        finally:
            self._lock.release_write()

    @timed
    def keys(self) -> KeysView[K]:
        """Get dictionary keys view (snapshot)."""
        self._lock.acquire_read()
        try:
            return list(self._dict.keys())
        finally:
            self._lock.release_read()

    @timed
    def values(self) -> ValuesView[V]:
        """Get dictionary values view (snapshot)."""
        self._lock.acquire_read()
        try:
            return list(self._dict.values())
        finally:
            self._lock.release_read()

    @timed
    def items(self) -> ItemsView[K, V]:
        """Get dictionary items view (snapshot)."""
        self._lock.acquire_read()
        try:
            return list(self._dict.items())
        finally:
            self._lock.release_read()

    @timed
    def copy(self) -> dict[K, V]:
        """Create a copy of the dictionary."""
        self._lock.acquire_read()
        try:
            return self._dict.copy()
        finally:
            self._lock.release_read()

    @timed
    def setdefault(self, key: K, default: V | None = None) -> V:
        """Set default value for key if not exists."""
        self._lock.acquire_write()
        try:
            return self._dict.setdefault(key, default)
        finally:
            self._lock.release_write()

    def __repr__(self) -> str:
        """String representation."""
        self._lock.acquire_read()
        try:
            return f"ThreadSafeDict({self._dict})"
        finally:
            self._lock.release_read()

    def __str__(self) -> str:
        """String representation."""
        self._lock.acquire_read()
        try:
            return str(self._dict)
        finally:
            self._lock.release_read()


class SimpleThreadSafeDict(Generic[K, V]):
    """
    Simple thread-safe dictionary with exclusive locks for all operations.
    Use this if you prefer simplicity over performance.
    """

    def __init__(self, initial_dict: dict[K, V] | None = None):
        self._dict: dict[K, V] = initial_dict.copy() if initial_dict else {}
        self._lock = threading.RLock()

    def __getitem__(self, key: K) -> V:
        with self._lock:
            return self._dict[key]

    def __setitem__(self, key: K, value: V) -> None:
        with self._lock:
            self._dict[key] = value

    def __delitem__(self, key: K) -> None:
        with self._lock:
            del self._dict[key]

    def __contains__(self, key: K) -> bool:
        with self._lock:
            return key in self._dict

    def __len__(self) -> int:
        with self._lock:
            return len(self._dict)

    def __bool__(self) -> bool:
        with self._lock:
            return bool(self._dict)

    def __iter__(self) -> Iterator[K]:
        with self._lock:
            return iter(list(self._dict.keys()))

    def get(self, key: K, default: V | None = None) -> V:
        with self._lock:
            return self._dict.get(key, default)

    def pop(self, key: K, *args) -> V:
        with self._lock:
            return self._dict.pop(key, *args)

    def update(self, *args, **kwargs) -> None:
        with self._lock:
            self._dict.update(*args, **kwargs)

    def clear(self) -> None:
        with self._lock:
            self._dict.clear()

    def keys(self):
        with self._lock:
            return list(self._dict.keys())

    def values(self):
        with self._lock:
            return list(self._dict.values())

    def items(self):
        with self._lock:
            return list(self._dict.items())

    def copy(self) -> dict[K, V]:
        with self._lock:
            return self._dict.copy()

    def setdefault(self, key: K, default: V | None = None) -> V:
        with self._lock:
            return self._dict.setdefault(key, default)
