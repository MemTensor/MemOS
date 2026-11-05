"""Bounded maintenance and durable cursor failure recovery on native storage."""

import json

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from memos.dream.lifecycle import LIFECYCLE_METADATA_KEY, LifecycleConfig, LifecycleError
from memos.dream.lifecycle.runner import DreamMaintenanceRunner, MaintenanceLimits
from memos.dream.lifecycle.service import DreamLifecycleService


NOW = datetime(2026, 2, 1, tzinfo=timezone.utc)


def records(graph, count=5):
    ids = ["runner-" + uuid4().hex for _ in range(count)]
    for item in ids:
        graph.add_node(
            item,
            "Synthetic old memory",
            {
                "source": "dream",
                "status": "activated",
                "created_at": (NOW - timedelta(days=30)).isoformat(),
            },
            user_name="runner-cube",
        )
    return ids


def service(graph):
    return DreamLifecycleService(
        graph, LifecycleConfig(half_life_seconds=86400, never_hit_grace_seconds=0)
    )


def test_node_cap_checkpoint_resume_and_quiet_next_sweep(graph, tmp_path):
    ids = records(graph)
    path = tmp_path / "cursor.json"
    runner = DreamMaintenanceRunner(service(graph), checkpoint=path)
    first = runner.run(
        cube_id="runner-cube", now=NOW, limits=MaintenanceLimits(page_size=2, max_nodes=3)
    )
    assert first.scanned == 3 and first.archived == 3 and not first.complete
    second = runner.run(cube_id="runner-cube", now=NOW)
    assert second.complete
    assert all(
        graph.get_node(item, user_name="runner-cube")["metadata"]["status"] == "archived"
        for item in ids
    )
    next_sweep = runner.run(cube_id="runner-cube", now=NOW + timedelta(days=1))
    assert next_sweep.complete and next_sweep.scanned >= 5 and next_sweep.archived == 0


def test_dry_run_does_not_create_checkpoint_lock_or_lifecycle_metadata(graph, tmp_path):
    ids = records(graph)
    path = tmp_path / "cursor.json"
    before = {item: graph.get_node(item, user_name="runner-cube")["metadata"] for item in ids}
    runner = DreamMaintenanceRunner(service(graph), checkpoint=path)
    report = runner.run(cube_id="runner-cube", now=NOW, dry_run=True)
    assert report.would_archive >= len(ids) and report.archived == 0
    assert not list(tmp_path.iterdir())
    assert {
        item: graph.get_node(item, user_name="runner-cube")["metadata"] for item in ids
    } == before


def test_failed_page_does_not_pass_corrupt_row_or_commit_other_page_members(graph, tmp_path):
    ids = sorted(records(graph, 2))
    graph.update_node(ids[1], {LIFECYCLE_METADATA_KEY: {"version": 99}}, user_name="runner-cube")
    runner = DreamMaintenanceRunner(service(graph), checkpoint=tmp_path / "cursor.json")
    report = runner.run(cube_id="runner-cube", now=NOW, limits=MaintenanceLimits(page_size=1000))
    assert report.stop_reason == "page_failed" and report.failed == 1
    assert report.next_after is None
    assert graph.get_node(ids[0], user_name="runner-cube")["metadata"]["status"] == "activated"


def test_checkpoint_binding_and_corruption_rejected_before_writes(graph, tmp_path):
    records(graph)
    path = tmp_path / "cursor.json"
    runner = DreamMaintenanceRunner(service(graph), checkpoint=path)
    runner.run(cube_id="runner-cube", now=NOW, limits=MaintenanceLimits(max_nodes=1))
    with pytest.raises(LifecycleError, match="scope|binding"):
        runner.run(cube_id="different-cube", now=NOW)
    original = json.loads(path.read_text())
    path.write_text('{"version":1,"version":1}')
    with pytest.raises(LifecycleError):
        runner.run(cube_id="runner-cube", now=NOW)
    path.write_text(json.dumps({**original, "version": 99}))
    with pytest.raises(LifecycleError):
        runner.run(cube_id="runner-cube", now=NOW)


def test_cancel_and_elapsed_budget_are_cooperative_and_do_not_advance(graph, tmp_path):
    records(graph)
    runner = DreamMaintenanceRunner(service(graph), checkpoint=tmp_path / "cursor.json")
    result = runner.run(cube_id="runner-cube", now=NOW, cancelled=lambda: True)
    assert result.scanned == 0 and result.stop_reason == "cancelled"
    times = iter([0, 10])
    runner = DreamMaintenanceRunner(service(graph), monotonic=lambda: next(times, 10))
    result = runner.run(cube_id="runner-cube", now=NOW, limits=MaintenanceLimits(max_seconds=1))
    assert result.scanned == 0 and result.stop_reason == "time_budget"


def test_checkpoint_failure_replays_committed_page_without_duplicate_transitions(
    graph, tmp_path, monkeypatch
):
    records(graph)
    runner = DreamMaintenanceRunner(service(graph), checkpoint=tmp_path / "cursor.json")
    original = runner._save_cursor
    monkeypatch.setattr(
        runner,
        "_save_cursor",
        lambda _cursor: (_ for _ in ()).throw(OSError("Synthetic disk failure")),
    )
    result = runner.run(cube_id="runner-cube", now=NOW)
    assert result.stop_reason == "checkpoint_failed" and result.next_after is None
    monkeypatch.setattr(runner, "_save_cursor", original)
    replay = runner.run(cube_id="runner-cube", now=NOW)
    assert replay.complete and replay.archived == 0


def test_reports_bound_decisions_and_checkpoint_exact_evidence_revisions(graph, tmp_path):
    records(graph, 5)
    path = tmp_path / "cursor.json"
    runner = DreamMaintenanceRunner(service(graph), checkpoint=path)
    report = runner.run(
        cube_id="runner-cube",
        now=NOW,
        limits=MaintenanceLimits(page_size=2, max_report_decisions=2),
    )
    assert report.eligible == 5 and report.archived == 5
    assert len(report.decisions) == 2 and report.omitted_decisions == 3
    assert report.reason_counts == {"stale": 5}
    assert report.backend_capability == "atomic_lifecycle_metadata"
    assert all(item.evidence_revision == 0 for item in report.decisions)
    cursor = json.loads(path.read_text())
    assert cursor["last_page"][0]["reason"] == "stale"
    assert cursor["last_page"][0]["evidence_revision"] == 0
    assert "memory" not in cursor["last_page"][0]


def test_failed_page_reports_every_retry_id_without_advancing_cursor(graph, tmp_path):
    ids = sorted(records(graph, 2))
    graph.update_node(ids[-1], {LIFECYCLE_METADATA_KEY: {"version": 99}}, user_name="runner-cube")
    runner = DreamMaintenanceRunner(service(graph), checkpoint=tmp_path / "cursor.json")
    report = runner.run(cube_id="runner-cube", now=NOW)
    assert report.retry_ids == tuple(ids)
    assert report.invalid == 1 and report.failed == 1
    assert report.next_after is None
