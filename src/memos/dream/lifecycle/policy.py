"""Pure event-time reducers; no storage, model calls or mutable global clock."""

from __future__ import annotations

import hashlib
import math

from datetime import datetime, timedelta

from memos.dream.lifecycle.contracts import (
    EventKind,
    EventReceipt,
    LifecycleConfig,
    LifecycleError,
    LifecycleEvent,
    LifecycleState,
    MaintenanceDecision,
    checked_state,
    utc_time,
)


def initialize_state(
    *,
    memory_id: str,
    cube_id: str,
    created_at: datetime | str,
    config: LifecycleConfig,
    base_strength: float = 1.0,
    pinned: bool = False,
    source_dream_id: str = "",
) -> LifecycleState:
    """Initialize evidence without inferring usefulness from Dream confidence."""
    return LifecycleState(
        memory_id=memory_id,
        cube_id=cube_id,
        created_at=utc_time(created_at, legacy=True),
        policy_fingerprint=config.fingerprint(),
        base_strength=base_strength,
        pinned=pinned,
        source_dream_id=source_dream_id,
    )


def _decay(seconds: float, config: LifecycleConfig) -> float:
    return 2.0 ** (-max(0.0, seconds) / config.half_life_seconds)


def _masses(state: LifecycleState, config: LifecycleConfig, now: datetime) -> tuple[float, float]:
    anchor = state.mass_anchor_at or state.created_at
    factor = _decay((now - anchor).total_seconds(), config)
    return state.positive_mass * factor, state.negative_mass * factor


def _usefulness(positive: float, negative: float) -> float:
    # Scale before adding to avoid overflow for valid large finite input masses.
    scale = max(1.0, positive, negative)
    prior = 1.0 / scale
    return (positive / scale + prior) / (positive / scale + negative / scale + 2 * prior)


def apply_event(
    state: LifecycleState,
    event: LifecycleEvent,
    config: LifecycleConfig,
    *,
    now: datetime,
) -> LifecycleState:
    """Reduce one committed event with bounded, event-time deduplication."""
    state = checked_state(state, config)
    now = utc_time(now)
    if (state.memory_id, state.cube_id) != (event.memory_id, event.cube_id):
        raise LifecycleError("Lifecycle event scope mismatch")
    try:
        event = LifecycleEvent.model_validate(event.model_dump(mode="python"))
    except ValueError as exc:
        raise LifecycleError("Invalid lifecycle event") from exc
    age = (now - event.at).total_seconds()
    if age > config.event_max_age_seconds:
        raise LifecycleError("Lifecycle event is too old for the deduplication horizon")
    if age < -config.future_tolerance_seconds:
        raise LifecycleError("Lifecycle event is too far in the future")
    if event.at < state.created_at - timedelta(seconds=config.future_tolerance_seconds):
        raise LifecycleError("Lifecycle event predates memory creation")

    identity = hashlib.sha256(event.event_id.encode()).hexdigest()
    digest = event.digest()
    live = tuple(receipt for receipt in state.receipts if receipt.expires_at >= now)
    for receipt in live:
        if receipt.identity == identity:
            if receipt.payload != digest:
                raise LifecycleError("Lifecycle event identity conflict")
            return state
    if len(live) >= config.receipt_capacity:
        raise LifecycleError("Lifecycle event receipt capacity exhausted")
    receipt = EventReceipt(
        identity=identity,
        payload=digest,
        expires_at=event.at + timedelta(seconds=config.event_max_age_seconds),
    )
    event_time = min(event.at, now)
    anchor = max(now, state.mass_anchor_at or state.created_at)
    positive, negative = _masses(state, config, anchor)
    changes = {
        "revision": state.revision + 1,
        "receipts": (*live, receipt),
        "mass_anchor_at": anchor,
        "positive_mass": positive,
        "negative_mass": negative,
    }
    if event.kind == EventKind.RETRIEVED:
        changes["hit_count"] = state.hit_count + 1
        changes["last_hit_at"] = max(event_time, state.last_hit_at or event_time)
    elif event.kind in (EventKind.POSITIVE, EventKind.NEGATIVE):
        weight = _decay((anchor - event_time).total_seconds(), config)
        name = "positive_mass" if event.kind == EventKind.POSITIVE else "negative_mass"
        changes[name] += weight
        changes["outcome_count"] = state.outcome_count + 1
    elif event.kind == EventKind.INVALIDATED:
        changes.update(
            invalidated_by_feedback=True,
            status="archived",
            protect_archived_status=True,
            archived_at=event_time,
            archive_reason="feedback_invalidated",
        )
    try:
        return LifecycleState.model_validate({**state.model_dump(), **changes})
    except ValueError as exc:
        raise LifecycleError("Lifecycle evidence overflow or invalid reduction") from exc


def decide_maintenance(
    state: LifecycleState,
    config: LifecycleConfig,
    *,
    now: datetime,
    graph_status: str = "activated",
) -> MaintenanceDecision:
    """Evaluate original evidence; repeated sweeps do not compound decay."""
    state = checked_state(state, config)
    now = utc_time(now)
    anchor = max(
        value
        for value in (state.created_at, state.last_hit_at, state.restored_at)
        if value is not None
    )
    age = max(0.0, (now - anchor).total_seconds())
    reinforced = state.base_strength * (
        1 + config.retrieval_reinforcement * math.log1p(state.hit_count)
    )
    strength = min(config.strength_cap, reinforced) * _decay(age, config)
    usefulness = _usefulness(*_masses(state, config, now))

    def decision(action, reason):
        return MaintenanceDecision(
            action=action, reason=reason, strength=strength, usefulness=usefulness
        )

    if state.invalidated_by_feedback:
        return decision("archive", "feedback_invalidated")
    if graph_status != "activated":
        return decision(
            "skip", "externally_archived" if graph_status == "archived" else "external_status"
        )
    if state.pinned:
        return decision("keep", "pinned")
    if state.last_hit_at is None and age < config.never_hit_grace_seconds:
        return decision("keep", "never_hit_grace")
    if (
        state.outcome_count >= config.min_outcome_count
        and usefulness < config.low_usefulness_threshold
    ):
        return decision("archive", "low_usefulness")
    if strength < config.archive_strength_threshold:
        return decision("archive", "stale")
    return decision("keep", "retained")


def restore_state(
    state: LifecycleState,
    config: LifecycleConfig,
    *,
    now: datetime,
    reason: str,
    override_invalidation: bool = False,
) -> LifecycleState:
    """Explicitly recover an archived item; never infer recovery from a hit."""
    state = checked_state(state, config)
    if not reason or not reason.strip():
        raise LifecycleError("Lifecycle restoration requires a reason")
    if state.invalidated_by_feedback and not override_invalidation:
        raise LifecycleError("Restoring invalidated evidence requires an explicit override")
    return LifecycleState.model_validate(
        {
            **state.model_dump(),
            "status": "active",
            "protect_archived_status": False,
            "invalidated_by_feedback": False,
            "restored_at": utc_time(now),
            "restore_reason": reason,
            "revision": state.revision + 1,
        }
    )
