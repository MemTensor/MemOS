import atexit
import hashlib
import logging
import os
import threading
import time

from collections import Counter
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from logging.config import dictConfig
from pathlib import Path
from sys import stdout
from typing import Any

import requests

from dotenv import load_dotenv

from memos import settings
from memos.context.context import (
    get_current_api_path,
    get_current_env,
    get_current_trace_id,
    get_current_user_name,
    get_current_user_type,
)


# Load environment variables
load_dotenv()

selected_log_level = logging.DEBUG if settings.DEBUG else logging.WARNING
_LOGGING_CONFIG_LOCK = threading.RLock()
_LOGGING_CONFIGURED_PID: int | None = None


def text_hash(texts: str | Sequence[str]) -> str:
    """Return a stable short hash without retaining the source text."""
    normalized_texts = [texts] if isinstance(texts, str) else texts
    digest = hashlib.sha256()
    for text in normalized_texts:
        encoded = str(text or "").encode("utf-8", errors="replace")
        digest.update(len(encoded).to_bytes(8, byteorder="big"))
        digest.update(encoded)
    return digest.hexdigest()[:16]


def summarize_search_request(request: Any) -> dict[str, Any]:
    """Summarize search controls without logging query or user content."""
    query = str(getattr(request, "query", "") or "")
    mode = getattr(request, "mode", None)
    readable_cube_ids = getattr(request, "readable_cube_ids", None) or []
    views = getattr(request, "include_memory_view", None) or []
    return {
        "query_chars": len(query),
        "query_hash": text_hash(query),
        "mode": getattr(mode, "value", mode),
        "readable_cube_count": len(readable_cube_ids),
        "views": list(views),
        "top_k": getattr(request, "memory_limit_number", None),
        "dedup": getattr(request, "dedup", None),
        "rerank": getattr(request, "rerank", None),
    }


def summarize_search_results(results: Mapping[str, Any]) -> dict[str, Any]:
    """Count result buckets and items without serializing result payloads."""
    bucket_counts: dict[str, int] = {}
    item_counts: dict[str, int] = {}
    for key, value in results.items():
        if not isinstance(value, list):
            continue
        bucket_counts[key] = len(value)
        item_counts[key] = sum(
            len(bucket.get("memories") or [])
            if isinstance(bucket, Mapping) and isinstance(bucket.get("memories"), list)
            else 1
            for bucket in value
        )
    return {
        "bucket_counts": bucket_counts,
        "item_counts": item_counts,
        "total_items": sum(item_counts.values()),
    }


def summarize_textual_memories(memories: Sequence[Any]) -> dict[str, Any]:
    """Count textual memories by type without reading their content or metadata values."""
    type_counts: Counter[str] = Counter()
    for item in memories:
        metadata = (
            item.get("metadata") if isinstance(item, Mapping) else getattr(item, "metadata", None)
        )
        if isinstance(metadata, Mapping):
            memory_type = metadata.get("memory_type")
        else:
            memory_type = getattr(metadata, "memory_type", None)
        type_counts[str(memory_type or "unknown")] += 1
    return {
        "total_items": len(memories),
        "type_counts": dict(type_counts),
    }


def _setup_logfile() -> Path:
    """ensure the logger filepath is in place

    Returns: the logfile Path
    """
    logfile = Path(settings.MEMOS_DIR / "logs" / "memos.log")
    logfile.parent.mkdir(parents=True, exist_ok=True)
    logfile.touch(exist_ok=True)

    return logfile


class ContextFilter(logging.Filter):
    """add context to the log record"""

    def filter(self, record):
        try:
            trace_id = get_current_trace_id()
            record.trace_id = trace_id if trace_id else "trace-id"
            record.env = get_current_env()
            record.user_type = get_current_user_type()
            record.user_name = get_current_user_name()
            record.api_path = get_current_api_path()
        except Exception:
            record.api_path = "unknown"
            record.trace_id = "trace-id"
            record.env = "prod"
            record.user_type = "normal"
            record.user_name = "unknown"
        return True


class CustomLoggerRequestHandler(logging.Handler):
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
                    cls._instance._executor = None
                    cls._instance._session = None
                    cls._instance._is_shutting_down = None
        return cls._instance

    def __init__(self):
        """Initialize handler with minimal setup"""
        if not self._initialized:
            super().__init__()
            workers = int(os.getenv("CUSTOM_LOGGER_WORKERS", "2"))
            self._executor = ThreadPoolExecutor(
                max_workers=workers, thread_name_prefix="log_sender"
            )
            self._is_shutting_down = threading.Event()
            self._session = requests.Session()
            self._initialized = True
            atexit.register(self._cleanup)

    def emit(self, record):
        """Process log records of INFO or ERROR level (non-blocking)"""
        if os.getenv("CUSTOM_LOGGER_URL") is None or self._is_shutting_down.is_set():
            return

        # Only process INFO and ERROR level logs
        if record.levelno < logging.INFO:  # Skip DEBUG and lower
            return

        try:
            trace_id = get_current_trace_id() or "trace-id"
            api_path = get_current_api_path()
            env = get_current_env()
            user_type = get_current_user_type()
            user_name = get_current_user_name()
            if api_path is not None:
                self._executor.submit(
                    self._send_log_sync,
                    record.getMessage(),
                    trace_id,
                    api_path,
                    env,
                    user_type,
                    user_name,
                )
        except Exception as e:
            if not self._is_shutting_down.is_set():
                print(f"Error sending log: {e}")

    def _send_log_sync(self, message, trace_id, api_path, env, user_type, user_name):
        """Send log message synchronously in a separate thread"""
        try:
            logger_url = os.getenv("CUSTOM_LOGGER_URL")
            token = os.getenv("CUSTOM_LOGGER_TOKEN")

            headers = {"Content-Type": "application/json"}
            post_content = {
                "message": message,
                "trace_id": trace_id,
                "action": api_path,
                "current_time": round(time.time(), 3),
                "env": env,
                "user_type": user_type,
                "user_name": user_name,
            }

            # Add auth token if exists
            if token:
                headers["Authorization"] = f"Bearer {token}"

            # Add traceId to headers for consistency
            headers["traceId"] = trace_id

            # Add custom attributes from env
            for key, value in os.environ.items():
                if key.startswith("CUSTOM_LOGGER_ATTRIBUTE_"):
                    attribute_key = key[len("CUSTOM_LOGGER_ATTRIBUTE_") :].lower()
                    post_content[attribute_key] = value

            self._session.post(logger_url, headers=headers, json=post_content, timeout=5)
        except Exception:
            # Silently ignore errors to avoid affecting main application
            pass

    def _cleanup(self):
        """Clean up resources during program exit"""
        if not self._initialized:
            return

        self._is_shutting_down.set()
        try:
            self._executor.shutdown(wait=False)
            self._session.close()
        except Exception as e:
            print(f"Error during cleanup: {e}")

    def close(self):
        """Override close to prevent premature shutdown"""


LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s | %(trace_id)s | path=%(api_path)s | env=%(env)s | user_type=%(user_type)s | user_name=%(user_name)s | %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s - %(message)s"
        },
        "no_datetime": {
            "format": "%(trace_id)s | path=%(api_path)s | %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s - %(message)s"
        },
        "simplified": {
            "format": "%(asctime)s | %(trace_id)s | path=%(api_path)s | % %(levelname)s | %(filename)s:%(lineno)d: %(funcName)s | %(message)s"
        },
    },
    "filters": {
        "package_tree_filter": {"()": "logging.Filter", "name": settings.LOG_FILTER_TREE_PREFIX},
        "context_filter": {"()": "memos.log.ContextFilter"},
    },
    "handlers": {
        "console": {
            "level": selected_log_level,
            "class": "logging.StreamHandler",
            "stream": stdout,
            "formatter": "no_datetime",
            "filters": ["package_tree_filter", "context_filter"],
        },
        "file": {
            "level": "INFO",
            "class": "concurrent_log_handler.ConcurrentTimedRotatingFileHandler",
            "when": "midnight",
            "interval": 1,
            "backupCount": 3,
            "filename": _setup_logfile(),
            "formatter": "standard",
            "filters": ["context_filter"],
        },
        "custom_logger": {
            "level": "INFO",
            "class": "memos.log.CustomLoggerRequestHandler",
            "formatter": "simplified",
        },
    },
    "root": {  # Root logger handles all logs
        "level": logging.DEBUG if settings.DEBUG else logging.INFO,
        "handlers": ["console", "file"],
    },
    "loggers": {
        "memos": {
            "level": logging.DEBUG if settings.DEBUG else logging.INFO,
            "propagate": True,  # Let logs bubble up to root
        },
    },
}


def _get_current_pid() -> int:
    return os.getpid()


def configure_logging(force: bool = False) -> None:
    """Configure process-local logging once.

    Re-running dictConfig replaces and closes existing handlers. Guarding it avoids races with
    background threads that may be emitting log records while other modules import loggers.
    """
    global _LOGGING_CONFIGURED_PID

    with _LOGGING_CONFIG_LOCK:
        current_pid = _get_current_pid()
        if force or current_pid != _LOGGING_CONFIGURED_PID:
            dictConfig(LOGGING_CONFIG)
            _LOGGING_CONFIGURED_PID = current_pid


def get_logger(name: str | None = None) -> logging.Logger:
    """returns the project logger, scoped to a child name if provided
    Args:
        name: will define a child logger
    """
    configure_logging()

    parent_logger = logging.getLogger("")
    if name:
        return parent_logger.getChild(name)
    return parent_logger
