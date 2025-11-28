import time

from memos.log import get_logger


logger = get_logger(__name__)


def timed(func=None, *, log=True, log_prefix=""):
    """Decorator to measure and optionally log time of retrieval steps.

    Can be used as @timed or @timed(log=True)
    """

    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed = time.perf_counter() - start
            elapsed_ms = elapsed * 1000.0
            if log:
                logger.info(f"[TIMER] {log_prefix or fn.__name__} took {elapsed_ms:.0f} ms")
            return result

        return wrapper

    # Handle both @timed and @timed(log=True) cases
    if func is None:
        return decorator
    return decorator(func)
