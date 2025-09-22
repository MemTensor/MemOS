import threading
import time

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Generic, TypeVar


K = TypeVar("K")
V = TypeVar("V")


class FastReadWriteLock:
    """Read-write lock optimized for FastAPI scenarios:
    reader priority with writer starvation prevention"""

    def __init__(self):
        self._readers = 0
        self._writers = 0
        self._waiting_writers = 0
        self._lock = threading.RLock()
        self._read_ready = threading.Condition(self._lock)
        self._write_ready = threading.Condition(self._lock)
        # Writer starvation detection
        self._last_write_time = 0
        self._write_starvation_threshold = 0.1  # 100ms

    def acquire_read(self) -> bool:
        """Fast read lock acquisition"""
        with self._lock:
            # Check if writers are starving
            current_time = time.time()
            write_starving = (
                self._waiting_writers > 0
                and current_time - self._last_write_time > self._write_starvation_threshold
            )

            # If no writers are active and no starvation, allow readers to continue
            if self._writers == 0 and not write_starving:
                self._readers += 1
                return True

            # Otherwise wait
            while self._writers > 0 or write_starving:
                self._read_ready.wait()
                current_time = time.time()
                write_starving = (
                    self._waiting_writers > 0
                    and current_time - self._last_write_time > self._write_starvation_threshold
                )

            self._readers += 1
            return True

    def release_read(self):
        """Release read lock"""
        with self._lock:
            self._readers -= 1
            if self._readers == 0:
                self._write_ready.notify()

    def acquire_write(self) -> bool:
        """Write lock acquisition"""
        with self._lock:
            self._waiting_writers += 1
            try:
                while self._readers > 0 or self._writers > 0:
                    self._write_ready.wait()

                self._writers = 1
                self._waiting_writers -= 1
                self._last_write_time = time.time()
                return True
            except:
                self._waiting_writers -= 1
                raise

    def release_write(self):
        """Release write lock"""
        with self._lock:
            self._writers = 0
            # Prioritize notifying readers (reader priority strategy)
            self._read_ready.notify_all()
            self._write_ready.notify()


class SegmentedLock:
    """Segmented lock, segments based on key hash"""

    def __init__(self, segment_count: int = 64):
        self.segment_count = segment_count
        self.locks = [FastReadWriteLock() for _ in range(segment_count)]

    def get_lock(self, key: K) -> FastReadWriteLock:
        """Get the corresponding lock based on key"""
        segment = hash(key) % self.segment_count
        return self.locks[segment]

    @contextmanager
    def read_lock(self, key: K):
        """Read lock context manager"""
        lock = self.get_lock(key)
        lock.acquire_read()
        try:
            yield
        finally:
            lock.release_read()

    @contextmanager
    def write_lock(self, key: K):
        """Write lock context manager"""
        lock = self.get_lock(key)
        lock.acquire_write()
        try:
            yield
        finally:
            lock.release_write()


class OptimizedThreadSafeDict(Generic[K, V]):
    """
    Thread-safe dictionary optimized for FastAPI scenarios:
    - Segmented locks to reduce contention
    - Reader priority with writer starvation prevention
    - Support for large object storage
    - Strong consistency guarantee
    """

    def __init__(
        self, initial_dict: dict[K, V] | None = None, segment_count: int = 128
    ):  # More segments for high concurrency
        self._segments: list[dict[K, V]] = [{} for _ in range(segment_count)]
        self._segment_count = segment_count
        self._segmented_lock = SegmentedLock(segment_count)

        # Initialize data
        if initial_dict:
            for k, v in initial_dict.items():
                segment_idx = self._get_segment(k)
                self._segments[segment_idx][k] = v

    def _get_segment(self, key: K) -> int:
        """Calculate the segment corresponding to the key"""
        return hash(key) % self._segment_count

    def __getitem__(self, key: K) -> V:
        """Get element"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.read_lock(key):
            return self._segments[segment_idx][key]

    def __setitem__(self, key: K, value: V) -> None:
        """Set element - key optimization point"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.write_lock(key):
            self._segments[segment_idx][key] = value

    def __delitem__(self, key: K) -> None:
        """Delete element"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.write_lock(key):
            del self._segments[segment_idx][key]

    def __contains__(self, key: K) -> bool:
        """Check if key is contained"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.read_lock(key):
            return key in self._segments[segment_idx]

    def get(self, key: K, default: V | None = None) -> V | None:
        """Safely get element"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.read_lock(key):
            return self._segments[segment_idx].get(key, default)

    def pop(self, key: K, *args) -> V:
        """Pop element"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.write_lock(key):
            return self._segments[segment_idx].pop(key, *args)

    def setdefault(self, key: K, default: V | None = None) -> V:
        """Set default value"""
        segment_idx = self._get_segment(key)
        with self._segmented_lock.write_lock(key):
            return self._segments[segment_idx].setdefault(key, default)

    def update(self, other=None, **kwargs) -> None:
        """Batch update - optimized batch operation"""
        items = (other.items() if hasattr(other, "items") else other) if other is not None else []

        # Group update items by segment
        segment_updates: dict[int, list[tuple[K, V]]] = {}

        for k, v in items:
            segment_idx = self._get_segment(k)
            if segment_idx not in segment_updates:
                segment_updates[segment_idx] = []
            segment_updates[segment_idx].append((k, v))

        for k, v in kwargs.items():
            segment_idx = self._get_segment(k)
            if segment_idx not in segment_updates:
                segment_updates[segment_idx] = []
            segment_updates[segment_idx].append((k, v))

        # Update segment by segment to reduce lock holding time
        for segment_idx, updates in segment_updates.items():
            # Use the first key to get the lock (all keys in the same segment map to the same lock)
            first_key = updates[0][0]
            with self._segmented_lock.write_lock(first_key):
                for k, v in updates:
                    self._segments[segment_idx][k] = v

    def clear(self) -> None:
        """Clear all elements - need to acquire all locks"""
        # Acquire all locks in order to avoid deadlock
        acquired_locks = []
        try:
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_write()
                acquired_locks.append(lock)

            # Clear all segments
            for segment in self._segments:
                segment.clear()

        finally:
            # Release locks in reverse order
            for lock in reversed(acquired_locks):
                lock.release_write()

    def __len__(self) -> int:
        """Get total length - snapshot read"""
        total = 0
        acquired_locks = []
        try:
            # Acquire all read locks
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_read()
                acquired_locks.append(lock)

            # Calculate total length
            for segment in self._segments:
                total += len(segment)

            return total

        finally:
            # Release all read locks
            for lock in reversed(acquired_locks):
                lock.release_read()

    def __bool__(self) -> bool:
        """Check if empty"""
        return len(self) > 0

    def keys(self) -> list[K]:
        """Get snapshot of all keys"""
        all_keys = []
        acquired_locks = []

        try:
            # Acquire all read locks
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_read()
                acquired_locks.append(lock)

            # Collect all keys
            for segment in self._segments:
                all_keys.extend(segment.keys())

            return all_keys

        finally:
            for lock in reversed(acquired_locks):
                lock.release_read()

    def values(self) -> list[V]:
        """Get snapshot of all values"""
        all_values = []
        acquired_locks = []

        try:
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_read()
                acquired_locks.append(lock)

            for segment in self._segments:
                all_values.extend(segment.values())

            return all_values

        finally:
            for lock in reversed(acquired_locks):
                lock.release_read()

    def items(self) -> list[tuple[K, V]]:
        """Get snapshot of all items"""
        all_items = []
        acquired_locks = []

        try:
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_read()
                acquired_locks.append(lock)

            for segment in self._segments:
                all_items.extend(segment.items())

            return all_items

        finally:
            for lock in reversed(acquired_locks):
                lock.release_read()

    def copy(self) -> dict[K, V]:
        """Create dictionary copy"""
        result = {}
        acquired_locks = []

        try:
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_read()
                acquired_locks.append(lock)

            for segment in self._segments:
                result.update(segment)

            return result

        finally:
            for lock in reversed(acquired_locks):
                lock.release_read()

    def __iter__(self) -> Iterator[K]:
        """Iterator - returns snapshot"""
        return iter(self.keys())

    def __repr__(self) -> str:
        """String representation"""
        return f"OptimizedThreadSafeDict({dict(self.items())})"

    def stats(self) -> dict[str, Any]:
        """Get statistics"""
        segment_sizes = []
        total_items = 0

        acquired_locks = []
        try:
            for i in range(self._segment_count):
                lock = self._segmented_lock.locks[i]
                lock.acquire_read()
                acquired_locks.append(lock)

            for segment in self._segments:
                size = len(segment)
                segment_sizes.append(size)
                total_items += size

            avg_size = total_items / self._segment_count if self._segment_count > 0 else 0
            max_size = max(segment_sizes) if segment_sizes else 0
            min_size = min(segment_sizes) if segment_sizes else 0

            return {
                "total_items": total_items,
                "segment_count": self._segment_count,
                "avg_segment_size": avg_size,
                "max_segment_size": max_size,
                "min_segment_size": min_size,
                "load_balance_ratio": min_size / max_size if max_size > 0 else 1.0,
            }

        finally:
            for lock in reversed(acquired_locks):
                lock.release_read()
