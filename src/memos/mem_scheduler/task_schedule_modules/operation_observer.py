from __future__ import annotations

from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Any

from memos.plugins.hook_context import build_hook_context
from memos.plugins.hook_defs import H
from memos.plugins.hooks import trigger_hook


if TYPE_CHECKING:
    from collections.abc import Mapping


_MISSING = object()


class SchedulerOperationObserver(AbstractContextManager["SchedulerOperationObserver"]):
    """Observe one Handler operation without changing its exception semantics.

    Usage:
        with SchedulerOperationObserver(...) as observer:
            result = perform_operation()
            observer.result(result)
    """

    def __init__(
        self,
        *,
        source: str,
        operation: str,
        operation_context: dict[str, Any],
        operation_input: Mapping[str, Any],
        capture_failure: bool = False,
    ) -> None:
        self._hook_kwargs = {
            "operation": operation,
            "operation_input": dict(operation_input),
        }
        cube_id = operation_context.get("cube_id") or operation_context.get("mem_cube_id")
        self._hook_context = build_hook_context(
            trace_id=operation_context.get("trace_id"),
            user_id=operation_context.get("user_id"),
            session_id=operation_context.get("session_id"),
            task_id=operation_context.get("task_id"),
            cube_ids=[str(cube_id)] if cube_id else None,
            source=source,
            attributes=self._attributes(operation_context),
        )
        self._capture_failure = capture_failure
        self._result: Any = _MISSING
        self._failed = False

    def __enter__(self) -> SchedulerOperationObserver:
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        if exc_value is not None:
            if self._capture_failure:
                self.failed(exc_value)
            return False

        if not self._failed and self._result is not _MISSING:
            hook_result = trigger_hook(
                H.SCHEDULER_MEMORY_OPERATION_AFTER,
                hook_context=self._hook_context,
                **self._hook_kwargs,
                result=self._result,
            )
            if hook_result is not None:
                self._result = hook_result
        return False

    def result(self, value: Any) -> Any:
        """Record and return the operation result for concise call sites."""
        self._result = value
        return value

    @property
    def value(self) -> Any:
        """Return the result after successful Hook pipeline processing."""
        return None if self._result is _MISSING else self._result

    def failed(self, error: BaseException) -> None:
        """Emit the failure Hook once at an existing exception boundary."""
        if self._failed:
            return
        self._failed = True
        trigger_hook(
            H.SCHEDULER_MEMORY_OPERATION_FAILED,
            hook_context=self._hook_context,
            **self._hook_kwargs,
            error=error,
        )

    @staticmethod
    def _attributes(operation_context: dict[str, Any]) -> dict[str, Any]:
        attributes = {
            "scheduler_item_id": operation_context.get("scheduler_item_id")
            or operation_context.get("item_id"),
            "label": operation_context.get("label"),
        }
        return {key: value for key, value in attributes.items() if value is not None}
