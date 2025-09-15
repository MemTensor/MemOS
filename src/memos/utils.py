import time

from memos import settings
from memos.log import get_logger


logger = get_logger(__name__)


def timed(func):
    """Decorator to measure and log time of retrieval steps."""

    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = time.perf_counter() - start
        if settings.DEBUG:
            logger.info(f"[TIMER] {func.__name__} took {elapsed:.2f} s")
        return result

    return wrapper
