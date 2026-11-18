"""Shared correlation, detached snapshots, and event construction."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from memos_smartcomment.events import TraceEvent, TraceLink, TraceValue
from memos_smartcomment.serialization import to_jsonable


# isort: split
from memos.log import get_logger


logger = get_logger(__name__)
# Distinguish a missing trace field from an explicitly empty trace.
_MISSING_TRACE = object()


# Context adapters: resolve current Hook/request shapes without borrowing an empty trace.
def _get(value: Any, name: str, default: Any | None = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _memory_text(memory: Any) -> Any:
    text = _get(memory, "memory")
    return text if text is not None else _get(memory, "text")


def _current_trace_id(subject: Any | None = None) -> str:
    trace_id = _get(subject, "trace_id", _MISSING_TRACE)
    if trace_id is not _MISSING_TRACE and trace_id and trace_id != "trace-id":
        return str(trace_id)

    # An explicitly empty trace must not borrow ambient request context.
    if trace_id is _MISSING_TRACE:
        try:
            from memos.context.context import get_current_trace_id

            trace_id = get_current_trace_id()
            if trace_id and trace_id != "trace-id":
                return str(trace_id)
        except Exception:
            logger.debug("MemOS request context is unavailable", exc_info=True)

    user_id = _get(subject, "user_id")
    if user_id is None:
        if task_id := _get(subject, "task_id"):
            return f"task:{task_id}"
        user_id = "unknown"
    session_id = _get(subject, "session_id") or "default_session"
    return f"standalone:{user_id}:{session_id}"


# Accept the cube aliases used by add, search and scheduler contexts.
def _cube_ids(subject: Any) -> tuple[str, ...]:
    raw = (
        _get(subject, "writable_cube_ids")
        or _get(subject, "readable_cube_ids")
        or _get(subject, "mem_cube_ids")
        or _get(subject, "cube_ids")
    )
    if raw:
        return tuple(dict.fromkeys(str(item) for item in raw))
    cube_id = _get(subject, "mem_cube_id") or _get(subject, "cube_id")
    return (str(cube_id),) if cube_id else ()


class BaseHandler:
    """Build detached trace events and submit them without changing business results."""

    def __init__(
        self,
        submit: Callable[[TraceEvent], Any],
        *,
        max_value_chars: int = 20_000,
    ) -> None:
        self._submit = submit
        self._max_value_chars = max_value_chars

    # Detached values and events: capture business data before handing it to the worker.
    def _snapshot(self, value: Any) -> Any:
        return to_jsonable(value, max_value_chars=self._max_value_chars)

    def _value(
        self,
        *,
        value: Any,
        identity: str,
        category: str,
        class_name: str,
        identity_only: bool,
        comment: str,
        metadata: dict[str, Any] | None = None,
    ) -> TraceValue:
        return TraceValue(
            value=self._snapshot(value),
            identity=identity,
            category=category,
            class_name=class_name,
            identity_only=identity_only,
            comment=comment,
            metadata=self._snapshot(metadata or {}),
        )

    def _event(
        self,
        subject: Any,
        *,
        operation: str,
        category: str,
        comment: str,
        inputs: tuple[TraceValue, ...] = (),
        outputs: tuple[TraceValue, ...] = (),
        links: tuple[TraceLink, ...] = (),
        metadata: dict[str, Any] | None = None,
    ) -> TraceEvent:
        event_metadata = dict(metadata or {})
        if (operation_id := _get(subject, "operation_id")) is not None:
            event_metadata.setdefault("operation_id", operation_id)
        return TraceEvent(
            operation=operation,
            category=category,
            comment=comment,
            trace_id=_current_trace_id(subject),
            session_id=_get(subject, "session_id"),
            task_id=_get(subject, "task_id"),
            user_id=_get(subject, "user_id"),
            cube_ids=_cube_ids(subject),
            inputs=inputs,
            outputs=outputs,
            links=links,
            metadata=self._snapshot(event_metadata),
        )

    # Tracing failures must not change business results.
    def _emit(self, event: TraceEvent) -> None:
        try:
            self._submit(event)
        except Exception:
            logger.exception("Failed to enqueue smartcomment event: %s", event.operation)

    # Hook correlation: user_name identifies the storage cube, not the user.
    @staticmethod
    def _hook_subject(context: Any, *, user_name: Any | None = None) -> dict[str, Any]:
        subject = {
            key: value
            for key in (
                "task_id",
                "user_id",
                "session_id",
                "operation_id",
            )
            if (value := _get(context, key)) is not None
        }
        # Preserve None so worker-local trace context cannot leak into this operation.
        if context is not None:
            subject["trace_id"] = _get(context, "trace_id")
        cube_ids = _get(context, "cube_ids")
        if cube_ids:
            subject["mem_cube_ids"] = cube_ids
        if user_name is not None:
            subject.setdefault("cube_id", user_name)
        return subject

    # Shared terminal nodes and identity-preserving deduplication.
    def _operation_status_value(
        self, subject: Any, error: BaseException, *, stage: str
    ) -> TraceValue:
        operation_id = _get(subject, "operation_id") or _current_trace_id(subject)
        return self._value(
            value="failed",
            identity=f"operation_status:{operation_id}:{stage}",
            category="operation_status",
            class_name="str",
            identity_only=False,
            comment=(f"An exception reached the {stage} Hook boundary: {error!s}."),
            metadata={"memos_stage": stage, "status": "failed"},
        )

    # Keep the last value for each identity in first-occurrence order.
    @staticmethod
    def _unique_values(values: list[TraceValue]) -> tuple[TraceValue, ...]:
        return tuple({value.identity: value for value in values}.values())
