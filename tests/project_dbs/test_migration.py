"""PostgreSQL-only: the legacy layout (git 9e5b2f26) is migrated in place on init."""

import json

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from tests.project_dbs.conftest import DIM


LEGACY_SQL = Path(__file__).with_name("fixtures") / "legacy_postgres_init_v1.sql"
T = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc)
# Add's own tables at 9e5b2f26 (memos.project_memory.add_layout.ADD_TABLES)
ADD_TABLES = """
CREATE TABLE {s}.add_space_state (
  space_id text PRIMARY KEY REFERENCES {s}.spaces (id) ON DELETE CASCADE,
  resource_bindings jsonb NOT NULL DEFAULT '[]', last_formation_at timestamptz,
  staged_since_last_formation int NOT NULL DEFAULT 0, formation_version bigint NOT NULL DEFAULT 0);
CREATE TABLE {s}.add_episode_events (
  id bigserial PRIMARY KEY, project_id text NOT NULL,
  episode_id text NOT NULL REFERENCES {s}.episodes (id) ON DELETE CASCADE,
  event text NOT NULL, at timestamptz NOT NULL, stage text, attempt int,
  detail jsonb NOT NULL DEFAULT '{{}}');
"""


def legacy_ddl(monkeypatch, schema: str) -> str:
    from memos.project_dbs import postgres

    monkeypatch.setattr(postgres, "INIT_SQL", LEGACY_SQL)
    ddl = postgres.render_ddl(DIM, "simple", schema=schema)
    monkeypatch.undo()
    return ddl


def j(value) -> str:
    return json.dumps(value)


def seed(cur, s: str) -> None:
    """Rows as the old storage and Add wrote them."""
    cur.execute(ADD_TABLES.format(s=s))
    cur.execute(
        f"""INSERT INTO {s}.spaces (id, project_id, space_name, cleared_at)
            VALUES ('sp', 'p', 'n', %s)""",
        (T - timedelta(days=1),),
    )
    cur.execute(f"INSERT INTO {s}.domains (id, space_id, domain) VALUES ('dm', 'sp', 'dev')")
    cur.execute(
        f"""INSERT INTO {s}.add_space_state VALUES ('sp', %s, %s, 2, 3)""",
        (j([{"repo": "memos"}]), T),
    )
    topic = f"""INSERT INTO {s}.topics (id, space_id, domain_id, topic_name, topic_summary,
                    topic_description, sources, extra, create_time, update_time)
                VALUES (%s, 'sp', 'dm', 'n', 's', 'd', %s, %s, %s, %s)"""
    cur.execute(
        topic,
        (
            "topic_old1",
            j([
                {"user_id": "alice", "agent_id": ["codex", "cc"], "conversation_id": "c1"},
                {"user_id": ["bob"], "conversation_id": "c2"},
                {"user_id": "alice", "agent_id": "codex"},
            ]),
            j({"committed_at": "2026-11-18T12:00:00+00:00", "last_commit_key": "k"}),
            T - timedelta(hours=5),
            T,
        ),
    )  # fmt: skip
    cur.execute(topic, ("topic_old2", "[]", "{}", T, T + timedelta(hours=1)))
    entry = f"""INSERT INTO {s}.project_entries (id, topic_id, space_id, entry_type, content,
                    time, user_ids, history, conflicts, extra)
                VALUES (%s, 'topic_old1', 'sp', %s, %s, %s, %s, %s, %s, %s)"""
    cur.execute(
        entry,
        (
            "d1", "decision", "Export daily.", T, ["alice"],
            j([
                {"content": "Export weekly.", "time": "2026-11-17T01:00:00+00:00",
                 "user_ids": ["alice"], "reason": "faster", "commit_key": "k0",
                 "source": {"message_id": "m0", "quote": "weekly"},
                 "change_source": {"message_id": "m2", "quote": "daily"}},
                {"content": "Export monthly.", "time": "", "user_ids": [], "reason": None},
            ]),
            j([{"content": "Export hourly.", "time": "2026-11-18T11:00:00+00:00",
                "user_ids": ["bob"], "source": {"message_id": "m3"}, "seq": 1}]),
            j({"source": {"conversation_id": "c1", "message_id": "m2"},
               "user_labels": {"alice": "Alice"}, "_member_stance_times": {}}),
        ),
    )  # fmt: skip
    card = {"task_intent": "Debug exports", "problem": "Rows lost", "principle": "Read code"}
    cur.execute(
        entry,
        ("x_low", "experience", "low", T, [], "[]", "[]",
         j({"card": card, "status": "verified", "confidence": 0.05})),
    )  # fmt: skip
    cur.execute(
        entry,
        ("x_ok", "experience", "ok", T, ["alice"], "[]", "[]",
         j({"card": card, "status": "candidate", "confidence": 0.5, "last_supported_at": "",
            "sources": [{"message_id": "m1", "chat_time": "", "segment_id": "e1",
                         "signal": "test", "quality_score": 0.7}]})),
    )  # fmt: skip
    cur.execute(entry, ("tl1", "timeline", "Shipped.", T, [], "[]", "[]", "{}"))
    message = f"""INSERT INTO {s}.messages (project_id, conversation_key, message_id,
                      conversation_id, turn_id, turn_seq, msg_seq, role, role_id, content,
                      chat_time, accepted_at, task_id, user_id, agent_id, content_sha256)
                  VALUES ('p', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'task1', 'alice',
                          %s, 'h')"""
    for row in (  # turn m1 (2 messages), turn m3 (1 message) in c1; one message in task:t9
        ("c1", "m1", "c1", "m1", 1, 1, "user", None, "hi", T, T, j("codex")),
        ("c1", "m2", "c1", "m1", 1, 2, "assistant", None, "ok", T + timedelta(minutes=1), T,
         j(["codex", "cc"])),
        ("c1", "m3", "c1", "m3", 2, 1, "user", "carol", "next", T + timedelta(minutes=5),
         T + timedelta(minutes=5), None),
        ("task:t9", "m9", None, "m9", 1, 1, "user", None, "solo", T, T, None),
    ):  # fmt: skip
        cur.execute(message, row)
    episode = f"""INSERT INTO {s}.episodes (id, space_id, project_id, conversation_key, user_id,
                      domains, previous_episode_id, state, opened_at, last_turn_at, closed_at,
                      stage, outcome, result, episode_summary, staged_status, staged_at,
                      moved_to_topic_id, staged_embedding)
                  VALUES (%s, 'sp', 'p', %s, 'alice', '{{dev}}', %s, 'extracted', %s, %s, %s,
                          'done', %s, %s, %s, %s, %s, %s, %s)"""
    vector = [1.0] + [0.0] * (DIM - 1)
    for row in (
        ("e1", "c1", None, T, T, T, "committed", j({"topic_ids": ["topic_old1"]}), "first",
         None, None, None, None),
        ("e2", "c1", "e1", T, T, T, "staged", j({"topic_ids": []}), "second", "moved", T,
         "topic_old2", vector),
        ("e_empty", "c1", None, T, T, T, "skipped", None, None, None, None, None, None),
    ):  # fmt: skip
        cur.execute(episode, row)
    turn = f"""INSERT INTO {s}.episode_turns (space_id, conversation_key, turn_id, project_id,
                   episode_id, turn_seq, message_count, task_id, user_id, chat_time, accepted_at)
               VALUES ('sp', 'c1', %s, 'p', %s, 1, %s, 'task1', 'alice', %s, %s)"""
    cur.execute(turn, ("m1", "e1", 2, T, T + timedelta(seconds=1)))
    cur.execute(turn, ("m3", "e2", 1, T, T + timedelta(minutes=5)))
    cur.execute(
        f"INSERT INTO {s}.add_episode_events (project_id, episode_id, event, at) "
        "VALUES ('p', 'e1', 'opened', now())"
    )


def fetch(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchall()


def test_legacy_layout_is_migrated_in_place(pg_conn, scratch_schema, monkeypatch):
    from memos.project_dbs.postgres import install_schema, is_legacy_layout, render_ddl

    s = scratch_schema("pm_legacy_test")
    pg_conn.autocommit = False
    try:
        with pg_conn.cursor() as cur:
            cur.execute(legacy_ddl(monkeypatch, s))
            seed(cur, s)
            assert is_legacy_layout(cur, s)
            assert install_schema(cur, render_ddl(DIM, "simple", schema=s), schema=s) == "migrated"
            assert not is_legacy_layout(cur, s)
            assert install_schema(cur, render_ddl(DIM, "simple", schema=s), schema=s) == "current"
            check_migrated(cur, s)
        pg_conn.commit()
    finally:
        pg_conn.rollback()
        pg_conn.autocommit = True


def check_migrated(cur, s: str) -> None:
    tables = fetch(
        cur,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = %s",
        (s,),
    )
    assert {r[0] for r in tables} == {
        "spaces", "domains", "topics", "project_entries", "messages", "episodes", "turns",
        "add_space_state", "add_episode_events",
        "legacy_messages_v1", "legacy_episodes_v1", "legacy_episode_turns_v1",
    }  # fmt: skip
    # spaces
    assert fetch(
        cur,
        f"SELECT clear_time, resource_bindings, last_formation_time, formation_version "
        f"FROM {s}.spaces",
    ) == [(T - timedelta(days=1), [{"repo": "memos"}], T, 3)]
    # topics: ids kept, sources normalised, derived columns, commit_time, rank key
    rows = fetch(
        cur,
        f"SELECT id, sources, conversation_ids, commit_time, extra FROM {s}.topics ORDER BY id",
    )
    (t1, sources, ids, commit_time, extra), (t2, _, ids2, commit_time2, extra2) = rows
    assert (t1, t2) == ("topic_old1", "topic_old2")
    assert sources == [
        {"user_id": ["alice"], "agent_id": "codex", "agent_ids": ["codex", "cc"],
         "conversation_id": "c1"},
        {"user_id": ["bob"], "agent_id": None, "conversation_id": "c2"},
        {"user_id": ["alice"], "agent_id": "codex"},
    ]  # fmt: skip
    assert ids == ["c1", "c2"] and ids2 == []
    assert commit_time == datetime(2026, 11, 18, 12, tzinfo=timezone.utc)
    assert commit_time2 == T + timedelta(hours=1)  # no committed_at: update_time
    assert extra["last_commit_key"] == "k" and "rank_time" in extra and "rank" in extra2
    # one open conflict, one decision, members alice + bob, two conversations
    assert extra["rank"]["total"] == 12 + 4 + 6 + 3
    assert fetch(
        cur,
        "SELECT column_default FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = 'topics' AND column_name = 'create_time'",
        (s,),
    ) == [(None,)]
    # entries
    columns = {r[0] for r in fetch(
        cur,
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = 'project_entries'",
        (s,),
    )}  # fmt: skip
    assert {"chat_time", "status", "parent_decision_id"} <= columns
    assert not {"time", "history", "conflicts"} & columns
    rows = fetch(
        cur,
        f"""SELECT status, content, chat_time, user_ids, extra FROM {s}.project_entries
            WHERE parent_decision_id = 'd1' ORDER BY status, content""",
    )
    assert rows == [
        (1, "Export monthly.", T, [], {}),  # unparseable time: the decision's time
        (1, "Export weekly.", datetime(2026, 11, 17, 1, tzinfo=timezone.utc), ["alice"],
         {"reason": "faster", "commit_key": "k0", "source": {"message_id": "m0", "quote": "weekly"},
          "change_source": {"message_id": "m2", "quote": "daily"}}),
        (2, "Export hourly.", datetime(2026, 11, 18, 11, tzinfo=timezone.utc), ["bob"],
         {"source": {"message_id": "m3"}, "seq": 1}),
    ]  # fmt: skip
    entries = dict(fetch(
        cur,
        f"SELECT id, jsonb_build_object('status', status, 'extra', extra) "
        f"FROM {s}.project_entries WHERE parent_decision_id IS NULL",
    ))  # fmt: skip
    assert entries["d1"]["extra"]["sources"] == [{"conversation_id": "c1", "message_id": "m2"}]
    assert "source" not in entries["d1"]["extra"]
    low = entries["x_low"]
    assert low["status"] == 1 and low["extra"]["exp_status"] == "verified"
    assert (low["extra"]["confidence"], low["extra"]["legacy_confidence"]) == (0.1, 0.05)
    ok = entries["x_ok"]
    assert ok["status"] == 0 and ok["extra"]["exp_status"] == "candidate"
    assert ok["extra"]["sources"] == [
        {"message_id": "m1", "segment_id": "e1", "episode_id": "e1", "signal": "test",
         "quality_score": 0.7}
    ]  # fmt: skip
    assert entries["tl1"]["status"] == 0
    # messages: msg_seq per conversation, role_id / agent_id filled
    assert fetch(
        cur,
        f"""SELECT conversation_key, message_id, msg_seq, role_id, agent_id, accept_time
            FROM {s}.messages ORDER BY conversation_key, msg_seq""",
    ) == [
        ("c1", "m1", 1, "alice", "codex", T),
        ("c1", "m2", 2, None, "codex", T),
        ("c1", "m3", 3, "carol", None, T + timedelta(minutes=5)),
        ("task:t9", "m9", 1, "alice", None, T),
    ]
    # episodes: msg_seq ranges, topic from result / moved_to_topic_id, chat times
    assert fetch(
        cur,
        f"""SELECT id, message_seq_start, message_seq_end, previous_episode_id, topic_id,
                   episode_summary, first_chat_time, last_chat_time, embedding IS NOT NULL,
                   create_time
            FROM {s}.episodes ORDER BY id""",
    ) == [
        ("e1", 1, 2, None, "topic_old1", "first", T, T + timedelta(minutes=1), False,
         T + timedelta(seconds=1)),
        ("e2", 3, 3, "e1", "topic_old2", "second", T + timedelta(minutes=5),
         T + timedelta(minutes=5), True, T + timedelta(minutes=5)),
    ]  # fmt: skip
    assert fetch(cur, f"SELECT count(*) FROM {s}.legacy_episodes_v1") == [(3,)]  # e_empty kept
    # Add's event table now references the new episodes
    assert fetch(
        cur,
        """SELECT confrelid::regclass::text FROM pg_constraint
           WHERE conrelid = to_regclass(%s) AND contype = 'f'""",
        (f"{s}.add_episode_events",),
    ) == [(f"{s}.episodes",)]
    # new constraints hold on migrated data
    cur.execute("SAVEPOINT c")
    with pytest.raises(Exception, match="check"):
        cur.execute(
            f"UPDATE {s}.project_entries SET parent_decision_id = NULL WHERE content = 'Export hourly.'"
        )
    cur.execute("ROLLBACK TO SAVEPOINT c")


def test_init_migrates_the_project_memory_schema(pg_db, pg_conn, monkeypatch):
    """End to end through PostgresProjectDB on the real schema name; the schema is rebuilt
    clean afterwards for the other tests sharing pg_db."""
    from memos.project_dbs.postgres import PostgresProjectDB

    with pg_conn.cursor() as cur:
        cur.execute("DROP SCHEMA project_memory CASCADE")
        cur.execute(legacy_ddl(monkeypatch, "project_memory"))
        seed(cur, "project_memory")
    store = PostgresProjectDB(pg_db.config)
    try:
        (topic,) = store.get_topics_detail(["topic_old1"])
        assert [d.content for d in topic.decisions] == ["Export daily."]
        (d,) = topic.decisions
        assert [h.content for h in d.history] == ["Export weekly.", "Export monthly."]
        assert [c.content for c in d.conflicts] == ["Export hourly."]
        assert [e.id for e in topic.experiences] == ["x_ok"]  # x_low retired
        assert topic.sources[0].user_id == ["alice"] and topic.sources[0].agent_id == "codex"
        assert store.get_entry(d.conflicts[0].id).id == "d1"
        assert store.get_entry("x_low").status == 1
        page = store.list_topics("sp")
        assert [t.id for t in page.items] == ["topic_old1", "topic_old2"]  # rank: 25h bonus
        assert store.list_spaces("p", ["sp"])[0].clear_time == T - timedelta(days=1)
    finally:
        store.close()
        with pg_conn.cursor() as cur:
            cur.execute("DROP SCHEMA project_memory CASCADE")
        pg_db._init_schema()
