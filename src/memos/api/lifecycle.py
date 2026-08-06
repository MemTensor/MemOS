from collections.abc import Mapping
from typing import Any

from memos.log import get_logger


logger = get_logger(__name__)


def shutdown_components(components: Mapping[str, Any] | None) -> None:
    """Release long-lived API components before the logging system shuts down."""
    if not components:
        return

    mem_scheduler = components.get("mem_scheduler")
    if mem_scheduler is None:
        return

    for method_name in ("stop", "rabbitmq_close"):
        method = getattr(mem_scheduler, method_name, None)
        if not callable(method):
            continue
        try:
            method()
        except Exception:
            logger.exception("Failed to run mem_scheduler.%s during API shutdown", method_name)
