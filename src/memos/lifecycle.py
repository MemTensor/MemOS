"""Synchronization for terminal, retryable component cleanup."""

from collections.abc import Callable, Iterator
from concurrent.futures import Future
from contextlib import contextmanager
from threading import Condition, RLock

from memos.exceptions import MemOSError


class CloseGuard:
    """Share a close attempt without hiding failures or reopening the owner.

    Resource ownership and cleanup order remain with the component. The guard
    only coordinates entry, in-flight operations and concurrent close callers.
    """

    def __init__(self) -> None:
        self.condition = Condition(RLock())
        self.started = False
        self._closed = False
        self._attempt: Future | None = None
        self._active = 0

    def ensure_open(self) -> None:
        """Reject new work once final close has started, including after failure."""
        with self.condition:
            if self.started:
                raise MemOSError("Component is closing or closed")

    @contextmanager
    def operation(self) -> Iterator[None]:
        """Register work which must finish before owned resources are released."""
        with self.condition:
            self.ensure_open()
            self._active += 1
        try:
            yield
        finally:
            with self.condition:
                self._active -= 1
                self.condition.notify_all()

    def wait_for_operations(self) -> None:
        """Wait without holding a lock needed to publish or finish an operation."""
        with self.condition:
            self.condition.wait_for(lambda: self._active == 0)

    def close(self, cleanup: Callable[[], None]) -> None:
        """Run cleanup once per attempt; retry only after a completed failure."""
        with self.condition:
            if self._closed:
                return
            attempt = self._attempt
            execute = attempt is None or attempt.done()
            if execute:
                self.started = True
                attempt = self._attempt = Future()
                self.condition.notify_all()
        if not execute:
            attempt.result()
            return
        try:
            cleanup()
        except BaseException as error:
            attempt.set_exception(error)
            raise
        else:
            with self.condition:
                self._closed = True
                attempt.set_result(None)
