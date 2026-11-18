"""Execution context shared by related plugin Hook calls."""

from __future__ import annotations

# Keep this import available for runtime inspection of the public annotations.
from collections.abc import Mapping  # noqa: TC003
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4


@dataclass(frozen=True, slots=True)
class HookContext:
    """Correlation metadata for one Hook-observable operation."""

    trace_id: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    task_id: str | None = None
    cube_ids: tuple[str, ...] = ()
    operation_id: str | None = None
    source: str | None = None
    attributes: Mapping[str, Any] = field(default_factory=dict)


def build_hook_context(
    *,
    source: str,
    trace_id: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    task_id: str | None = None,
    cube_ids: list[str] | tuple[str, ...] | None = None,
    operation_id: str | None = None,
    attributes: Mapping[str, Any] | None = None,
) -> HookContext:
    """Build correlation metadata at a business-operation boundary."""
    return HookContext(
        trace_id=trace_id,
        user_id=user_id,
        session_id=session_id,
        task_id=task_id,
        cube_ids=tuple(cube_ids or ()),
        operation_id=operation_id or uuid4().hex,
        source=source,
        attributes=dict(attributes or {}),
    )
