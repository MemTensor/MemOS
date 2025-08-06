"""
Lock-free dictionary implementation using copy-on-write strategy.
This provides better performance but uses more memory.
"""

import threading

from collections.abc import ItemsView, Iterator, KeysView, ValuesView
from typing import Generic, TypeVar


K = TypeVar("K")
V = TypeVar("V")


class CopyOnWriteDict(Generic[K, V]):
    """
    A lock-free dictionary using copy-on-write strategy.

    Reads are completely lock-free and very fast.
    Writes create a new copy of the dictionary.
    Uses more memory but provides excellent read performance.
    """

    def __init__(self, initial_dict: dict[K, V] | None = None):
        """Initialize with optional initial dictionary."""
        self._dict = initial_dict.copy() if initial_dict else {}
        self._write_lock = threading.Lock()  # Only for writes

    def __getitem__(self, key: K) -> V:
        """Get item by key - completely lock-free."""
        return self._dict[key]

    def __setitem__(self, key: K, value: V) -> None:
        """Set item by key - uses copy-on-write."""
        with self._write_lock:
            # Create a new dictionary with the update
            new_dict = self._dict.copy()
            new_dict[key] = value
            # Atomic replacement
            self._dict = new_dict

    def __delitem__(self, key: K) -> None:
        """Delete item by key - uses copy-on-write."""
        with self._write_lock:
            new_dict = self._dict.copy()
            del new_dict[key]
            self._dict = new_dict

    def __contains__(self, key: K) -> bool:
        """Check if key exists - completely lock-free."""
        return key in self._dict

    def __len__(self) -> int:
        """Get length - completely lock-free."""
        return len(self._dict)

    def __bool__(self) -> bool:
        """Check if not empty - completely lock-free."""
        return bool(self._dict)

    def __iter__(self) -> Iterator[K]:
        """Iterate over keys - completely lock-free."""
        return iter(self._dict.keys())

    def get(self, key: K, default: V | None = None) -> V:
        """Get with default - completely lock-free."""
        return self._dict.get(key, default)

    def keys(self) -> KeysView[K]:
        """Get keys - completely lock-free."""
        return self._dict.keys()

    def values(self) -> ValuesView[V]:
        """Get values - completely lock-free."""
        return self._dict.values()

    def items(self) -> ItemsView[K, V]:
        """Get items - completely lock-free."""
        return self._dict.items()

    def copy(self) -> dict[K, V]:
        """Create a copy - completely lock-free."""
        return self._dict.copy()

    def update(self, *args, **kwargs) -> None:
        """Update dictionary - uses copy-on-write."""
        with self._write_lock:
            new_dict = self._dict.copy()
            new_dict.update(*args, **kwargs)
            self._dict = new_dict

    def clear(self) -> None:
        """Clear all items."""
        with self._write_lock:
            self._dict = {}

    def pop(self, key: K, *args) -> V:
        """Pop item by key."""
        with self._write_lock:
            new_dict = self._dict.copy()
            result = new_dict.pop(key, *args)
            self._dict = new_dict
            return result

    def setdefault(self, key: K, default: V | None = None) -> V:
        """Set default value for key if not exists."""
        # Fast path for existing keys
        if key in self._dict:
            return self._dict[key]

        with self._write_lock:
            # Double-check after acquiring lock
            if key in self._dict:
                return self._dict[key]

            new_dict = self._dict.copy()
            result = new_dict.setdefault(key, default)
            self._dict = new_dict
            return result
