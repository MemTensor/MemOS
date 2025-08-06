import logging

from logging.config import dictConfig
from pathlib import Path
from sys import stdout

from dotenv import load_dotenv

from memos import settings


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
