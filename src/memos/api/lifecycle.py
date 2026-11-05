from threading import Lock
from typing import Any

from memos.exceptions import MemOSError
from memos.lifecycle import CloseGuard
from memos.log import get_logger


logger = get_logger(__name__)
_guard_lock = Lock()


def shutdown_components(components: dict[str, Any] | None) -> None:
    """Release long-lived API components before the logging system shuts down."""
    if not components:
        return

    with _guard_lock:
        guard = components.setdefault("_close_guard", CloseGuard())
    guard.close(lambda: _close_owned_components(components))


def _close_owned_components(components: dict[str, Any]) -> None:
    """Drain borrowers before the graph; retain failed resources for retry."""
    completed = components.setdefault("_closed_resources", set())
    errors = []

    def release(key: str, resource: Any, method_name: str) -> bool:
        if key in completed:
            return True
        method = getattr(resource, method_name, None)
        try:
            if callable(method):
                method()
            completed.add(key)
            return True
        except Exception as error:
            logger.exception("Failed to close component %s", key)
            errors.append(error)
            return False

    scheduler = components.get("mem_scheduler")
    if callable(getattr(scheduler, "close", None)):
        drained = release("scheduler", scheduler, "close")
    else:
        drained = release("scheduler.stop", scheduler, "stop")
        release("scheduler.rabbitmq", scheduler, "rabbitmq_close")
    if drained:
        release("graph", components.get("graph_db"), "close")
    if errors:
        raise MemOSError("Component shutdown failed; unreleased resources retained") from errors[0]
