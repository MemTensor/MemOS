from __future__ import annotations

import os
import uuid

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.project_memory.add_acceptance import AcceptanceSettings, AddAcceptance
from memos.project_memory.add_algorithm import organize_episode, recall_candidates
from memos.project_memory.add_store import PostgresAddStore, json_value


@pytest.fixture
def add_store():
    dsn = os.getenv("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required for the relational project memory tests")
    schema = f"test_add_{uuid.uuid4().hex}"
    store = PostgresAddStore({"dsn": dsn, "schema_name": schema, "embedding_dimension": 3})
    try:
        yield store
    finally:
        with store.transaction() as cursor:
            cursor.execute(f'DROP SCHEMA "{schema}" CASCADE')
        store.close()


def test_schema_and_rollback(add_store):
    with add_store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
        assert {row["tablename"] for row in cursor.fetchall()} == {
            "spaces",
            "domains",
            "topics",
            "project_entries",
            "add_jobs",
            "add_episode_events",
            "messages",
            "episodes",
        }

    with pytest.raises(ValueError, match="abort"), add_store.transaction() as cursor:
        cursor.execute(
            "INSERT INTO spaces (id, project_id, space_name) VALUES ('space-a', 'project-a', 'A')"
        )
        raise ValueError("abort")

    assert add_store.read_space("space-a") is None


def test_reads_follow_the_space_across_projects(add_store):
    """One store serves every project: reads go by Space, and each row keeps its own project."""
    with add_store.transaction() as cursor:
        for space, project in [("space-a", "project-a"), ("space-b", "project-b")]:
            cursor.execute(
                "INSERT INTO spaces (id, project_id, space_name) VALUES (%s, %s, %s)",
                (space, project, space),
            )
            cursor.execute(
                "INSERT INTO domains (id, space_id, domain) VALUES (%s, %s, 'development')",
                (f"{space}-domain", space),
            )
            cursor.execute(
                """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                                       topic_description, create_time, update_time)
                   VALUES (%s, %s, %s, 'Release', '', '', now(), now())""",
                (f"{space}-topic", space, f"{space}-domain"),
            )

    assert add_store.read_space("space-a")["project_id"] == "project-a"
    assert add_store.read_space("space-b")["project_id"] == "project-b"
    assert add_store.read_space("missing") is None
    assert [topic["id"] for topic in add_store.read_topics("space-a", ["development"])] == [
        "space-a-topic"
    ]
    assert add_store.read_topics("space-a", topic_ids=[]) == []
    assert [topic["id"] for topic in add_store.read_topics("space-b")] == ["space-b-topic"]


@pytest.mark.parametrize("moved", [False, True], ids=["committed", "moved"])
def test_formation_recalls_immediate_predecessor_without_changing_task_receipt(add_store, moved):
    with add_store.transaction() as cursor:
        cursor.execute(
            "INSERT INTO spaces (id, project_id, space_name) VALUES ('space-a', 'project-a', 'A')"
        )
        cursor.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('dev', 'space-a', 'development')"
        )
        cursor.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                                   topic_description, create_time, update_time)
               VALUES ('prior-topic', 'space-a', 'dev', 'Database caching', '', '', now(), now()),
                      ('older-topic', 'space-a', 'dev', 'Database logging', '', '', now(), now())"""
        )

    acceptance = AddAcceptance(add_store, AcceptanceSettings(max_turns=1))

    def accept(task_id):
        (eid,) = acceptance.accept(
            SimpleNamespace(
                project_id="project-a",
                task_id=task_id,
                user_id="member",
                space_ids=["space-a"],
                conversation_id="session",
                messages=[{"message_id": task_id, "role": "user", "content": "Check the result."}],
            )
        ).closed_episode_ids
        return eid

    older_id = accept("older-task")
    prior_id = accept("original-task")
    staged_id = accept("follow-up-task")
    prior_topics = [] if moved else ["prior-topic"]
    with add_store.transaction() as cursor:

        def finish(episode_id, outcome, topic_ids, staged=None, summary=None):
            result = {"extraction": {"at": "2026-11-19T00:00:00+00:00"}}
            if staged:
                result["staged"] = {"status": staged, "at": "2026-11-19T00:00:00+00:00"}
            cursor.execute(
                """UPDATE add_jobs SET stage = 'done', outcome = %s, topic_ids = %s,
                          organize_result = organize_result || %s WHERE episode_id = %s""",
                (outcome, topic_ids, json_value(result), episode_id),
            )
            cursor.execute(
                "UPDATE episodes SET topic_id = %s, episode_summary = %s WHERE id = %s",
                (topic_ids[0] if topic_ids else None, summary, episode_id),
            )

        finish(older_id, "committed", ["older-topic"])
        finish(
            prior_id,
            "staged" if moved else "committed",
            prior_topics,
            staged="active" if moved else None,
        )
        finish(staged_id, "staged", [], staged="active", summary="Follow-up notes")
    original_status = acceptance.status("original-task", "member")
    assert original_status["memory_views"]["project"]["memory_ids"] == prior_topics
    if moved:
        # Formation moves the prior Episode: outcome committed, its Topic set, receipt kept.
        with add_store.transaction() as cursor:
            cursor.execute(
                """UPDATE add_jobs SET outcome = 'committed', organize_result = organize_result
                          || '{"staged": {"status": "moved", "moved_to": "prior-topic"}}'
                   WHERE episode_id = %s""",
                (prior_id,),
            )
            cursor.execute(
                "UPDATE episodes SET topic_id = 'prior-topic' WHERE id = %s", (prior_id,)
            )

    (staged,) = add_store.read_staged("space-a")
    assert staged["id"] == staged_id
    assert staged["previous_episode_id"] == prior_id
    topics = add_store.read_topics("space-a")
    (direct,) = recall_candidates(add_store.load_episode(staged_id), topics)
    assert direct["id"] == "prior-topic"
    assert direct["recall"]["previous"]
    writer = Mock()
    writer.write.side_effect = [
        {
            "assignments": [
                {
                    "episode_id": staged_id,
                    "action": "attach",
                    "topic_id": "prior-topic",
                    "relationship": "same_work",
                    "same_deliverable": True,
                    "positive_basis": "previous_episode",
                    "independently_deliverable": False,
                    "affects_existing_decisions": True,
                }
            ]
        },
        {"clusters": []},
    ]
    plan = organize_episode(
        writer,
        {"id": "trigger", "space_id": "space-a", "domains": ["development"]},
        [],
        [staged],
        {"id": "space-a"},
        now=datetime.now(timezone.utc),
        formation_count=1,
        all_topics=topics,
    )
    assert [args.args[0] for args in writer.write.call_args_list] == [
        "episode.assign.batch",
        "episode.formation",
    ]
    (candidate,) = writer.write.call_args_list[0].args[2]["episodes"][0]["candidates"]
    assert candidate["recall"]["previous"] and candidate["recall"]["must_consider"]
    (assignment,) = plan["assignments"]
    assert assignment["topic"]["id"] == "prior-topic"
    assert [episode["id"] for episode in assignment["episodes"]] == [staged_id]
    # The move changes the Episode's outcome, not the Task's receipt.
    after = acceptance.status("original-task", "member")
    assert after["status"] == original_status["status"]
    assert after["memory_views"]["project"]["memory_ids"] == prior_topics


def test_an_installed_zh_configuration_is_used_without_zhparser():
    dsn = os.getenv("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required for the relational project memory tests")
    schema = f"test_add_{uuid.uuid4().hex}"
    config = {"dsn": dsn, "schema_name": schema, "embedding_dimension": 3}
    with pytest.raises(RuntimeError, match="zhparser"):
        PostgresAddStore({**config, "text_search_parser": "zhparser"})
    PostgresAddStore({**config, "text_search_parser": "simple"}).close()
    store = PostgresAddStore({**config, "text_search_parser": "zhparser"})
    try:
        with store.transaction(readonly=True) as cursor:
            cursor.execute("SELECT to_regclass(%s) AS present", (f"{schema}.project_entries",))
            assert cursor.fetchone()["present"] is not None
    finally:
        with store.transaction() as cursor:
            cursor.execute(f'DROP SCHEMA "{schema}" CASCADE')
        store.close()
