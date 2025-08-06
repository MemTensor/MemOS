import logging
import os

from contextlib import suppress
from logging.config import dictConfig
from pathlib import Path
from sys import stdout

import requests

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


class CustomLoggerRequestHandler(logging.Handler):
    def emit(self, record):
        if os.getenv("CUSTOM_LOGGER_URL") is None:
            return

        if record.levelno == logging.INFO or record.levelno == logging.ERROR:
            with suppress(Exception):
                log_custom_request(record.getMessage())


LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s - %(message)s"
        },
        "no_datetime": {
            "format": "%(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(funcName)s - %(message)s"
        },
    },
    "filters": {
        "package_tree_filter": {"()": "logging.Filter", "name": settings.LOG_FILTER_TREE_PREFIX}
    },
    "handlers": {
        "console": {
            "level": selected_log_level,
            "class": "logging.StreamHandler",
            "stream": stdout,
            "formatter": "no_datetime",
            "filters": ["package_tree_filter"],
        },
        "file": {
            "level": "DEBUG",
            "class": "logging.handlers.RotatingFileHandler",
            "filename": _setup_logfile(),
            "maxBytes": 1024**2 * 10,
            "backupCount": 10,
            "formatter": "standard",
        },
        "customRequest": {
            "level": "INFO",
            "class": "memos.log.CustomLoggerRequestHandler",
        },
    },
    "root": {  # Root logger handles all logs
        "level": logging.DEBUG if settings.DEBUG else logging.INFO,
        "handlers": ["console", "file", "customRequest"],
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


def log_custom_request(message: str):
    logger_url = os.getenv("CUSTOM_LOGGER_URL")
    token = os.getenv("CUSTOM_LOGGER_TOKEN")

    trace_id = get_current_trace_id()

    headers = {
        "Content-Type": "application/json",
    }
    post_content = {
        "message": message,
    }

    for key, value in os.environ.items():
        if key.startswith("CUSTOM_LOGGER_ATTRIBUTE_"):
            attribute_key = key[len("CUSTOM_LOGGER_ATTRIBUTE_") :].lower()
            post_content[attribute_key] = value

    if token is not None:
        headers["Authorization"] = token

    if trace_id is not None:
        headers["traceId"] = trace_id
        post_content["trace_id"] = trace_id

    requests.post(url=logger_url, headers=headers, json=post_content, timeout=5)
