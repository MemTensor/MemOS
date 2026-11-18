from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4


if TYPE_CHECKING:
    from collections.abc import Callable


# Handlers detach nested values; frozen only prevents field reassignment.
@dataclass(frozen=True, slots=True)
class TraceValue:
    """One semantic variable consumed or produced by a MemOS operation."""

    value: Any
    # Identity becomes the exported node name and controls reuse within a class_name.
    identity: str
    # Category is the business role; class_name is the node's type/identity namespace.
    category: str = "variable"
    class_name: str | None = None
    # Reference an existing node, or create a placeholder if it has not arrived yet.
    identity_only: bool = False
    comment: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# Category/comment inherit operation defaults; link metadata overrides operation metadata.
@dataclass(frozen=True, slots=True)
class TraceLink:
    """One explicit variable-to-variable dependency within an operation."""

    source: TraceValue
    target: TraceValue
    category: str | None = None
    comment: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TraceEvent:
    """Framework-neutral event; only explicit links create graph edges."""

    operation: str
    category: str
    trace_id: str
    session_id: str | None = None
    task_id: str | None = None
    user_id: str | None = None
    cube_ids: tuple[str, ...] = ()
    inputs: tuple[TraceValue, ...] = ()
    outputs: tuple[TraceValue, ...] = ()
    # Inputs/outputs preserve standalone nodes; they never imply dependencies.
    links: tuple[TraceLink, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
    # event_id identifies this observation; operation_id is correlation metadata.
    event_id: str = field(default_factory=lambda: uuid4().hex)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    # Human-readable operation meaning; omitted comments use the recorder's default.
    comment: str | None = None


@dataclass(frozen=True, slots=True)
class DeferredTraceEvent:
    """Build an event on the writer using only detached, already-redacted captures."""

    operation: str
    build: Callable[[], TraceEvent]
