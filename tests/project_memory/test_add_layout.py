"""Add's rows in the shared project memory schema stay readable by `memos.project_dbs`."""

import os
import uuid

import pytest

from memos.project_dbs.postgres import _ENTRY_COLS, _TOPIC_COLS, PostgresProjectDB
from memos.project_memory.add_layout import load_topics, write_entries
from memos.project_memory.add_store import PostgresAddStore, json_value


TOPIC = {
    "id": "topic",
    "space_id": "space",
    "topic_name": "Exports",
    "topic_summary": "Export daily",
    "topic_description": "",
    "update_time": "2026-11-19T01:00:00+00:00",
    "decisions": [
        {
            "id": "decision",
            "content": "Export daily.",
            "time": "2026-11-19T01:00:00+00:00",
            "user_ids": ["alice"],
            "user_labels": {"alice": "Alice"},
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
                    "content": "Export hourly.",
                    "time": "2026-11-19T02:00:00+00:00",
                    "user_ids": ["bob"],
                }
            ],
            "_member_stance_times": {"alice": "2026-11-19T01:00:00+00:00"},
        }
    ],
    "experiences": [
        {
            "id": "experience",
            "time": "2026-11-19T03:00:00+00:00",
            "user_ids": ["alice"],
            "card": {
                "task_intent": "Debug exports",
                "problem": "Rows lost",
                "principle": "Read code",
            },
            "status": "candidate",
            "confidence": 0.5,
            "last_supported_at": "",
            "sources": [{"message_id": "m", "chat_time": ""}],
            "history": [],
        }
    ],
    "timeline": [
        {"id": "late", "content": "Second", "time": "2026-11-19T05:00:00+00:00", "user_ids": []},
        {"id": "early", "content": "First", "time": "2026-11-19T04:00:00+00:00", "user_ids": []},
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
        cursor.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                                   topic_description, sources)
               VALUES ('topic', 'space', 'domain', 'Exports', 'Export daily', '', %s)""",
            (json_value([{"user_id": ["alice"], "conversation_id": "c"}]),),
        )
    try:
        yield db
    finally:
        with db.transaction() as cursor:
            cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(db.schema_name)))
        db.close()


def test_entries_round_trip_and_keep_list_order(store):
    with store.transaction() as cursor:
        write_entries(cursor, TOPIC)
        (topic,) = load_topics(cursor, "s.project_id = %s", ("project",))
    (decision,) = topic["decisions"]
    assert decision["conflicts"][0]["content"] == "Export hourly."
    assert decision["history"][0]["content"] == "Export weekly."
    assert decision["_member_stance_times"] == {"alice": "2026-11-19T01:00:00+00:00"}
    assert [row["id"] for row in topic["timeline"]] == ["late", "early"]
    assert topic["experiences"][0]["card"]["principle"] == "Read code"


def test_rewrite_bumps_only_changed_entries_and_deletes_removed_ones(store):
    with store.transaction() as cursor:
        write_entries(cursor, TOPIC)
        changed = {**TOPIC, "timeline": [{**TOPIC["timeline"][0], "content": "Second, revised"}]}
        write_entries(cursor, changed)
        cursor.execute("SELECT id, version FROM project_entries ORDER BY id")
        assert {row["id"]: row["version"] for row in cursor.fetchall()} == {
            "decision": 1,
            "experience": 1,
            "late": 2,
        }


def test_rows_validate_with_the_storage_layer_models(store):
    with store.transaction() as cursor:
        write_entries(cursor, TOPIC)
        plain = cursor.connection.cursor()
        plain.execute(f"SELECT {_TOPIC_COLS} FROM topics t JOIN domains d ON d.id = t.domain_id")
        topic = PostgresProjectDB._topic(plain.fetchone())
        plain.execute(f"SELECT {_ENTRY_COLS} FROM project_entries e ORDER BY e.id")
        entries = [PostgresProjectDB._entry(row) for row in plain.fetchall()]
    assert topic.domain == "dev"
    by_id = {entry.id: entry for entry in entries}
    assert by_id["decision"].conflicts[0].content == "Export hourly."
    assert by_id["experience"].content == "Debug exports｜Rows lost｜Read code"
    assert by_id["experience"].extra.last_supported_at is None
