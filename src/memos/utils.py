import functools
import time

from memos.log import get_logger


logger = get_logger(__name__)

# Global threshold (seconds) for timing logs
DEFAULT_TIME_BAR = 10.0


def timed_with_status(
    func=None,
    *,
    log_prefix="",
    log_args=None,
    log_extra_args=None,
    fallback=None,
):
    """
    Parameters:
    - log: enable timing logs (default True)
    - log_prefix: prefix; falls back to function name
    - log_args: names to include in logs (str or list/tuple of str), values are taken from kwargs by name.
    - log_extra_args:
        - can be a dict: fixed contextual fields that are always attached to logs;
        - or a callable: like `fn(*args, **kwargs) -> dict`, used to dynamically generate contextual fields at runtime.
    """

    if isinstance(log_args, str):
        effective_log_args = [log_args]
    else:
        effective_log_args = list(log_args) if log_args else []

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            exc_type = None
            result = None
            success_flag = False

            try:
                result = fn(*args, **kwargs)
                success_flag = True
                return result
            except Exception as e:
                exc_type = type(e)
                success_flag = False

                if fallback is not None and callable(fallback):
                    result = fallback(e, *args, **kwargs)
                    return result
            finally:
                elapsed_ms = (time.perf_counter() - start) * 1000.0

                ctx_parts = []
                # 1) Collect parameters from kwargs by name
                for key in effective_log_args:
                    val = kwargs.get(key)
                    ctx_parts.append(f"{key}={val}")

                # 2) Support log_extra_args as dict or callable, so we can dynamically
                #    extract values from self or other runtime context
                extra_items = {}
                try:
                    if callable(log_extra_args):
                        extra_items = log_extra_args(*args, **kwargs) or {}
                    elif isinstance(log_extra_args, dict):
                        extra_items = log_extra_args
                except Exception as e:
                    logger.warning(f"[TIMER_WITH_STATUS] log_extra_args callback error: {e!r}")

                if extra_items:
                    ctx_parts.extend(f"{key}={val}" for key, val in extra_items.items())

                ctx_str = f" [{', '.join(ctx_parts)}]" if ctx_parts else ""

                status = "SUCCESS" if success_flag else "FAILED"
                status_info = f", status: {status}"

                if not success_flag and exc_type is not None:
                    status_info += f", error: {exc_type.__name__}"

                msg = (
                    f"[TIMER_WITH_STATUS] {log_prefix or fn.__name__} "
                    f"took {elapsed_ms:.0f} ms{status_info}, args: {ctx_str}"
                )

                logger.info(msg)

        return wrapper

    if func is None:
        return decorator
    return decorator(func)


def timed(func=None, *, log=False, log_prefix=""):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed_ms = (time.perf_counter() - start) * 1000.0

            if log is not True:
                return result

            if elapsed_ms >= (DEFAULT_TIME_BAR * 1000.0):
                logger.info(f"[TIMER] {log_prefix or fn.__name__} took {elapsed_ms:.0f} ms")

            return result

        return wrapper

    # Handle both @timed and @timed(log=True) cases
    if func is None:
        return decorator
    return decorator(func)
