"""Observable lifecycle policy contracts with fixed clocks and literal oracles."""

import math

from datetime import datetime, timedelta, timezone

import pytest

from memos.dream.lifecycle import (
    EventKind,
    LifecycleConfig,
    LifecycleError,
    LifecycleEvent,
    apply_event,
    decide_maintenance,
    initialize_state,
    restore_state,
)


NOW = datetime(2026, 1, 10, tzinfo=timezone.utc)


def config(**overrides):
    return LifecycleConfig(
        **{
            "half_life_seconds": 86400,
            "never_hit_grace_seconds": 86400,
            "archive_strength_threshold": 0.2,
            "event_max_age_seconds": 86400,
            "receipt_capacity": 8,
            **overrides,
        }
    )


def state(*, created_at=NOW, **kwargs):
    return initialize_state(
        memory_id="memory-a",
        cube_id="cube-a",
        created_at=created_at,
        config=config(),
        **kwargs,
    )


def event(event_id="event-a", *, at=NOW, kind=EventKind.RETRIEVED, **kwargs):
    return LifecycleEvent(
        event_id=event_id,
        memory_id="memory-a",
        cube_id="cube-a",
        at=at,
        kind=kind,
        **kwargs,
    )


def test_grace_and_half_life_are_based_on_original_time_not_sweep_count():
    original = state()
    first = decide_maintenance(original, config(), now=NOW + timedelta(days=1))
    assert first.action == "keep"
    assert first.strength == pytest.approx(0.5)
    third_day = decide_maintenance(original, config(), now=NOW + timedelta(days=3))
    assert third_day.action == "archive"
    assert third_day.strength == pytest.approx(0.125)
    assert decide_maintenance(original, config(), now=NOW + timedelta(days=3)) == third_day
    assert original.status == "active"


def test_never_hit_grace_prevents_low_prior_premature_archive():
    original = state(base_strength=0.01)
    decision = decide_maintenance(original, config(), now=NOW + timedelta(hours=23))
    assert decision.action == "keep"
    assert decision.reason == "never_hit_grace"


def test_duplicate_observation_does_not_reinforce_or_change_revision():
    observed = apply_event(state(), event(), config(), now=NOW)
    duplicate = apply_event(observed, event(), config(), now=NOW + timedelta(minutes=1))
    assert duplicate == observed
    assert duplicate.hit_count == 1
    assert duplicate.last_hit_at == NOW


def test_conflicting_event_identity_fails_without_mutating_evidence():
    observed = apply_event(state(), event(), config(), now=NOW)
    with pytest.raises(LifecycleError, match="conflict"):
        apply_event(observed, event(kind=EventKind.POSITIVE), config(), now=NOW)
    assert observed.hit_count == 1
    assert observed.positive_mass == 0


def test_delayed_hit_does_not_move_last_hit_back_or_receive_arrival_time():
    original = state(created_at=NOW - timedelta(days=2))
    newer = apply_event(original, event(at=NOW - timedelta(hours=1)), config(), now=NOW)
    older = apply_event(newer, event("older", at=NOW - timedelta(hours=3)), config(), now=NOW)
    assert older.hit_count == 2
    assert older.last_hit_at == NOW - timedelta(hours=1)


def test_delayed_outcome_has_event_time_weight():
    original = state(created_at=NOW - timedelta(days=2))
    result = apply_event(
        original, event(kind=EventKind.POSITIVE, at=NOW - timedelta(hours=12)), config(), now=NOW
    )
    assert result.positive_mass == pytest.approx(2**-0.5)
    assert result.mass_anchor_at == NOW


def test_retrieval_never_counts_as_confirmed_usefulness():
    result = apply_event(state(), event(), config(), now=NOW)
    assert result.positive_mass == 0
    assert result.negative_mass == 0
    assert decide_maintenance(result, config(), now=NOW).usefulness == 0.5


def test_pinned_memory_still_obeys_explicit_invalidation():
    original = state(pinned=True)
    assert decide_maintenance(original, config(), now=NOW + timedelta(days=90)).action == "keep"
    invalid = apply_event(
        original, event(kind=EventKind.INVALIDATED, reason="corrected fact"), config(), now=NOW
    )
    decision = decide_maintenance(invalid, config(), now=NOW)
    assert decision.action == "archive"
    assert decision.reason == "feedback_invalidated"


def test_recovery_needs_explicit_override_for_invalidated_memory():
    invalid = apply_event(
        state(), event(kind=EventKind.INVALIDATED, reason="corrected fact"), config(), now=NOW
    )
    with pytest.raises(LifecycleError, match="override"):
        restore_state(invalid, config(), now=NOW, reason="operator request")
    restored = restore_state(
        invalid, config(), now=NOW, reason="verified correction", override_invalidation=True
    )
    assert not restored.invalidated_by_feedback
    assert restored.status == "active"
    assert not restored.protect_archived_status
    assert restored.restore_reason == "verified correction"


def test_live_receipts_are_not_evicted_to_accept_another_event():
    settings = config(receipt_capacity=1)
    original = initialize_state(
        memory_id="memory-a", cube_id="cube-a", created_at=NOW, config=settings
    )
    first = apply_event(original, event(), settings, now=NOW)
    with pytest.raises(LifecycleError, match="capacity"):
        apply_event(first, event("new"), settings, now=NOW)
    assert first.hit_count == 1


def test_expired_receipts_can_be_pruned_but_old_events_cannot_be_replayed():
    settings = config(receipt_capacity=1)
    original = initialize_state(
        memory_id="memory-a", cube_id="cube-a", created_at=NOW, config=settings
    )
    first = apply_event(original, event(), settings, now=NOW)
    later = NOW + timedelta(days=2)
    second = apply_event(first, event("new", at=later), settings, now=later)
    assert second.hit_count == 2
    assert len(second.receipts) == 1
    with pytest.raises(LifecycleError, match="old"):
        apply_event(second, event(), settings, now=later)


@pytest.mark.parametrize("overrides", [{"memory_id": "other"}, {"cube_id": "other"}])
def test_event_scope_mismatch_is_rejected(overrides):
    bad = event().model_copy(update=overrides)
    with pytest.raises(LifecycleError, match="scope"):
        apply_event(state(), bad, config(), now=NOW)


def test_future_event_cannot_extend_retention_into_future():
    observed = apply_event(state(), event(at=NOW + timedelta(seconds=30)), config(), now=NOW)
    assert observed.last_hit_at == NOW
    with pytest.raises(LifecycleError, match="future"):
        apply_event(state(), event(at=NOW + timedelta(days=2)), config(), now=NOW)


def test_legacy_naive_creation_is_utc_but_new_event_requires_timezone():
    original = state(created_at=datetime(2026, 1, 10))
    assert original.created_at == NOW
    with pytest.raises(ValueError):
        event(at=datetime(2026, 1, 10))


@pytest.mark.parametrize(
    "field,value",
    [
        ("half_life_seconds", 0),
        ("receipt_capacity", 0),
        ("archive_strength_threshold", float("nan")),
        ("retrieval_reinforcement", -1),
    ],
)
def test_invalid_policy_parameters_fail_before_mutation(field, value):
    with pytest.raises(ValueError):
        config(**{field: value})


def test_policy_change_cannot_reinterpret_accumulated_masses():
    observed = apply_event(state(), event(kind=EventKind.POSITIVE), config(), now=NOW)
    with pytest.raises(LifecycleError, match="policy"):
        apply_event(observed, event("next"), config(half_life_seconds=172800), now=NOW)


def test_external_archived_status_is_not_automatically_reactivated():
    decision = decide_maintenance(state(), config(), now=NOW, graph_status="archived")
    assert decision.action == "skip"
    assert decision.reason == "externally_archived"


def test_retention_works_without_python_311_only_math_functions(monkeypatch):
    monkeypatch.delattr(math, "exp2", raising=False)
    decision = decide_maintenance(state(), config(), now=NOW + timedelta(days=1))
    assert decision.strength == pytest.approx(0.5)
