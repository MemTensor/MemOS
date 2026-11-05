"""Public lifecycle service and native persistence contracts."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from memos.dream.lifecycle import (
    LIFECYCLE_METADATA_KEY,
    EventKind,
    LifecycleConfig,
    LifecycleError,
    LifecycleEvent,
)
from memos.dream.lifecycle.service import DreamLifecycleService
from memos.dream.pipeline.persistence import DreamPersistence
from memos.dream.types import DreamAction, DreamActionType, DreamResult, TargetMemoryType


NOW = datetime(2026, 1, 15, tzinfo=timezone.utc)


def node(graph, source="dream", **extra):
    memory_id = "service-" + uuid4().hex
    graph.add_node(
        memory_id,
        "Synthetic source",
        {
            "source": source,
            "status": "activated",
            "created_at": (NOW - timedelta(days=14)).isoformat(),
            "confidence": 0.3,
            **extra,
        },
        user_name="cube-a",
    )
    return memory_id


def event(memory_id, identity="retrieval-1", kind=EventKind.RETRIEVED, at=NOW):
    return LifecycleEvent(
        memory_id=memory_id,
        cube_id="cube-a",
        event_id=identity,
        kind=kind,
        at=at,
        reason="Explicit fixture feedback" if kind == EventKind.INVALIDATED else "",
    )


def test_observation_is_atomic_deduplicated_and_keeps_raw_confidence(graph):
    memory_id = node(graph)
    service = DreamLifecycleService(graph, LifecycleConfig())
    report = service.observe([event(memory_id), event(memory_id)], now=NOW)
    assert report.accepted == 1 and report.duplicates == 1
    metadata = graph.get_node(memory_id, user_name="cube-a")["metadata"]
    assert metadata["confidence"] == 0.3
    assert metadata[LIFECYCLE_METADATA_KEY]["hit_count"] == 1
    assert service.observe([event(memory_id)], now=NOW).duplicates == 1


def test_non_dream_and_missing_nodes_do_not_gain_lifecycle_state(graph):
    memory_id = node(graph, source="user")
    service = DreamLifecycleService(graph, LifecycleConfig())
    report = service.observe([event(memory_id), event("missing")], now=NOW)
    assert report.skipped == 1 and report.missing == 1
    assert LIFECYCLE_METADATA_KEY not in graph.get_node(memory_id, user_name="cube-a")["metadata"]


def test_duplicate_conflict_rolls_back_all_events_in_batch(graph):
    first, second = node(graph), node(graph)
    service = DreamLifecycleService(graph, LifecycleConfig())
    service.observe([event(second)], now=NOW)
    with pytest.raises(LifecycleError, match="identity conflict"):
        service.observe([event(first), event(second, kind=EventKind.NEGATIVE)], now=NOW)
    assert LIFECYCLE_METADATA_KEY not in graph.get_node(first, user_name="cube-a")["metadata"]


def test_dry_run_repeated_sweep_and_explicit_restore(graph):
    memory_id = node(graph)
    service = DreamLifecycleService(
        graph, LifecycleConfig(half_life_seconds=86400, never_hit_grace_seconds=0)
    )
    before = graph.get_node(memory_id, user_name="cube-a")["metadata"]
    outcome = service.maintain([memory_id], cube_id="cube-a", now=NOW, dry_run=True)[0]
    assert outcome.action == "archive" and outcome.reason == "stale"
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"] == before
    service.maintain([memory_id], cube_id="cube-a", now=NOW)
    archived = graph.get_node(memory_id, user_name="cube-a")["metadata"]
    service.maintain([memory_id], cube_id="cube-a", now=NOW)
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"] == archived
    service.restore(memory_id, cube_id="cube-a", reason="Revalidated by caller", now=NOW)
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["status"] == "activated"
    assert service.maintain([memory_id], cube_id="cube-a", now=NOW)[0].action == "keep"


def test_explicit_invalidation_overrides_pin_and_requires_restore_override(graph):
    memory_id = node(graph)
    service = DreamLifecycleService(graph, LifecycleConfig())
    service.set_pinned(memory_id, cube_id="cube-a", pinned=True, now=NOW)
    service.observe([event(memory_id, kind=EventKind.INVALIDATED)], now=NOW)
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["status"] == "archived"
    with pytest.raises(LifecycleError):
        service.restore(memory_id, cube_id="cube-a", reason="Try", now=NOW)
    service.restore(
        memory_id,
        cube_id="cube-a",
        reason="Explicit revalidation",
        now=NOW,
        override_invalidation=True,
    )
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["status"] == "activated"


def test_corrupt_metadata_is_quarantined_and_foreign_scope_rejected(graph):
    memory_id = node(graph, **{LIFECYCLE_METADATA_KEY: {"version": 99}})
    service = DreamLifecycleService(graph, LifecycleConfig())
    before = graph.get_node(memory_id, user_name="cube-a")["metadata"]
    with pytest.raises(LifecycleError):
        service.maintain([memory_id], cube_id="cube-a", now=NOW)
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"] == before
    assert service.maintain([memory_id], cube_id="cube-b", now=NOW)[0].action == "missing"


def test_native_persistence_archive_update_merge_use_graph_field_contract(graph):
    first, second = node(graph), node(graph)
    persistence = DreamPersistence()
    persistence.bind_context({"shared": {"graph_db": graph}})

    def persist(action):
        persistence.persist(
            results=[DreamResult(cluster_id="native", actions=[action])],
            text_mem=object(),
            cube_id="cube-a",
            mem_cube_id="cube-a",
            user_id="user-a",
            signal_snapshot=None,
        )

    args = {
        "target_memory_type": TargetMemoryType.LONG_TERM,
        "rationale": "Synthetic explicit instruction",
        "confidence": 1,
    }
    persist(
        DreamAction(
            action_type=DreamActionType.UPDATE,
            target_memory_id=first,
            new_content="Updated",
            **args,
        )
    )
    assert graph.get_node(first, user_name="cube-a")["memory"] == "Updated"
    persist(
        DreamAction(
            action_type=DreamActionType.MERGE,
            source_memory_ids=[second],
            new_content="Merged",
            **args,
        )
    )
    assert graph.get_node(second, user_name="cube-a")["metadata"]["status"] == "merged"
    persist(DreamAction(action_type=DreamActionType.ARCHIVE, target_memory_id=first, **args))
    assert graph.get_node(first, user_name="cube-a")["metadata"]["status"] == "archived"


def test_opted_in_persistence_initializes_service_state_without_confidence_rewrite(graph):
    service = DreamLifecycleService(graph, LifecycleConfig())
    persistence = DreamPersistence()
    persistence.bind_context({"shared": {"graph_db": graph, "dream_lifecycle": service}})
    persistence.persist(
        results=[
            DreamResult(
                cluster_id="native",
                actions=[
                    DreamAction(
                        action_type=DreamActionType.CREATE,
                        target_memory_type=TargetMemoryType.LONG_TERM,
                        new_content="New memory",
                        rationale="Synthetic",
                        confidence=0.7,
                    )
                ],
            )
        ],
        text_mem=object(),
        cube_id="cube-a",
        mem_cube_id="cube-a",
        user_id="user-a",
        signal_snapshot=None,
    )
    records = graph.list_lifecycle_nodes(user_name="cube-a", limit=1000)
    created = [row for row in records if row["metadata"].get("confidence") == 0.7]
    assert len(created) == 1
    assert created[0]["metadata"][LIFECYCLE_METADATA_KEY]["base_strength"] == 1
    from memos.memories.textual.item import TextualMemoryItem

    native_item = TextualMemoryItem(**graph.get_node(created[0]["id"], user_name="cube-a"))
    assert native_item.metadata.source == "dream"


def test_inspection_explains_quarantine_and_retention_without_initializing_or_writing(graph):
    good = node(graph)
    corrupt = node(graph, **{LIFECYCLE_METADATA_KEY: {"version": 99}})
    unrelated = node(graph, source="user")
    service = DreamLifecycleService(
        graph, LifecycleConfig(half_life_seconds=86400, never_hit_grace_seconds=0)
    )
    before = graph.get_node(good, user_name="cube-a")["metadata"]
    reports = service.inspect([good, corrupt, unrelated, "missing"], cube_id="cube-a", now=NOW)
    assert reports[0].next_action == "archive" and reports[0].reason == "stale"
    assert reports[0].managed is False and reports[0].receipt_count == 0
    assert reports[1].quarantined and reports[1].next_action == "skip"
    assert reports[2].eligible is False and reports[3].found is False
    assert graph.get_node(good, user_name="cube-a")["metadata"] == before


def test_malformed_temporal_and_ownership_invariants_are_quarantined(graph):
    from memos.dream.lifecycle import initialize_state

    service = DreamLifecycleService(graph, LifecycleConfig())
    for patch in [
        {"last_hit_at": NOW + timedelta(days=1), "hit_count": 1},
        {"status": "archived", "protect_archived_status": False},
        {"invalidated_by_feedback": True},
        {"hit_count": 1, "last_hit_at": None},
    ]:
        item = node(graph)
        state = initialize_state(
            memory_id=item,
            cube_id="cube-a",
            config=service.config,
            created_at=NOW - timedelta(days=1),
        )
        graph.update_node(
            item,
            {LIFECYCLE_METADATA_KEY: state.model_copy(update=patch).model_dump(mode="json")},
            user_name="cube-a",
        )
        before = graph.get_node(item, user_name="cube-a")["metadata"]
        with pytest.raises(LifecycleError):
            service.maintain([item], cube_id="cube-a", now=NOW)
        assert graph.get_node(item, user_name="cube-a")["metadata"] == before
