import logging
import os

from logging.config import dictConfig
from pathlib import Path
from sys import stdout
import requests

from memos import settings
from dotenv import load_dotenv

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


class OpenTelemetryHandler(logging.Handler):    
    def emit(self, record):
      if record.levelno == logging.INFO or record.levelno == logging.ERROR: 
        log_opentelemetry(record.getMessage())


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
            "backupCount": 3,
            "formatter": "standard",
        },
        "opentelemetry": {
            "level": "INFO",
            "class": "memos.log.OpenTelemetryHandler",
        },
    },
    "root": {  # Root logger handles all logs
        "level": logging.DEBUG if settings.DEBUG else logging.INFO,
        "handlers": ["console", "file", "opentelemetry"],
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


def log_opentelemetry(message: str):
    if (os.getenv("LOGGER_URL") is None):
      return
    
    trace_id = requests.headers.get("traceId")
    
    headers = {
      "Content-Type": "application/json",
      "Authorization": f"Bearer {os.getenv('LOGGER_TOKEN')}"
    }

    post_content = {
      "trace_id": trace_id,
      "action": "memos",
      "message": message,
    }

    logger_url = os.getenv("LOGGER_URL")

    requests.post(
      url=logger_url,
      headers=headers,
      json=post_content,
      timeout=5
    )
