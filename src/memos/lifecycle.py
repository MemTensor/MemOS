"""Share the result of a terminal close attempt; resource owners handle draining."""

from collections.abc import Callable
from dataclasses import dataclass, field
from threading import Event, Lock, get_ident

from memos.exceptions import MemOSError


@dataclass
class _CloseAttempt:
    owner: int
    done: Event = field(default_factory=Event)
    error: BaseException | None = None


class CloseState:
    """Keep concurrent close callers on one attempt without tracking operations."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.closing = Event()
        self._closed = False
        self._attempt: _CloseAttempt | None = None

    def ensure_open(self) -> None:
        """Reject new work once final close has started, including after failure."""
        if self.closing.is_set():
            raise MemOSError("Component is closing or closed")

    def close(self, cleanup: Callable[[], None]) -> None:
        """Run cleanup once per attempt; retry only after a completed failure."""
        with self._lock:
            if self._closed:
                return
            attempt = self._attempt
            execute = attempt is None or attempt.done.is_set()
            if execute:
                self.closing.set()
                attempt = self._attempt = _CloseAttempt(get_ident())
            elif attempt.owner == get_ident():
                raise MemOSError("A close callback cannot close its own owner")
        if not execute:
            attempt.done.wait()
            if attempt.error is not None:
                raise attempt.error
            return
        try:
            cleanup()
        except BaseException as error:
            attempt.error = error
            raise
        else:
            with self._lock:
                self._closed = True
        finally:
            attempt.done.set()
