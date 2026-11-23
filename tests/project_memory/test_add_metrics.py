"""Per-Add timing and token attribution from the Episode event log."""

import json
import os

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from memos.llms.usage import CHAT, record_usage
from memos.project_memory.add_metrics import allocate, attribute, episode_timeline
from memos.project_memory.add_runtime import EpisodeAddRuntime, RuntimeSettings
from memos.project_memory.add_store import PostgresAddStore
from memos.project_memory.judge import ModelError


T0 = datetime(2026, 11, 23, 8, 0, tzinfo=timezone.utc)


def _row(**counts):
    return {"kind": CHAT, "model": "m", **dict.fromkeys(_COUNTERS, 0), **counts}


_COUNTERS = (
    "calls",
    "failed_calls",
    "calls_without_usage",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_tokens",
    "reasoning_tokens",
)


def test_allocate_is_exact_and_deterministic():
    assert allocate(101, {"a": 300, "b": 100}) == {"a": 76, "b": 25}
    assert allocate(1, {"b": 1, "a": 1}) == {"a": 1, "b": 0}
    assert allocate(0, {"a": 1}) == {"a": 0}
    for total in range(50):
        assert sum(allocate(total, {"a": 7, "b": 5, "c": 1}).values()) == total


def test_attribute_splits_every_counter_without_loss():
    rows = [_row(calls=3, prompt_tokens=1000, completion_tokens=7, total_tokens=1007)]
    shares = attribute(rows, {"t1": 2, "t2": 1})
    for name in _COUNTERS:
        assert shares["t1"][0][name] + shares["t2"][0][name] == rows[0][name]
    assert shares["t1"][0]["prompt_tokens"] == 667


def test_timeline_separates_queue_run_and_retry_wait():
    def event(kind, seconds, **detail):
        return {
            "event": kind,
            "at": T0 + timedelta(seconds=seconds),
            "stage": "extracting",
            "attempt": 0,
            "detail": detail,
        }

    timeline = episode_timeline(
        {"id": "e", "outcome": "skipped"},
        [
            event("opened", 0),
            event("closed", 5),
            event("published", 5),
            event("claimed", 6, label="p", token="a"),
            event("stage_done", 6.5, token="a", run_ms=500, next_stage="retry_wait", applied=True),
            event("published", 9),
            event("published", 30),  # A stale redelivery does not restart the queue clock.
            event("claimed", 10, label="p", token="b"),
            event(
                "stage_done", 11, token="b", run_ms=1000, next_stage="done", usage=[_row(calls=1)]
            ),
            event("finished", 11, outcome="skipped"),
        ],
    )
    assert timeline["buffer_ms"] == 5000
    assert timeline["processing_ms"] == 6000
    assert timeline["queue_ms"] == 2000
    assert timeline["run_ms"] == 1500
    assert timeline["retry_wait_ms"] == 2500
    assert timeline["other_ms"] == 0
    assert (timeline["claims"], timeline["retries"], timeline["publishes"]) == (2, 1, 3)
    assert timeline["usage"][0]["calls"] == 1


@pytest.fixture
def store():
    dsn = os.getenv("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required")
    db = PostgresAddStore(
        {"dsn": dsn, "schema_name": f"add_metrics_{uuid4().hex}", "embedding_dimension": 3},
        project_id="project",
    )
    with db.transaction() as cur:
        cur.execute("INSERT INTO spaces (id, space_name, project_id) VALUES ('test','T','project')")
        cur.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('product','test','product')"
        )
    yield db
    with db.transaction() as cur:
        from psycopg2 import sql

        cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(db.schema_name)))
    db.close()


def test_merged_episode_bills_each_add_by_its_turns(store, monkeypatch):
    monkeypatch.setenv("PROJECT_MEMORY_EPISODE_MAX_TURNS", "2")
    clock = {"now": T0}
    queue = []
    calls = []

    def write(scope, _prompt, _inputs):
        assert scope == "episode.extract"
        calls.append(clock["now"])
        if len(calls) == 1:
            record_usage(CHAT, "chat-m", {"prompt_tokens": 500})
            raise ModelError("provider timeout")
        record_usage(CHAT, "chat-m", {"prompt_tokens": 1000, "completion_tokens": 101})
        return {"episode_summary": "", "drafts": []}

    hub = Mock()
    hub.write.side_effect = write
    runtime = EpisodeAddRuntime(
        store, hub, queue.extend, Mock(), RuntimeSettings(), clock=lambda: clock["now"]
    )

    def add(task_id, text):
        return runtime.accept(
            SimpleNamespace(
                task_id=task_id,
                user_id="member",
                conversation_id="conversation",
                space_ids=["test"],
                messages=[{"message_id": f"{task_id}:user", "role": "user", "content": text}],
            )
        )

    def metrics(task_id):
        return runtime.status(task_id, "member")["memory_views"]["project"]["metrics"]

    add("task-a", "a" * 300)
    open_metrics = metrics("task-a")
    assert open_metrics["completed_at"] is None and open_metrics["closed_at"] is None
    assert open_metrics["episodes"][0]["state"] == "open"

    clock["now"] = T0 + timedelta(seconds=10)
    add("task-b", "b" * 100)  # The second Turn closes the Episode and publishes extraction.
    assert len(queue) == 1

    clock["now"] = T0 + timedelta(seconds=12)
    runtime.handle([queue.pop()])  # Fails once and waits for a retry.
    clock["now"] = T0 + timedelta(seconds=20)
    runtime.recover()
    clock["now"] = T0 + timedelta(seconds=23)
    runtime.handle([queue.pop()])
    assert len(calls) == 2

    first, second = metrics("task-a"), metrics("task-b")
    (episode,) = first["episodes"]
    assert episode["outcome"] == "skipped" and episode["close_reason"] == "turn_count"
    assert episode["buffer_ms"] == 10_000
    assert episode["queue_ms"] == 5_000  # 10s→12s first delivery, 20s→23s retry delivery
    assert episode["retry_wait_ms"] == 8_000
    assert episode["processing_ms"] == 13_000
    assert (episode["claims"], episode["retries"], episode["turns"], episode["tasks"]) == (
        2,
        1,
        2,
        2,
    )
    assert [stage["next_stage"] for stage in episode["stages"]] == ["retry_wait", "done"]
    assert episode["stages"][0]["error"] == "ModelError"
    assert episode["stages"][0]["reason"] == "MODEL_UNAVAILABLE"
    assert episode["usage"][0]["prompt_tokens"] == 1500

    assert first["latency_ms"] == 23_000 and first["close_wait_ms"] == 10_000
    assert second["latency_ms"] == 13_000 and second["close_wait_ms"] == 0
    assert first["completed_at"] == second["completed_at"]
    a, b = first["usage"]["models"][0], second["usage"]["models"][0]
    assert (a["prompt_tokens"], b["prompt_tokens"]) == (1125, 375)
    assert (a["completion_tokens"], b["completion_tokens"]) == (76, 25)
    assert a["total_tokens"] + b["total_tokens"] == 1601
    assert first["usage"]["complete"] and second["usage"]["complete"]
    assert first["usage"]["attribution"] == "turn_characters"
    json.dumps(runtime.status("task-a", "member"))  # The status route returns raw JSON.


def test_usage_without_provider_counts_is_not_complete(store):
    queue = []
    hub = Mock()

    def write(scope, _prompt, _inputs):
        record_usage(CHAT, "local-model", None)
        return {"episode_summary": "", "drafts": []}

    hub.write.side_effect = write
    runtime = EpisodeAddRuntime(store, hub, queue.extend, Mock(), RuntimeSettings())
    task = runtime.accept(
        SimpleNamespace(
            user_id="member",
            space_ids=["test"],
            messages=[{"role": "user", "content": "We decided to keep weekly reviews."}],
        )
    )["task_id"]
    runtime.handle([queue.pop()])
    metrics = runtime.status(task, "member")["memory_views"]["project"]["metrics"]
    assert metrics["completed_at"] is not None
    assert metrics["usage"]["models"][0]["calls_without_usage"] == 1
    assert metrics["usage"]["complete"] is False


def _event(kind, seconds, **detail):
    return {
        "event": kind,
        "at": T0 + timedelta(seconds=seconds),
        "stage": "organizing",
        "attempt": 1,
        "detail": detail,
    }


def test_stage_end_pairs_with_its_claim_by_lease_token():
    # Stage N+1 is claimed before stage N's worker records its end.
    timeline = episode_timeline(
        {"id": "e", "outcome": "pending"},
        [
            _event("published", 0),
            _event("claimed", 1, label="space", token="n"),
            _event("published", 3),
            _event("claimed", 3.5, label="merge", token="n1"),
            _event("stage_done", 4, token="n", run_ms=3000, next_stage="awaiting_merge"),
            _event("stage_done", 6, token="n1", run_ms=2500, next_stage="committing"),
        ],
    )
    assert [stage["label"] for stage in timeline["stages"]] == ["space", "merge"]
    assert [stage["run_ms"] for stage in timeline["stages"]] == [3000, 2500]
    assert timeline["unfinished_stages"] == 0


def test_a_retry_that_did_not_apply_is_not_counted():
    timeline = episode_timeline(
        {"id": "e", "outcome": "pending"},
        [
            _event("claimed", 0, token="old"),
            _event("claimed", 5, token="new"),
            _event("stage_done", 6, token="old", next_stage="retry_wait", applied=False),
            _event("published", 9),
        ],
    )
    assert (timeline["retries"], timeline["retry_wait_ms"]) == (0, 0)


def test_episode_finished_before_event_recording_uses_its_update_time():
    timeline = episode_timeline(
        {
            "id": "e",
            "outcome": "committed",
            "opened_at": T0,
            "closed_at": T0 + timedelta(seconds=1),
            "updated_at": T0 + timedelta(seconds=9),
        },
        [],
    )
    assert timeline["finished_estimated"] is True
    assert timeline["processing_ms"] == 8000


def test_space_clear_finishes_the_adds_it_failed(store):
    from memos.project_memory.add_view import RelationalProjectView

    runtime = EpisodeAddRuntime(store, Mock(), Mock(), Mock(), RuntimeSettings())
    task = runtime.accept(
        SimpleNamespace(
            user_id="member",
            conversation_id="conversation",
            space_ids=["test"],
            messages=[{"role": "user", "content": "We decided to keep weekly reviews."}],
        )
    )["task_id"]
    RelationalProjectView(store).clear_space_topics("test")
    metrics = runtime.status(task, "member")["memory_views"]["project"]["metrics"]
    (episode,) = metrics["episodes"]
    assert episode["outcome"] == "failed" and not episode["finished_estimated"]
    assert metrics["closed_at"] is not None and metrics["completed_at"] is not None


def test_embedding_backends_without_usage_make_the_bill_incomplete(store):
    from memos.llms.usage import meter_usage

    runtime = EpisodeAddRuntime(
        store,
        Mock(),
        Mock(),
        Mock(),
        RuntimeSettings(),
        embedder=lambda texts: [[0.0, 0.0, 1.0] for _ in texts],
        embedding_model_id="local-embed",
    )
    with meter_usage() as meter:
        runtime.embedder(["text"])
    assert meter.summary()[0]["model"] == "local-embed"
    assert meter.summary()[0]["calls_without_usage"] == 1


def test_upgrade_installs_the_event_table_on_an_existing_schema(store):
    with store.transaction() as cur:
        cur.execute("DROP TABLE add_episode_events")
    upgraded = PostgresAddStore(
        {
            "dsn": os.environ["PG_TEST_DSN"],
            "schema_name": store.schema_name,
            "embedding_dimension": 3,
        },
        project_id="project",
    )
    try:
        with upgraded.transaction(readonly=True) as cur:
            cur.execute("SELECT to_regclass('add_episode_events') IS NOT NULL AS present")
            assert cur.fetchone()["present"]
    finally:
        upgraded.close()
