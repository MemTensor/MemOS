import logging

from logging.config import dictConfig
from pathlib import Path
from sys import stdout

from dotenv import load_dotenv

from memos import settings
from memos.api.context.context import get_current_trace_id


# Load environment variables
load_dotenv()

selected_log_level = logging.DEBUG if settings.DEBUG else logging.WARNING


def _setup_logfile() -> Path:
    """ensure the logger filepath is in place

    Returns: the logfile Path
    """
    logfile = Path(settings.MEMOS_DIR / "logs" / "memos.log")
    logfile.parent.mkdir(parents=True, exist_ok=True)
    logfile.touch(exist_ok=True)
    return logfile


class TraceIDFilter(logging.Filter):
    """add trace_id to the log record"""

    def filter(self, record):
        try:
            trace_id = get_current_trace_id()
            record.trace_id = trace_id if trace_id else "no-trace-id"
        except Exception:
            record.trace_id = "no-trace-id"
        return True


LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s [%(trace_id)s] - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s - %(message)s"
        },
        "no_datetime": {
            "format": "[%(trace_id)s] - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s - %(message)s"
        },
        "simplified": {
            "format": "%(asctime)s | %(trace_id)s | %(levelname)s | %(filename)s | %(message)s"
        },
    },
    "filters": {
        "package_tree_filter": {"()": "logging.Filter", "name": settings.LOG_FILTER_TREE_PREFIX},
        "trace_id_filter": {"()": "memos.log.TraceIDFilter"},
    },
    "handlers": {
        "console": {
            "level": selected_log_level,
            "class": "logging.StreamHandler",
            "stream": stdout,
            "formatter": "simplified",
            "filters": ["package_tree_filter", "trace_id_filter"],
        },
        "file": {
            "level": "DEBUG",
            "class": "logging.handlers.RotatingFileHandler",
            "filename": _setup_logfile(),
            "maxBytes": 1024**2 * 10,
            "backupCount": 10,
            "formatter": "simplified",
            "filters": ["trace_id_filter"],
        },
        "custom_logger": {
            "level": selected_log_level,
            "class": "memos.log.CustomLoggerRequestHandler",
            "formatter": "simplified",
        },
    },
    "root": {  # Root logger handles all logs
        "level": selected_log_level,
        "handlers": ["console", "file"],
    },
    "loggers": {
        "memos": {
            "level": logging.DEBUG if settings.DEBUG else logging.INFO,
            "propagate": True,  # Let logs bubble up to root
        },
    },
}


def get_logger(name: str | None = None) -> logging.Logger:
    """returns the project logger, scoped to a child name if provided
    Args:
        name: will define a child logger
    """
    dictConfig(LOGGING_CONFIG)

    parent_logger = logging.getLogger("")
    if name:
        return parent_logger.getChild(name)
    return parent_logger
