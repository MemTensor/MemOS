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
    store = PostgresAddStore(
        {"dsn": dsn, "schema_name": schema, "embedding_dimension": 3}, project_id="project-a"
    )
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
            "topic_items",
            "messages",
            "episodes",
            "episode_turns",
        }

    with pytest.raises(ValueError, match="abort"), add_store.transaction() as cursor:
        cursor.execute(
            "INSERT INTO spaces (id, project_id, space_name) VALUES ('space-a', 'project-a', 'A')"
        )
        raise ValueError("abort")

    assert add_store.read_space("space-a") is None


def test_reads_stay_in_project_scope(add_store):
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

    assert add_store.read_space("space-a")["space_name"] == "space-a"
    assert add_store.read_space("space-b") is None
    assert [topic["id"] for topic in add_store.read_topics("space-a", ["development"])] == [
        "space-a-topic"
    ]
    assert add_store.read_topics("space-a", topic_ids=[]) == []
    assert add_store.read_topics("space-b") == []


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
        cursor.execute(
            "UPDATE episodes SET state='extracted', stage='done', outcome='committed', result=%s WHERE id=%s",
            (json_value({"topic_ids": ["older-topic"]}), older_id),
        )
        cursor.execute(
            """UPDATE episodes SET state='extracted', stage='done', outcome=%s, result=%s,
                       staged_status=%s, staged_at=CASE WHEN %s THEN now() END WHERE id=%s""",
            (
                "staged" if moved else "committed",
                json_value({"topic_ids": prior_topics}),
                "active" if moved else None,
                moved,
                prior_id,
            ),
        )
        cursor.execute(
            """UPDATE episodes SET state='extracted', stage='done', outcome='staged',
                       staged_status='active', staged_at=now(), episode_summary='Follow-up notes'
               WHERE id=%s""",
            (staged_id,),
        )
    original_status = acceptance.status("original-task", "member")
    assert original_status["memory_views"]["project"]["memory_ids"] == prior_topics
    if moved:
        with add_store.transaction() as cursor:
            cursor.execute(
                """UPDATE episodes SET staged_status='moved', moved_to_topic_id='prior-topic'
                   WHERE id=%s""",
                (prior_id,),
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
    assert acceptance.status("original-task", "member") == original_status
