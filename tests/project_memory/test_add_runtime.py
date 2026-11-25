import os

from types import SimpleNamespace
from unittest.mock import Mock, call
from uuid import uuid4

import pytest

from memos.project_memory.add_dispatch import label_for
from memos.project_memory.add_runtime import EpisodeAddRuntime, RuntimeSettings
from memos.project_memory.add_store import PostgresAddStore
from memos.project_memory.judge import ModelError


@pytest.fixture
def store():
    dsn = os.getenv("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required")
    db = PostgresAddStore(
        {"dsn": dsn, "schema_name": f"add_pipeline_{uuid4().hex}", "embedding_dimension": 3},
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


def test_raw_messages_are_durable_if_queue_submission_fails(store):
    queue = Mock(side_effect=ConnectionError("unavailable"))
    runtime = EpisodeAddRuntime(store, Mock(), queue, Mock(), RuntimeSettings())
    request = SimpleNamespace(
        project_id="project",
        user_id="member",
        space_ids=["test"],
        messages=[{"role": "user", "content": "We use the new API."}],
    )

    accepted = runtime.accept(request)

    assert accepted["status"] == "running"
    assert runtime.status(accepted["task_id"], "other") is None
    assert runtime.status(accepted["task_id"], "member")["status"] == "in_progress"
    due = runtime.dispatch.due(runtime.now(), stale_seconds=60)
    assert len(due) == 1 and label_for(due[0]) == "project_add_process"
    assert store.load_episode(due[0]["id"])["messages"][0]["content"] == "We use the new API."


def test_recover_merge_handoff_and_lost_commit_reply(store, monkeypatch):
    from redis import Redis

    from memos.project_memory import add_runtime

    redis_url = os.getenv("REDIS_TEST_URL")
    if not redis_url:
        pytest.skip("REDIS_TEST_URL is required")
    client = Redis.from_url(redis_url)
    hub = Mock()
    work = []
    lost = {"project_add_merge_result", "commit_reply"}

    def submit(batch):
        if batch[0].label in lost:
            lost.remove(batch[0].label)
            raise ConnectionError("injected publish interruption")
        work.extend(batch)

    quote = "We decided to run daily checks."

    def write(scope, _prompt, inputs):
        if scope == "episode.extract":
            return {
                "episode_summary": "Daily checks",
                "drafts": [
                    {"kind": "decision", "message_id": "user-1", "quote": quote, "content": quote}
                ],
            }
        if scope == "episode.formation":
            return {
                "clusters": [
                    {
                        "episode_ids": [inputs["episodes"][0]["id"]],
                        "domain": "product",
                        "name": "Daily checks",
                        "independently_deliverable": True,
                        "affects_existing_decisions": False,
                    }
                ]
            }
        if scope == "episode.metadata":
            return {"summary": "Daily checks", "description": quote}
        raise AssertionError(f"Unexpected model operation {scope}")

    hub.write.side_effect = write
    runtime = EpisodeAddRuntime(store, hub, submit, client, RuntimeSettings(formation_count=1))
    task = runtime.accept(
        SimpleNamespace(
            project_id="project",
            user_id="member",
            space_ids=["test"],
            messages=[{"message_id": "user-1", "role": "user", "content": quote}],
        )
    )
    commit = add_runtime.commit_changeset

    def commit_with_lost_reply(*args, **kwargs):
        result = commit(*args, **kwargs)
        if "commit_reply" in lost:
            lost.remove("commit_reply")
            raise ConnectionError("injected commit reply interruption")
        return result

    monkeypatch.setattr(add_runtime, "commit_changeset", commit_with_lost_reply)

    seen = []
    while work:
        message = work.pop(0)
        seen.append(message)
        runtime.handle([message])
    assert [message.label for message in seen] == [
        "project_add_process",
        "project_add_space",
        "project_add_merge",
    ]
    assert runtime.status(task["task_id"], "member")["status"] == "in_progress"

    # A different worker can publish and apply the same durable prepared ChangeSet.
    worker = EpisodeAddRuntime(store, hub, submit, client)
    worker.recover()
    assert len(work) == 1
    worker.handle(work + seen)
    assert not lost
    status = worker.status(task["task_id"], "member")
    assert status["status"] == "completed"
    topics = store.read_topics("test")
    assert len(topics) == 1
    assert status["memory_views"]["project"]["memory_ids"] == [topics[0]["id"]]
    assert len(topics[0]["decisions"]) == 1


def test_formation_reuses_committed_topic_for_another_staged_domain(store, monkeypatch):
    from redis import Redis

    redis_url = os.getenv("REDIS_TEST_URL")
    if not redis_url:
        pytest.skip("REDIS_TEST_URL is required")
    client = Redis.from_url(redis_url)
    with store.transaction() as cur:
        cur.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('reliability','test','reliability')"
        )

    hub = Mock()
    work = []
    original = "We set the connection pool size to 8."
    conflict = "I recommend the connection pool size be 16."

    def write(scope, _prompt, inputs):
        if scope == "episode.extract":
            (message,) = inputs["episode"]
            return {
                "episode_summary": message["content"],
                "drafts": [
                    {
                        "kind": "decision",
                        "message_id": message["id"],
                        "quote": message["content"],
                        "content": message["content"],
                    }
                ],
            }
        if scope == "episode.assign":
            return {"action": "stage"}
        if scope == "episode.assign.batch":
            (row,) = inputs["episodes"]
            (target,) = row["candidates"]
            return {
                "assignments": [
                    {
                        "episode_id": row["episode_id"],
                        "action": "attach",
                        "topic_id": target["id"],
                        "relationship": "same_work",
                        "same_deliverable": True,
                        "positive_basis": "same_goal",
                        "independently_deliverable": False,
                        "affects_existing_decisions": True,
                    }
                ]
            }
        if scope == "episode.formation":
            return {
                "clusters": [
                    {
                        "episode_ids": [ep["id"]],
                        "domain": "reliability",
                        "name": "Connection pool",
                        "independently_deliverable": True,
                        "affects_existing_decisions": False,
                    }
                    for ep in inputs["episodes"]
                    if ep["domains"] == ["reliability"]
                ]
            }
        if scope == "dec.update":
            (target,) = inputs["decisions"]
            return {
                "results": [
                    {"n": 1, "decision_id": target["id"], "same_as": None, "action": "rewrite"}
                ]
            }
        if scope == "episode.metadata":
            return {"summary": "Connection pool size", "description": "Connection pool size"}
        raise AssertionError(f"Unexpected model operation {scope}")

    hub.write.side_effect = write
    seed = EpisodeAddRuntime(store, hub, work.extend, client, RuntimeSettings(formation_count=1))
    runtime = EpisodeAddRuntime(store, hub, work.extend, client, RuntimeSettings(formation_count=2))
    read_topics = Mock(wraps=store.read_topics)
    monkeypatch.setattr(store, "read_topics", read_topics)

    def add(worker, user, domain, content):
        task = worker.accept(
            SimpleNamespace(
                project_id="project",
                user_id=user,
                space_ids=["test"],
                domains=[domain],
                messages=[{"message_id": user, "role": "user", "content": content}],
            )
        )
        while work:
            worker.handle([work.pop(0)])
        assert worker.status(task["task_id"], user)["status"] == "completed"

    with client:
        add(seed, "owner", "reliability", original)
        (topic_before,) = store.read_topics("test")
        read_topics.reset_mock()
        add(runtime, "member", "reliability", conflict)
        assert read_topics.call_args_list == [call("test", ["reliability"])]
        (old,) = store.read_staged("test")
        read_topics.reset_mock()
        add(runtime, "organizer", "product", "The release announcement is approved.")
        assert read_topics.call_args_list == [
            call("test", ["product"]),
            call("test", ["reliability"]),
        ]

    topics = store.read_topics("test")
    assert len(topics) == 1
    (topic_after,) = topics
    assert topic_after["id"] == topic_before["id"]
    assert topic_after["version"] == topic_before["version"] + 1
    (decision,) = topic_after["decisions"]
    assert decision["id"] == topic_before["decisions"][0]["id"]
    assert decision["content"] == original
    (alternative,) = decision["conflicts"]
    assert alternative["content"] == conflict
    assert alternative["user_ids"] == ["member"]
    moved = store.load_episode(old["id"])
    assert moved["staged_status"] == "moved"
    assert moved["moved_to_topic_id"] == topic_before["id"]


def test_episode_lifecycle_events_carry_stage_usage(store):
    from memos.llms.usage import CHAT, record_usage

    queue = []
    hub = Mock()

    def write(scope, _prompt, _inputs):
        record_usage(CHAT, "chat-m", {"prompt_tokens": 40, "completion_tokens": 2})
        return {"episode_summary": "", "drafts": []}

    hub.write.side_effect = write
    runtime = EpisodeAddRuntime(store, hub, queue.extend, Mock(), RuntimeSettings())
    runtime.accept(
        SimpleNamespace(
            user_id="member",
            space_ids=["test"],
            messages=[{"role": "user", "content": "We decided to keep weekly reviews."}],
        )
    )
    runtime.handle([queue.pop()])

    with store.transaction(readonly=True) as cur:
        cur.execute("SELECT event, stage, detail FROM add_episode_events ORDER BY at, id")
        events = cur.fetchall()
    assert [row["event"] for row in events] == [
        "opened",
        "turn",
        "closed",
        "published",
        "claimed",
        "finished",
        "stage_done",
    ]
    assert events[1]["detail"]["chars"] == len("We decided to keep weekly reviews.")
    assert events[2]["detail"] == {"reason": "no_conversation"}
    assert events[3]["detail"] == {"label": "project_add_process"}
    done = events[-1]["detail"]
    assert done["next_stage"] == "done" and done["outcome"] == "skipped"
    assert done["usage"][0]["total_tokens"] == 42
    assert events[-2]["detail"]["outcome"] == "skipped"


def _staging_hub(formation_ids=None, *, cluster=True, formation_error=False):
    """A hub that stages every Episode and clusters all of them when asked."""
    hub = Mock()

    def write(scope, _prompt, inputs):
        if scope == "episode.extract":
            (message,) = inputs["episode"]
            return {
                "episode_summary": "connection pool sizing " + message["content"],
                "drafts": [
                    {
                        "kind": "decision",
                        "message_id": message["id"],
                        "quote": message["content"],
                        "content": message["content"],
                    }
                ],
            }
        if scope in {"episode.assign", "episode.assign.batch"}:
            rows = inputs.get("episodes")
            if rows is None:
                return {"action": "stage"}
            return {
                "assignments": [{"episode_id": r["episode_id"], "action": "stage"} for r in rows]
            }
        if scope == "episode.formation":
            if formation_error:
                raise ModelError("Formation down")
            if not cluster:
                return {"clusters": []}
            ids = [ep["id"] for ep in inputs["episodes"]]
            return {
                "clusters": [
                    {
                        "episode_ids": ids,
                        "domain": "product",
                        "name": "Connection pool sizing",
                        "independently_deliverable": True,
                        "affects_existing_decisions": False,
                    }
                ]
            }
        if scope == "dec.update":
            return {
                "results": [
                    {"n": row["n"], "decision_id": None, "same_as": None, "action": "add"}
                    for row in inputs["new"]
                ]
            }
        if scope == "episode.metadata":
            return {"summary": "Connection pool", "description": "Connection pool sizing"}
        raise AssertionError(f"Unexpected model operation {scope}")

    hub.write.side_effect = write
    return hub


def _add(runtime, work, user, content):
    runtime.accept(
        SimpleNamespace(
            user_id=user,
            conversation_id=f"conv-{user}",
            space_ids=["test"],
            domains=["product"],
            messages=[{"message_id": user, "role": "user", "content": content}],
        )
    )
    while work:
        runtime.handle([work.pop(0)])


def test_flush_closes_open_episodes_and_forms_the_tail_batch(store):
    from redis import Redis

    redis_url = os.getenv("REDIS_TEST_URL")
    if not redis_url:
        pytest.skip("REDIS_TEST_URL is required")
    work = []
    runtime = EpisodeAddRuntime(
        store, _staging_hub(), work.extend, Redis.from_url(redis_url), RuntimeSettings()
    )
    _add(runtime, work, "alice", "Pool size is 8 connections.")
    _add(runtime, work, "bob", "Keep the pool at 8 connections per worker.")

    first = runtime.flush("test")
    assert len(first["closed_episode_ids"]) == 2
    assert first["formation"]["reason"] == "EPISODES_IN_FLIGHT"
    while work:
        runtime.handle([work.pop(0)])
    assert len(store.read_staged("test")) == 2

    second = runtime.flush("test")
    assert second["pending_episode_ids"] == []
    formation = second["formation"]
    assert formation["ran"] is True and formation["formation_version"] == 1
    (topic,) = store.read_topics("test")
    assert formation["created_topic_ids"] == [topic["id"]]
    assert sorted(formation["moved"].values()) == [topic["id"], topic["id"]]
    assert store.read_staged("test") == []
    assert len(topic["decisions"]) >= 1
    assert second["staged_remaining"] == 0
    assert runtime.flush("test")["formation"]["reason"] == "NO_STAGED"


def test_quiet_space_forms_staged_episodes_only_after_the_interval(store):
    from datetime import timedelta

    from redis import Redis

    redis_url = os.getenv("REDIS_TEST_URL")
    if not redis_url:
        pytest.skip("REDIS_TEST_URL is required")
    work = []
    runtime = EpisodeAddRuntime(
        store,
        _staging_hub(),
        work.extend,
        Redis.from_url(redis_url),
        RuntimeSettings(formation_interval=3600),
    )
    _add(runtime, work, "alice", "Pool size is 8 connections.")
    _add(runtime, work, "bob", "Keep the pool at 8 connections per worker.")
    runtime.acceptance.close_open("test")
    for episode in runtime.dispatch.due(runtime.now(), stale_seconds=0):
        runtime._publish(episode["id"])
    while work:
        runtime.handle([work.pop(0)])
    assert len(store.read_staged("test")) == 2

    assert runtime.form_due_spaces() == []
    assert runtime.form_space("test")["reason"] == "NOT_DUE"
    later = runtime.now() + timedelta(hours=2)
    runtime.now = lambda: later
    (formed,) = runtime.form_due_spaces()
    assert formed["ran"] is True
    assert store.read_staged("test") == []


def _settled_runtime(store, hub, **settings):
    from redis import Redis

    redis_url = os.getenv("REDIS_TEST_URL")
    if not redis_url:
        pytest.skip("REDIS_TEST_URL is required")
    client = Redis.from_url(redis_url)
    client.delete(*client.keys("project_formation_*") or ["none"])
    work = []
    runtime = EpisodeAddRuntime(store, hub, work.extend, client, RuntimeSettings(**settings))
    _add(runtime, work, "alice", "Pool size is 8 connections.")
    _add(runtime, work, "bob", "Keep the pool at 8 connections per worker.")
    runtime.flush("test")
    while work:
        runtime.handle([work.pop(0)])
    return runtime, client


def test_forced_flush_does_not_age_unclustered_episodes(store):
    runtime, _ = _settled_runtime(store, _staging_hub(cluster=False))
    for _ in range(4):
        result = runtime.flush("test")
        assert result["formation"]["ran"] is True
    staged = store.read_staged("test")
    assert len(staged) == 2 and {ep["staged_attempts"] for ep in staged} == {0}
    assert result["staged_remaining"] == 2


def test_failed_quiet_formation_backs_off_but_flush_still_runs(store):
    from datetime import timedelta

    runtime, client = _settled_runtime(
        store, _staging_hub(formation_error=True), formation_interval=3600
    )
    later = runtime.now() + timedelta(hours=2)
    runtime.now = lambda: later
    assert runtime.form_due_spaces() == []
    assert client.exists(runtime._formation_key("backoff", "test"))
    assert runtime.form_space("test")["reason"] == "BACKING_OFF"
    assert runtime.flush("test")["formation"]["reason"] == "FORMATION_MODEL_UNAVAILABLE"


def test_concurrent_formation_planning_is_skipped(store):
    runtime, client = _settled_runtime(store, _staging_hub())
    client.set(runtime._formation_key("planning", "test"), "other", ex=60)
    try:
        assert runtime.flush("test")["formation"]["reason"] == "FORMATION_RUNNING"
    finally:
        client.delete(runtime._formation_key("planning", "test"))
    assert runtime.flush("test")["formation"]["ran"] is True
