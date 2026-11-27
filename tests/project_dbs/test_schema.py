"""PostgreSQL-only checks of postgres_init.sql constraints, run in a scratch schema."""

import pytest

from tests.project_dbs.conftest import DIM


S = "pm_ddl_test"


@pytest.fixture
def cur(pg_conn, scratch_schema):
    from memos.project_dbs.postgres import render_ddl

    scratch_schema(S)
    ddl = render_ddl(DIM, "simple", schema=S)
    with pg_conn.cursor() as c:
        c.execute(ddl)
        c.execute(ddl)  # idempotent
        c.execute(f"INSERT INTO {S}.spaces (id, project_id, space_name) VALUES ('sp', 'p', 'n')")
        c.execute(f"INSERT INTO {S}.domains (id, space_id, domain) VALUES ('dm', 'sp', 'dev')")
        for topic in ("t1", "t2"):
            c.execute(
                f"""INSERT INTO {S}.topics (id, space_id, domain_id, topic_name, topic_summary,
                        topic_description, create_time, update_time)
                    VALUES (%s, 'sp', 'dm', 'n', 's', 'd', now(), now())""",
                (topic,),
            )
        yield c


def entry(c, entry_id, entry_type="decision", status=0, parent=None, topic="t1"):
    c.execute(
        f"""INSERT INTO {S}.project_entries (id, topic_id, space_id, entry_type, status,
                parent_decision_id, content, chat_time)
            VALUES (%s, %s, 'sp', %s, %s, %s, 'c', now())""",
        (entry_id, topic, entry_type, status, parent),
    )


def violates(c, error_name, sql, params=()):
    import psycopg2

    with pytest.raises(psycopg2.Error) as info:  # autocommit: nothing to roll back
        c.execute(sql, params)
    assert type(info.value).__name__ == error_name, info.value


def test_tables_and_defaults(cur):
    cur.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = %s "
        "ORDER BY table_name",
        (S,),
    )
    assert [r[0] for r in cur.fetchall()] == [
        "domains",
        "episodes",
        "messages",
        "project_entries",
        "spaces",
        "topics",
        "turns",
    ]
    cur.execute(f"SELECT resource_bindings, formation_version, clear_time FROM {S}.spaces")
    assert cur.fetchone() == ([], 0, None)
    cur.execute(
        f"SELECT conversation_ids, anchor_keys, version, extra FROM {S}.topics WHERE id = 't1'"
    )
    assert cur.fetchone() == ([], [], 1, {})


def test_topic_chat_times_have_no_default(cur):
    violates(
        cur,
        "NotNullViolation",
        f"""INSERT INTO {S}.topics (id, space_id, domain_id, topic_name, topic_summary,
                topic_description, update_time) VALUES ('t3', 'sp', 'dm', 'n', 's', 'd', now())""",
    )


def test_entry_status_and_child_row_checks(cur):
    entry(cur, "d1")
    entry(cur, "a1", status=1, parent="d1")
    entry(cur, "c1", status=2, parent="d1")
    entry(cur, "x1", "experience", status=1)  # retired experience: no parent
    insert = f"""INSERT INTO {S}.project_entries (id, topic_id, space_id, entry_type, status,
                     parent_decision_id, content, chat_time)
                 VALUES (%s, %s, 'sp', %s, %s, %s, 'c', now())"""
    violates(cur, "CheckViolation", insert, ("e1", "t1", "decision", 3, None))
    violates(cur, "CheckViolation", insert, ("e2", "t1", "decision", 1, None))  # orphan child
    violates(cur, "CheckViolation", insert, ("e3", "t1", "decision", 0, "d1"))  # active child
    violates(cur, "CheckViolation", insert, ("e4", "t1", "timeline", 2, None))  # conflict
    violates(cur, "CheckViolation", insert, ("e5", "t1", "note", 0, None))
    violates(cur, "ForeignKeyViolation", insert, ("e6", "t2", "decision", 1, "d1"))  # other topic
    cur.execute(f"DELETE FROM {S}.project_entries WHERE id = 'd1'")
    cur.execute(f"SELECT id FROM {S}.project_entries ORDER BY id")
    assert [r[0] for r in cur.fetchall()] == ["x1"]  # children cascaded


def test_entries_cascade_with_topic(cur):
    entry(cur, "d1")
    entry(cur, "a1", status=1, parent="d1")
    cur.execute(f"DELETE FROM {S}.topics WHERE id = 't1'")
    cur.execute(f"SELECT count(*) FROM {S}.project_entries")
    assert cur.fetchone()[0] == 0


def episode(c, episode_id, start, end, conversation="c1", topic=None):
    c.execute(
        f"""INSERT INTO {S}.episodes (id, space_id, conversation_key, message_seq_start,
                message_seq_end, topic_id, first_chat_time, last_chat_time)
            VALUES (%s, 'sp', %s, %s, %s, %s, now(), now())""",
        (episode_id, conversation, start, end, topic),
    )


def test_episode_ranges_do_not_overlap(cur):
    episode(cur, "e1", 1, 5, topic="t1")
    episode(cur, "e2", 6, 6)  # adjacent is fine
    episode(cur, "e3", 3, 4, conversation="c2")  # another conversation
    insert = f"""INSERT INTO {S}.episodes (id, space_id, conversation_key, message_seq_start,
                     message_seq_end, first_chat_time, last_chat_time)
                 VALUES (%s, 'sp', 'c1', %s, %s, now(), now())"""
    violates(cur, "ExclusionViolation", insert, ("e4", 5, 7))
    violates(cur, "ExclusionViolation", insert, ("e5", 2, 3))
    violates(cur, "CheckViolation", insert, ("e6", 9, 8))
    cur.execute(f"DELETE FROM {S}.topics WHERE id = 't1'")
    cur.execute(f"SELECT topic_id FROM {S}.episodes WHERE id = 'e1'")
    assert cur.fetchone() == (None,)  # ON DELETE SET NULL keeps the Episode


def test_message_seq_unique_per_conversation(cur):
    insert = f"""INSERT INTO {S}.messages (project_id, conversation_key, message_id, msg_seq,
                     role, content, chat_time, accept_time, task_id, content_sha256)
                 VALUES ('p', %s, %s, %s, 'user', 'hi', now(), now(), 't', 'h')"""
    cur.execute(insert, ("c1", "m1", 1))
    cur.execute(insert, ("c2", "m1", 1))
    violates(cur, "UniqueViolation", insert, ("c1", "m2", 1))
    violates(cur, "CheckViolation", insert.replace("'user'", "'bot'"), ("c1", "m3", 2))


def test_required_extensions_include_btree_gist():
    from memos.project_dbs.postgres import required_extensions

    assert required_extensions("simple") == ["vector", "btree_gist"]
    assert required_extensions("zhparser") == ["vector", "btree_gist", "zhparser"]


def test_writer_and_reader_follow_a_custom_schema(cur):
    """Add installs the shared tables in its own schema and writes in its own transaction."""
    from datetime import datetime, timezone

    from memos.project_dbs.item import (
        ConflictCard,
        Decision,
        TopicChangeSet,
        TopicCreate,
        TopicUpdate,
    )
    from memos.project_dbs.postgres_rows import _ENTRY_COLS, entries_from_rows, qualify
    from memos.project_dbs.postgres_writer import write_change_set

    at = datetime(2026, 11, 19, tzinfo=timezone.utc)
    decision = Decision(
        content="A",
        chat_time=at,
        user_ids=["u"],
        conflicts=[ConflictCard(content="B", chat_time=at, user_ids=["v"])],
    )
    create = TopicCreate(
        domain="dev",
        topic_name="n",
        topic_summary="s",
        topic_description="d",
        entries=[decision],
        create_time=at,
        update_time=at,
    )
    (created,) = write_change_set(
        cur, TopicChangeSet(space_id="sp", accept_time=at, creates=[create]), schema=S
    )
    cur.execute(
        f"SELECT version, extra ? 'rank_time' FROM {S}.topics WHERE id = %s", (created.topic_id,)
    )
    assert cur.fetchone() == (1, True)
    cur.execute(
        f"SELECT {_ENTRY_COLS} FROM {S}.project_entries e WHERE e.parent_decision_id IS NULL"
    )
    (stored,) = entries_from_rows(cur, cur.fetchall(), with_children=True, schema=S)
    assert stored.conflicts[0].content == "B"
    update = TopicUpdate(topic_id=created.topic_id, expected_version=1, topic_summary="s2")
    write_change_set(cur, TopicChangeSet(space_id="sp", accept_time=at, updates=[update]), schema=S)
    cur.execute(f"SELECT topic_summary FROM {S}.topics WHERE id = %s", (created.topic_id,))
    assert cur.fetchone() == ("s2",)
    with pytest.raises(ValueError, match="lowercase"):
        qualify("SELECT 1 FROM project_memory.spaces", "Bad-Schema")
