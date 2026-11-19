"""Opt-in lifecycle evidence and reversible Dream retention policy."""

from memos.dream.lifecycle.contracts import (
    LIFECYCLE_METADATA_KEY,
    EventKind,
    LifecycleConfig,
    LifecycleError,
    LifecycleEvent,
    LifecycleState,
    MaintenanceDecision,
)
from memos.dream.lifecycle.policy import (
    apply_event,
    decide_maintenance,
    initialize_state,
    restore_state,
)


__all__ = [
    "LIFECYCLE_METADATA_KEY",
    "EventKind",
    "LifecycleConfig",
    "LifecycleError",
    "LifecycleEvent",
    "LifecycleState",
    "MaintenanceDecision",
    "apply_event",
    "decide_maintenance",
    "initialize_state",
    "restore_state",
]
