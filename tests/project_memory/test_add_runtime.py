import os

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from memos.project_memory.add_dispatch import label_for
from memos.project_memory.add_runtime import EpisodeAddRuntime, RuntimeSettings
from memos.project_memory.add_store import PostgresAddStore


@pytest.fixture
def store():
    dsn = os.getenv("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required")
    db = PostgresAddStore(
        {"dsn": dsn, "schema_name": f"add_pipeline_{uuid4().hex}", "embedding_dimension": 3},
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


def test_raw_messages_are_durable_if_queue_submission_fails(store):
    queue = Mock(side_effect=ConnectionError("unavailable"))
    runtime = EpisodeAddRuntime(store, Mock(), queue, Mock(), RuntimeSettings())
    request = SimpleNamespace(
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
