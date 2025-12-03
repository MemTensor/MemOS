import json
import os
import socket

from datetime import datetime, timezone
from typing import Any

from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


logger = get_logger(__name__)


def _iso_ts_now() -> str:
    """Return current UTC timestamp in ISO format with milliseconds."""
    return datetime.now(timezone.utc).isoformat()


def to_iso(ts) -> str | None:
    """Convert datetime to ISO string; return None if not convertible."""
    if ts is None:
        return None
    if isinstance(ts, datetime):
        dt = ts
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except Exception:
        return None


def emit_monitor_event(event: str, msg: ScheduleMessageItem, extra: dict[str, Any] | None = None):
    """
    Emit a structured MONITOR_EVENT log line for SLS consumption.

    This must be fire-and-forget: any exception here should never break the scheduler flow.
    """
    try:
        payload: dict[str, Any] = {
            "event": event,
            "ts": _iso_ts_now(),
            "label": getattr(msg, "label", None),
            "user_id": getattr(msg, "user_id", None),
            "mem_cube_id": getattr(msg, "mem_cube_id", None),
            "item_id": getattr(msg, "item_id", None),
            "task_id": getattr(msg, "task_id", "") or "",
            "trace_id": getattr(msg, "trace_id", None),
            "stream_key": getattr(msg, "stream_key", None),
            "redis_message_id": getattr(msg, "redis_message_id", None),
            "monitor_flag": None,
            "host": socket.gethostname(),
            "env": os.getenv("ENV") or os.getenv("ENVIRONMENT") or "",
        }

        info = getattr(msg, "info", None)
        if isinstance(info, dict):
            payload["monitor_flag"] = info.get("monitor_flag")

        if extra:
            payload.update(extra)

        logger.info("MONITOR_EVENT " + json.dumps(payload, ensure_ascii=False))
    except Exception:
        logger.debug("Failed to emit MONITOR_EVENT", exc_info=True)
