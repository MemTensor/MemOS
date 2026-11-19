import os
import uuid

import pytest

from memos.project_memory.add_commit import commit_changeset
from memos.project_memory.add_index import index_changeset, ranked_topics
from memos.project_memory.add_merge import VersionConflictError, prepare_merge
from memos.project_memory.add_store import PostgresAddStore, json_value


@pytest.fixture
def store():
    dsn = os.environ.get("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required for atomic Add verification")
    from psycopg2 import sql

    db = PostgresAddStore(
        {
            "dsn": dsn,
            "schema_name": f"test_add_commit_{uuid.uuid4().hex}",
            "embedding_dimension": 3,
        },
        project_id="project",
    )
    try:
        with db.transaction() as cursor:
            cursor.execute(
                "INSERT INTO spaces(id, project_id, space_name) VALUES ('space','project','Test')"
            )
            cursor.execute(
                "INSERT INTO domains(id, space_id, domain) VALUES ('domain','space','project')"
            )
        yield db
    finally:
        with db.transaction() as cursor:
            cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(db.schema_name)))
        db.close()


def episode(store, eid, draft):
    with store.transaction() as cursor:
        cursor.execute(
            """INSERT INTO episodes(id, project_id, space_id, conversation_key, user_id, domains,
                          state, opened_at, last_turn_at, closed_at, stage, attempt, drafts, organize_result)
                          VALUES (%s,'project','space',%s,'user','{project}',
                                  'extracted',now(),now(),now(),'committing',1,%s,%s)""",
            (eid, eid, json_value([draft]), json_value({"work": {"token": "active-token"}})),
        )
        cursor.execute(
            """INSERT INTO messages(project_id, conversation_key, message_id, turn_id,
                          turn_seq,msg_seq,role,content,chat_time,accepted_at,task_id,user_id,content_sha256)
                          VALUES ('project',%s,%s,%s,1,1,'user','池大小设为 16',now(),now(),'task','user','fixture')""",
            (eid, eid, eid),
        )
        cursor.execute(
            """INSERT INTO episode_turns(project_id,space_id,conversation_key,episode_id,turn_id,
                          turn_seq,message_count,task_id,user_id,chat_time,accepted_at)
                          VALUES ('project','space',%s,%s,%s,1,1,'task','user',now(),now())""",
            (eid, eid, eid),
        )


def draft_for(eid):
    return {
        "kind": "timeline",
        "content": "池大小设为 16",
        "draft_id": eid,
        "episode_id": eid,
        "origin_task_id": "task",
        "origin": "member",
        "authors": ["user"],
        "chat_time": "2026-11-19T11:00:00+08:00",
        "quote": "池大小设为 16",
        "source_refs": [{"message_id": eid, "source_path": "/content", "start": 0, "end": 8}],
    }


def changeset(eid, draft, basis):
    out = prepare_merge(
        None,
        {
            "episode_id": eid,
            "space_id": "space",
            "staging": None,
            "staged_updates": [],
            "formation": None,
            "warnings": [],
            "assignments": [
                {"topic": basis, "episodes": [{"id": eid, "space_id": "space", "drafts": [draft]}]}
            ],
        },
    )
    out["topics"][0]["topic"]["topic_summary"] = draft["content"]
    return out


def test_topic_projection_and_receipt_commit_together_and_replay_once(store):
    basis = {
        "id": "topic",
        "space_id": "space",
        "domain": "project",
        "version": None,
        "topic_name": "Connection pool",
        "topic_summary": "",
        "topic_description": "",
    }
    draft = draft_for("one")
    episode(store, "one", draft)
    edit = changeset("one", draft, basis)
    with pytest.raises(VersionConflictError):
        commit_changeset(store, "one", 1, edit, work_token="expired")
    assert not store.read_topics("space")
    first = commit_changeset(store, "one", 1, edit, work_token="active-token")
    assert commit_changeset(store, "one", 1, edit, work_token="active-token") == first
    assert first["topic_ids"] == ["topic"]
    assert store.load_episode("one")["commit_key"] == "one:1"
    (topic,) = store.read_topics("space")
    assert topic["version"] == 1
    with store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT kind, content, topic_version FROM topic_items")
        assert cursor.fetchone() == {
            "kind": "timeline",
            "content": "池大小设为 16",
            "topic_version": 1,
        }


def test_version_conflict_rolls_back_entire_episode_change(store):
    original = {
        "id": "topic",
        "space_id": "space",
        "domain": "project",
        "version": None,
        "topic_name": "Connection pool",
        "topic_summary": "",
        "topic_description": "",
    }
    first = draft_for("one")
    episode(store, "one", first)
    commit_changeset(store, "one", 1, changeset("one", first, original))
    (basis,) = store.read_topics("space")
    second, third = draft_for("two"), draft_for("three")
    episode(store, "two", second)
    episode(store, "three", third)
    competing = changeset("three", third, basis)
    commit_changeset(store, "two", 1, changeset("two", second, basis))
    with pytest.raises(VersionConflictError):
        commit_changeset(store, "three", 1, competing)
    (after,) = store.read_topics("space")
    assert after["version"] == 2
    assert len(after["timeline"]) == 2
    assert store.load_episode("three")["commit_key"] is None


def test_vector_index_uses_same_commit_and_filters_domains(store):
    basis = {
        "id": "topic",
        "space_id": "space",
        "domain": "project",
        "version": None,
        "topic_name": "Connection pool",
        "topic_summary": "",
        "topic_description": "",
    }
    draft = draft_for("vector")
    episode(store, "vector", draft)

    def embed(texts):
        return [[0.1, 0.2, 0.3] for _ in texts]

    edit = index_changeset(changeset("vector", draft, basis), embed, 3, model_id="local-fixture")
    commit_changeset(store, "vector", 1, edit)
    ranked, degraded = ranked_topics(
        store,
        {"space_id": "space", "domains": ["project"], "episode_summary": "unmatched-lexical"},
        embed,
    )
    assert [topic["id"] for _, topic in ranked] == ["topic"]
    assert degraded is False
    excluded, _ = ranked_topics(
        store,
        {"space_id": "space", "domains": ["other"], "episode_summary": "unmatched-lexical"},
        embed,
    )
    assert not excluded
    with store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT embedding, embedding_model_id FROM topic_items")
        assert cursor.fetchone() == {
            "embedding": "[0.1,0.2,0.3]",
            "embedding_model_id": "local-fixture",
        }
