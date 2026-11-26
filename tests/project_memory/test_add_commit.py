import os
import uuid

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from memos.project_memory.add_acceptance import AcceptanceSettings, AddAcceptance
from memos.project_memory.add_commit import DraftWitnessError, commit_changeset
from memos.project_memory.add_extraction import extract_episode
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


def episode(store, eid, draft, *, start=1):
    """A committing Episode over one member message at msg_seq `start` of conversation eid."""
    with store.transaction() as cursor:
        cursor.execute(
            """INSERT INTO messages(project_id, conversation_key, message_id, msg_seq, role,
                          content, chat_time, accept_time, task_id, content_sha256)
               VALUES ('project',%s,%s,%s,'user','池大小设为 16',now(),now(),'task','fixture')""",
            (eid, eid, start),
        )
        cursor.execute(
            """INSERT INTO episodes(id, space_id, conversation_key, message_seq_start,
                          message_seq_end, first_chat_time, last_chat_time)
               VALUES (%s,'space',%s,%s,%s,now(),now())""",
            (eid, eid, start, start),
        )
        cursor.execute(
            """INSERT INTO add_jobs(episode_id, project_id, space_id, conversation_key, user_id,
                          task_ids, domains, stage, attempt, accept_time, drafts, organize_result)
               VALUES (%s,'project','space',%s,'user','{task}','{project}','committing',1,
                       now(),%s,%s)""",
            (
                eid,
                eid,
                json_value([draft]),
                json_value(
                    {
                        "work": {"token": "active-token"},
                        "task_ranges": {"task": [start, start]},
                        "task_owners": {"task": {"user_id": "user"}},
                        "extraction": {"at": "2026-11-19T00:00:00+00:00"},
                    }
                ),
            ),
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
    with store.transaction() as cursor:
        cursor.execute(
            """UPDATE add_jobs SET organize_result = organize_result || %s
               WHERE episode_id = 'one'""",
            (json_value({"work": {"token": "active-token", "until": "2026-01-01T00:00:00Z"}}),),
        )
    with pytest.raises(VersionConflictError):
        commit_changeset(store, "one", 1, edit, work_token="active-token")
    assert not store.read_topics("space")
    with store.transaction() as cursor:
        cursor.execute(
            """UPDATE add_jobs SET organize_result = organize_result || %s
               WHERE episode_id = 'one'""",
            (json_value({"work": {"token": "active-token", "until": "2999-01-01T00:00:00Z"}}),),
        )
    first = commit_changeset(store, "one", 1, edit, work_token="active-token")
    assert commit_changeset(store, "one", 1, edit, work_token="active-token") == first
    (topic,) = store.read_topics("space")
    # Storage names the new Topic; the receipt, the Episode and the creator mark follow it.
    assert topic["id"].startswith("topic_") and first["topic_ids"] == [topic["id"]]
    assert first["created_topic_ids"] == [topic["id"]]
    assert topic["created_by_episode_id"] == "one" and topic["last_commit_key"] == "one:1"
    committed = store.load_episode("one")
    assert committed["commit_key"] == "one:1" and committed["topic_id"] == topic["id"]
    assert committed["outcome"] == "committed" and committed["stage"] == "done"
    assert topic["version"] == 1
    assert topic["create_time"].isoformat() == "2026-11-19T03:00:00+00:00"
    with store.transaction(readonly=True) as cursor:
        cursor.execute("SELECT entry_type, content, version FROM project_entries")
        assert cursor.fetchone() == {
            "entry_type": "timeline",
            "content": "池大小设为 16",
            "version": 1,
        }


def test_commit_accepts_extracted_quote_with_source_whitespace(store):
    source_quote = "Updated the\u00a0connection pool."
    acceptance = AddAcceptance(store, AcceptanceSettings(max_turns=1))
    (episode_id,) = acceptance.accept(
        SimpleNamespace(
            task_id="pool-task",
            user_id="user",
            space_ids=["space"],
            conversation_id="pool",
            messages=[
                {"message_id": "request", "role": "user", "content": "Update the pool."},
                {"message_id": "result", "role": "assistant", "content": f"Done. {source_quote}"},
            ],
        )
    ).closed_episode_ids
    current = store.load_episode(episode_id)
    writer = SimpleNamespace(
        write=lambda *_args: {
            "episode_summary": "Connection pool updated",
            "drafts": [
                {
                    "kind": "timeline",
                    "content": "Connection pool updated",
                    "message_id": "result",
                    "quote": "Updated the connection pool.",
                }
            ],
        }
    )
    (draft,) = extract_episode(writer, current, current["messages"])["drafts"]
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE add_jobs SET stage = 'committing', attempt = 1, drafts = %s "
            "WHERE episode_id = %s",
            (json_value([draft]), episode_id),
        )
    edit = changeset(
        episode_id,
        draft,
        {
            "id": "topic",
            "space_id": "space",
            "domain": "project",
            "version": None,
            "topic_name": "Connection pool",
            "topic_summary": "",
            "topic_description": "",
        },
    )

    (topic_id,) = commit_changeset(store, episode_id, 1, edit)["topic_ids"]
    assert [topic["id"] for topic in store.read_topics("space")] == [topic_id]


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
    assert store.load_episode("three")["stage"] == "committing"


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
    (stored,) = store.read_topics("space")
    assert [topic["id"] for _, topic in ranked] == [stored["id"]]
    assert degraded is False
    excluded, _ = ranked_topics(
        store,
        {"space_id": "space", "domains": ["other"], "episode_summary": "unmatched-lexical"},
        embed,
    )
    assert not excluded
    with store.transaction(readonly=True) as cursor:
        cursor.execute(
            """SELECT e.embedding, t.extra->>'embedding_model_id' AS embedding_model_id
               FROM project_entries e JOIN topics t ON t.id = e.topic_id"""
        )
        assert cursor.fetchone() == {
            "embedding": "[0.1,0.2,0.3]",
            "embedding_model_id": "local-fixture",
        }


@pytest.mark.parametrize(
    ("role", "same_conversation", "seq", "fits"),
    [
        ("assistant", True, 0, True),
        ("tool", True, 0, False),
        ("assistant", False, 0, False),
        ("assistant", True, 1, False),
    ],
)
def test_commit_checks_the_original_assistant_proposal(store, role, same_conversation, seq, fits):
    draft = draft_for("adopted")
    ref = {"message_id": "proposal", "source_path": "/content", "start": 0, "end": 6}
    draft.update(
        kind="decision",
        origin="adopted",
        context_refs=[ref],
        authorizing_evidence_refs=draft["source_refs"],
        evidence=[{"kind": "assistant_proposal", "ref": ref, "quote": "Propose"}],
    )
    # The span should select the exact cited proposal, even when the message is longer.
    ref["end"] = len("Propose")
    # The proposal precedes the authorization (seq 1 < 2) or follows it (seq 3).
    proposal_seq = 3 if seq else 1
    episode(store, "adopted", draft, start=2)
    with store.transaction() as cursor:
        conversation = "adopted" if same_conversation else "other"
        cursor.execute(
            """INSERT INTO messages(project_id, conversation_key, message_id, msg_seq, role,
                          content, chat_time, accept_time, task_id, content_sha256)
               VALUES ('project',%s,'proposal',%s,%s,'Propose 16',
                       now() - interval '5 minutes', now() - interval '5 minutes', 'earlier',
                       'fixture')""",
            (conversation, proposal_seq, role),
        )
        low, high = sorted((2, proposal_seq))
        cursor.execute(
            """UPDATE episodes SET message_seq_start = %s, message_seq_end = %s
               WHERE id = 'adopted'""",
            (low, high),
        )
        if proposal_seq > 2:
            # A later proposal is accepted after the authorization.
            cursor.execute(
                """UPDATE messages SET accept_time = now() + interval '1 minute',
                          chat_time = now() + interval '1 minute' WHERE message_id = 'proposal'"""
            )
    prepared = prepare_merge(
        None,
        {
            "episode_id": "adopted",
            "space_id": "space",
            "assignments": [],
            "staging": {"reason": "NO_MATCH"},
            "formation": None,
            "staged_updates": [],
            "warnings": [],
        },
    )
    if fits:
        assert commit_changeset(store, "adopted", 1, prepared)["outcome"] == "staged"
    else:
        with pytest.raises(DraftWitnessError, match="earlier assistant proposal"):
            commit_changeset(store, "adopted", 1, prepared)


@pytest.mark.parametrize("proposal_id", ["earlier-proposal", "later-proposal"])
def test_commit_checks_adoption_in_conversation_order_across_episodes(store, proposal_id):
    now = datetime(2026, 11, 19, tzinfo=timezone.utc)
    acceptance = AddAcceptance(store, AcceptanceSettings(max_turns=1), clock=lambda: now)
    proposal = "建议把池大小设为 16。"
    authorization = "同意，按这个方案执行。"
    (earlier_id,) = acceptance.accept(
        SimpleNamespace(
            project_id="project",
            task_id="proposal-task",
            user_id="user",
            space_ids=["space"],
            conversation_id="adoption",
            messages=[
                {"message_id": "question", "role": "user", "content": "池大小用多少？"},
                {"message_id": "earlier-proposal", "role": "assistant", "content": proposal},
            ],
        )
    ).closed_episode_ids
    now += timedelta(seconds=1)
    (current_id,) = acceptance.accept(
        SimpleNamespace(
            project_id="project",
            task_id="authorization-task",
            user_id="user",
            space_ids=["space"],
            conversation_id="adoption",
            messages=[
                {"message_id": "authorization", "role": "user", "content": authorization},
                {"message_id": "later-proposal", "role": "assistant", "content": proposal},
            ],
        )
    ).closed_episode_ids

    current = store.load_episode(current_id)
    previous = current["previous"]
    assert previous["id"] == earlier_id
    proposal_row = previous["messages"][1]
    authorization_row = current["messages"][0]
    assert (proposal_row["msg_seq"], authorization_row["msg_seq"]) == (2, 3)
    writer = SimpleNamespace(
        write=lambda *_args: {
            "episode_summary": "选择池大小",
            "drafts": [
                {
                    "kind": "decision",
                    "content": "池大小设为 16",
                    "message_id": "authorization",
                    "quote": authorization,
                    "origin": "adopted",
                    "context": [{"message_id": "earlier-proposal", "quote": proposal}],
                }
            ],
        }
    )
    (draft,) = extract_episode(writer, current, current["messages"], previous["messages"])["drafts"]
    if proposal_id == "later-proposal":
        # Simulate a forged reference to the same quote after authorization in the current Turn.
        ref = {**draft["context_refs"][0], "message_id": proposal_id}
        draft["context_refs"] = [ref]
        for evidence in draft["evidence"]:
            if evidence.get("kind") == "assistant_proposal":
                evidence["ref"] = ref
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE add_jobs SET stage = 'committing', attempt = 1, drafts = %s "
            "WHERE episode_id = %s",
            (json_value([draft]), current_id),
        )
    prepared = changeset(
        current_id,
        draft,
        {
            "id": "topic",
            "space_id": "space",
            "domain": "project",
            "version": None,
            "topic_name": "Connection pool",
            "topic_description": "",
        },
    )
    if proposal_id == "earlier-proposal":
        (topic_id,) = commit_changeset(store, current_id, 1, prepared)["topic_ids"]
        (topic,) = store.read_topics("space")
        assert topic["id"] == topic_id
        assert topic["decisions"][0]["content"] == "池大小设为 16"
    else:
        with pytest.raises(DraftWitnessError, match="earlier assistant proposal"):
            commit_changeset(store, current_id, 1, prepared)
        assert not store.read_topics("space")
