import time

from memos.log import get_logger


logger = get_logger(__name__)


def timed(func=None, *, log=True, log_prefix="", log_args=None):
    """
    Parameters:
    - log: enable timing logs (default True)
    - log_prefix: prefix; falls back to function name
    - log_args: names to include in logs (str or list/tuple of str).
      Value priority: kwargs → args[0].config.<name> (if available).
      Non-string items are ignored.

    Examples:
    - @timed(log=True, log_prefix="OpenAI LLM", log_args=["model_name_or_path", "temperature"])
    - @timed(log=True, log_prefix="OpenAI LLM", log_args=["temperature"])
    - @timed()  # defaults
    """

    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            ctx_str = ""

            if log is not True:
                return result

            if log_args:
                ctx_parts = []
                for key in log_args:
                    val = kwargs.get(key)
                    ctx_parts.append(f"{key}={val}")
                    ctx_str = f" [{', '.join(ctx_parts)}]"
                logger.info(
                    f"[TIMER] {log_prefix or fn.__name__} took {elapsed_ms:.0f} ms, args: {ctx_str}"
                )

            return result

        return wrapper

    # Handle both @timed and @timed(log=True) cases
    if func is None:
        return decorator
    return decorator(func)
