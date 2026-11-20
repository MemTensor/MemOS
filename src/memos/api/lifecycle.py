from collections.abc import Mapping
from typing import Any

from memos.exceptions import MemOSError
from memos.log import get_logger


logger = get_logger(__name__)


def shutdown_components(components: Mapping[str, Any] | None) -> None:
    """Drain borrowers before the graph; each resource owns its close state."""
    if not components:
        return

    errors = []

    def release(key: str, resource: Any, method_name: str) -> bool:
        method = getattr(resource, method_name, None)
        try:
            if callable(method):
                method()
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
        rabbitmq_drained = release("scheduler.rabbitmq", scheduler, "rabbitmq_close")
        drained = drained and rabbitmq_drained
    if drained:
        release("graph", components.get("graph_db"), "close")
    if errors:
        raise MemOSError("Component shutdown failed; unreleased resources retained") from errors[0]
