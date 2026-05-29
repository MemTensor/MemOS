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
            except Exception as e:
                self.duration_ms = int((time.perf_counter() - self._start) * 1000)
                self._emit(self.duration_ms, type(e))
                raise
            finally:
                self.duration_ms = int((time.perf_counter() - self._start) * 1000)
                self._emit(self.duration_ms)

        return wrapper

    # -- public helpers ----------------------------------------------------

    def set(self, **kwargs: Any) -> None:
        """Attach extra fields mid-block (context-manager usage)."""
        self._fields.update(kwargs)

    # -- internal ----------------------------------------------------------

    def _emit(self, duration_ms: int, exc_type=None):
        parts = ["[STAGE]"]
        if self._biz:
            parts.append(f"biz={self._biz}")
        if self._stage:
            parts.append(f"stage={self._stage}")
        if self._static_extra:
            for k, v in self._static_extra.items():
                parts.append(f"{k}={v}")
        for k, v in self._fields.items():
            parts.append(f"{k}={v}")
        parts.append(f"duration_ms={duration_ms}")
        if exc_type is not None:
            parts.append(f"error={exc_type.__name__}")
        msg = " ".join(parts)
        getattr(logger, self._level, logger.info)(msg)
