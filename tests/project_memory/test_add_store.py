from __future__ import annotations

import os
import uuid

import pytest

from memos.project_memory.add_store import PostgresAddStore


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
