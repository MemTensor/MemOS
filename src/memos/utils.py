import time

from memos.log import get_logger


logger = get_logger(__name__)


def timed_with_status(func=None, *, log=True, log_prefix="", log_args=None, log_extra_args=None):
    """
    Parameters:
    - log: enable timing logs (default True)
    - log_prefix: prefix; falls back to function name
    - log_args: names to include in logs (str or list/tuple of str).
    - log_extra_args: extra arguments to include in logs (dict).
    """

    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            ctx_str = ""
            ctx_parts = []

            if log is not True:
                return result

            if log_args:
                for key in log_args:
                    val = kwargs.get(key)
                    ctx_parts.append(f"{key}={val}")
                    ctx_str = f" [{', '.join(ctx_parts)}]"

            if log_extra_args:
                ctx_parts.extend([f"{key}={val}" for key, val in log_extra_args.items()])

            if ctx_parts:
                ctx_str = f" [{', '.join(ctx_parts)}]"

            logger.info(
                f"[TIMER] {log_prefix or fn.__name__} took {elapsed_ms:.0f} ms, args: {ctx_str}"
            )

            return result

        return wrapper

    if func is None:
        return decorator
    return decorator(func)


def timed(func=None, *, log=True):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed_ms = (time.perf_counter() - start) * 1000.0

            if log is not True:
                return result

            logger.info(f"[TIMER] {fn.__name__} took {elapsed_ms:.0f} ms")

            return result

        return wrapper

    # Handle both @timed and @timed(log=True) cases
    if func is None:
        return decorator
    return decorator(func)
