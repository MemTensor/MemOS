"""Add's Topic dicts round-trip through the shared tables via `write_change_set`."""

import os
import uuid

from copy import deepcopy
from datetime import datetime, timezone

import pytest

from memos.project_dbs.item import EntryStatus, TopicChangeSet
from memos.project_dbs.postgres_rows import _ENTRY_COLS, entries_from_rows
from memos.project_dbs.postgres_writer import tuple_cursor, write_change_set
from memos.project_memory.add_layout import (
    child_key,
    current_schema,
    load_topics,
    topic_create,
    topic_update,
)
from memos.project_memory.add_store import PostgresAddStore
from memos.project_memory.decision import OP_JOIN, Plan, apply
from memos.project_memory.types import Decision, DecisionDraft


AT = datetime(2026, 11, 19, 1, tzinfo=timezone.utc)
TOPIC = {
    "id": "placeholder-topic",
    "space_id": "space",
    "domain": "dev",
    "topic_name": "Exports",
    "topic_summary": "Export daily",
    "topic_description": "",
    "create_time": "2026-11-18T01:00:00+00:00",
    "update_time": "2026-11-19T05:00:00+00:00",
    "sources": [{"conversation_id": "c", "user_id": ["alice"], "agent_id": ["codex", "other"]}],
    "anchors": [{"path": "src/export.py", "kind": "file"}],
    "decisions": [
        {
            "id": "placeholder-decision",
            "content": "Export daily.",
            "time": "2026-11-19T01:00:00+00:00",
            "user_ids": ["alice"],
            "user_labels": {"alice": "Alice"},
            "category": "共同约定",
            "source": {"conversation_id": "c", "message_id": "m", "quote": "Export daily."},
            "history": [
                {
                    "content": "Export weekly.",
                    "time": "2026-11-18T01:00:00+00:00",
                    "user_ids": ["alice"],
                    "reason": "",
                }
            ],
            "conflicts": [
                {
                    "seq": 1,
                    "content": "Export hourly.",
                    "time": "2026-11-19T02:00:00+00:00",
                    "user_ids": ["bob"],
                    "source": {"conversation_id": "c", "message_id": "m2", "quote": "Hourly."},
                }
            ],
            "_member_stance_times": {"alice": "2026-11-19T01:00:00+00:00"},
        }
    ],
    "experiences": [
        {
            "id": "placeholder-experience",
            "time": "2026-11-19T03:00:00+00:00",
            "user_ids": ["alice"],
            "card": {"task_intent": "Debug exports", "problem": "Rows lost", "principle": "Read"},
            "exp_status": "candidate",
            "confidence": 0.5,
            "last_supported_at": "",
            "use_count": 2,
            "sources": [
                {"message_id": "m", "chat_time": "", "content": "Read it", "segment_id": "ep"}
            ],
            "history": [],
        }
    ],
    "timeline": [
        {"id": "late", "content": "Second", "time": "2026-11-19T05:00:00+00:00", "user_ids": []},
        {
            "id": "early",
            "content": "First",
            "time": "2026-11-19T04:00:00+00:00",
            "user_ids": ["alice"],
            "episode_id": "ep",
            "source_refs": [{"message_id": "m", "source_path": "/content", "start": 0, "end": 5}],
        },
    ],
}


@pytest.fixture
def store():
    dsn = os.environ.get("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required for the shared schema layout")
    from psycopg2 import sql

    db = PostgresAddStore(
        {"dsn": dsn, "schema_name": f"test_layout_{uuid.uuid4().hex}", "embedding_dimension": 3},
    )
    with db.transaction() as cursor:
        cursor.execute(
            "INSERT INTO spaces (id, project_id, space_name) VALUES ('space', 'project', 'S')"
        )
        cursor.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('domain', 'space', 'dev')"
        )
    try:
        yield db
    finally:
        with db.transaction() as cursor:
            cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(db.schema_name)))
        db.close()


def _write(store, *, creates=(), updates=()):
    with store.transaction() as cursor:
        return write_change_set(
            cursor,
            TopicChangeSet(
                space_id="space", accept_time=AT, creates=list(creates), updates=list(updates)
            ),
            schema=store.schema_name,
        )


def test_entries_round_trip_with_storage_ids_and_chat_time_order(store):
    (created,) = _write(store, creates=[topic_create(TOPIC)])
    assert created.topic_id.startswith("topic_") and len(created.topic_id) == 38
    (topic,) = store.read_topics("space")
    assert topic["id"] == created.topic_id
    assert topic["create_time"].isoformat() == TOPIC["create_time"]
    assert topic["sources"] == [{"conversation_id": "c", "user_id": ["alice"], "agent_id": "codex"}]
    assert "path:src/export.py" in topic["anchor_keys"]
    (decision,) = topic["decisions"]
    assert decision["id"] != "placeholder-decision"
    assert decision["source"]["message_id"] == "m"
    assert decision["category"] == "共同约定"
    assert decision["_member_stance_times"] == {"alice": "2026-11-19T01:00:00+00:00"}
    (old,) = decision["history"]
    (conflict,) = decision["conflicts"]
    assert (old["content"], old["seq"]) == ("Export weekly.", 1)
    assert (conflict["content"], conflict["seq"]) == ("Export hourly.", 1)
    assert old["id"] and conflict["id"]
    assert [row["content"] for row in topic["timeline"]] == ["First", "Second"]
    assert topic["timeline"][0]["message_ids"] == ["m"]
    assert topic["timeline"][0]["role_id"] == "alice"
    (experience,) = topic["experiences"]
    assert experience["card"]["principle"] == "Read"
    assert experience["use_count"] == 2 and experience["version"] == 1
    assert experience["sources"][0]["content"] == "Read it"
    assert experience["sources"][0]["segment_id"] == "ep"
    assert "archived" not in experience


def test_update_writes_only_changed_entries_and_deletes_removed_ones(store):
    _write(store, creates=[topic_create(TOPIC)])
    (base,) = store.read_topics("space")
    proposed = deepcopy(base)
    first, second = proposed["timeline"]
    first["content"] = "First, revised"
    proposed["timeline"] = [first]
    proposed["timeline"].append({"id": "new", "content": "Third", "time": "2026-11-19T06:00:00"})
    proposed["update_time"] = "2026-11-19T06:00:00+00:00"
    with store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT id, version FROM project_entries")
        before = {row["id"]: row["version"] for row in cursor.fetchall()}
    update = topic_update(base, proposed)
    assert [entry.id for entry in update.upsert_entries] == [first["id"], None]
    assert update.delete_entry_ids == [second["id"]]
    _write(store, updates=[update])
    with store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT id, version FROM project_entries")
        after = {row["id"]: row["version"] for row in cursor.fetchall()}
    assert after[first["id"]] == before[first["id"]] + 1
    assert second["id"] not in after
    unchanged = set(before) - {first["id"], second["id"]}
    assert all(after[entry_id] == before[entry_id] for entry_id in unchanged)
    (topic,) = store.read_topics("space")
    assert topic["version"] == 2
    assert [row["content"] for row in topic["timeline"]] == ["First, revised", "Third"]
    assert topic["update_time"].isoformat() == "2026-11-19T06:00:00+00:00"


def test_conflict_ids_survive_the_decision_rules(store):
    """The decision module labels conflicts c1..cn; the child row id travels with the item."""
    _write(store, creates=[topic_create(TOPIC)])
    (base,) = store.read_topics("space")
    stored = base["decisions"][0]
    decision = Decision.from_node(stored["id"], stored["content"], {"project": stored})
    draft = DecisionDraft(
        message_id="m3",
        quote="Hourly is right.",
        content="Export hourly.",
        user_id="carol",
        name="Carol",
        time="2026-11-19T07:00:00+00:00",
    )
    joined, _ = apply(decision, Plan(action=OP_JOIN, same_as="c1"), draft, "c")
    proposed = deepcopy(base)
    proposed["decisions"] = [{"id": joined.id, **joined.to_project()}]
    vectors = {child_key(joined.id, "c", 1): [0.0, 1.0, 0.0]}
    (upsert,) = topic_update(base, proposed, vectors=vectors).upsert_entries
    assert upsert.conflicts[0].id == stored["conflicts"][0]["id"]
    _write(store, updates=[topic_update(base, proposed, vectors=vectors)])
    (topic,) = store.read_topics("space")
    (conflict,) = topic["decisions"][0]["conflicts"]
    assert conflict["id"] == stored["conflicts"][0]["id"]
    assert conflict["user_ids"] == ["bob", "carol"]
    with store.transaction(readonly=True) as cursor:
        cursor.execute(
            "SELECT embedding::text AS vector FROM project_entries WHERE id = %s", (conflict["id"],)
        )
        assert cursor.fetchone()["vector"] == "[0,1,0]"


def test_retired_experience_is_archived_and_rows_validate_with_the_storage_models(store):
    retired = deepcopy(TOPIC)
    retired["experiences"][0]["confidence"] = 0.05
    _write(store, creates=[topic_create(retired)])
    with store.transaction() as cursor:
        schema = current_schema(cursor)
        with tuple_cursor(cursor) as plain:
            plain.execute(
                f"SELECT {_ENTRY_COLS} FROM project_entries e WHERE e.parent_decision_id IS NULL"
            )
            entries = entries_from_rows(plain, plain.fetchall(), True, schema=schema)
        (topic,) = load_topics(cursor, "s.project_id = %s", ("project",))
    by_type = {entry.entry_type: entry for entry in entries}
    experience = by_type["experience"]
    assert experience.status == EntryStatus.ARCHIVED
    assert experience.extra.confidence == 0.1
    assert experience.content == "Debug exports｜Rows lost｜Read"
    assert experience.extra.last_supported_at is None
    assert experience.extra.sources[0].quote == "Read it"
    assert experience.extra.sources[0].episode_id == "ep"
    assert by_type["decision"].extra.sources[0].message_id == "m"
    assert topic["experiences"][0]["archived"] is True
