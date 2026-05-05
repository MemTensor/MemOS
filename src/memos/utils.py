import functools
import time
import traceback

from contextlib import ContextDecorator
from typing import Any

from memos.log import get_logger


logger = get_logger(__name__)


class timed_stage(ContextDecorator):  # noqa: N801
    """Unified timing helper for business-stage instrumentation.

    Works as **both** a context-manager and a decorator - one tool for all
    timing needs.

    Context-manager (when the stage is a *code block* inside a function)::

        with timed_stage("add", "parse", cube_id=cube_id) as ts:
            items = self._parse(...)
            ts.set(msg_count=10, window_count=len(windows))

    Decorator (when the stage is *an entire function*)::

        @timed_stage("add", "write_db")
        def _write_to_db(self, ...):
            ...

    Decorator with dynamic fields extracted from arguments::

        @timed_stage("search", "recall",
                     extra=lambda self, req, **kw: {"cube_id": self.cube_id})
        def _vector_recall(self, req, ...):
            ...

    Output format (SLS-friendly, one-line structured log)::

        [STAGE] biz=add stage=parse cube_id=xxx duration_ms=150 msg_count=10
    """

    def __init__(
        self,
        biz: str = "",
        stage: str = "",
        *,
        extra: dict[str, Any] | None = None,
        level: str = "info",
        **fields: Any,
    ):
        self._biz = biz
        self._stage = stage
        self._extra_factory = extra if callable(extra) else None
        self._static_extra = extra if isinstance(extra, dict) else None
        self._level = level
        self._fields: dict[str, Any] = dict(fields)
        self._start: float = 0.0
        self.duration_ms: int = 0

    # -- context-manager protocol ------------------------------------------

    def __enter__(self):
        self._start = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.duration_ms = int((time.perf_counter() - self._start) * 1000)
        self._emit(self.duration_ms, exc_type)
        return False

    # -- decorator protocol (extends ContextDecorator) ---------------------

    def __call__(self, func=None):
        if func is None:
            return super().__call__(func)

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if self._extra_factory is not None:
                try:
                    dynamic = self._extra_factory(*args, **kwargs)
                    if dynamic:
                        self._fields.update(dynamic)
                except Exception as e:
                    logger.warning("[STAGE] extra callback error: %r", e)

            stage_name = self._stage or func.__name__
            self._stage = stage_name
            self._start = time.perf_counter()
            try:
                return func(*args, **kwargs)
            finally:
                self.duration_ms = int((time.perf_counter() - self._start) * 1000)
                self._emit(self.duration_ms)

        return wrapper

    # -- public API --------------------------------------------------------

    def set(self, **fields: Any):
        """Add / overwrite fields after execution (e.g. counts only known after the block runs)."""
        self._fields.update(fields)

    @staticmethod
    def emit_now(biz: str, stage: str, **fields: Any):
        """Fire a one-shot structured log without timing (e.g. summary rollups)."""
        parts = [f"biz={biz}", f"stage={stage}"]
        for k, v in fields.items():
            parts.append(f"{k}={v}")
        logger.info("[STAGE] " + " ".join(parts))

    # -- internals ---------------------------------------------------------

    def _emit(self, duration_ms: int, exc_type=None):
        parts: list[str] = []
        if self._biz:
            parts.append(f"biz={self._biz}")
        if self._stage:
            parts.append(f"stage={self._stage}")
        parts.append(f"duration_ms={duration_ms}")

        if self._static_extra:
            self._fields.update(self._static_extra)

        for k, v in self._fields.items():
            parts.append(f"{k}={v}")

        if exc_type is not None:
            parts.append(f"error={exc_type.__name__}")

        msg = "[STAGE] " + " ".join(parts)
        getattr(logger, self._level, logger.info)(msg)


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
            exc_message = None
            result = None
            success_flag = False

            try:
                result = fn(*args, **kwargs)
                success_flag = True
                return result
            except Exception as e:
                exc_type = type(e)
                stack_info = "".join(traceback.format_stack()[:-1])
                exc_message = f"{stack_info}{traceback.format_exc()}"
                success_flag = False

                if fallback is not None and callable(fallback):
                    result = fallback(e, *args, **kwargs)
                    return result
                # No fallback configured -> re-raise so callers see the failure
                # instead of receiving an implicit None. Otherwise downstream
                # parsers (e.g. clean_json_response) crash with confusing
                # AttributeErrors that hide the real LLM/HTTP error.
                raise
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
                    status_info += (
                        f", error_type: {exc_type.__name__}, error_message: {exc_message}"
                    )

                msg = (
                    f"[TIMER_WITH_STATUS] {log_prefix or fn.__name__} "
                    f"took {elapsed_ms:.0f} ms{status_info}, args: {ctx_str}"
                )

                logger.info(msg)

        return wrapper

    if func is None:
        return decorator
    return decorator(func)


def timed(func=None, *, log=True, log_prefix=""):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed_ms = (time.perf_counter() - start) * 1000.0

            if log is not True:
                return result

            # 100ms threshold
            if elapsed_ms >= 100.0:
                logger.info(f"[TIMER] {log_prefix or fn.__name__} took {elapsed_ms:.0f} ms")

            return result

        return wrapper

    # Handle both @timed and @timed(log=True) cases
    if func is None:
        return decorator
    return decorator(func)
