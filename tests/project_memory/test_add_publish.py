"""Add commits publish into the shared retrieval index read by `RetrievalStore`."""

import os
import uuid

import pytest

from memos.project_memory.add_commit import commit_changeset
from memos.project_memory.add_index import index_changeset
from memos.project_memory.add_merge import prepare_merge
from memos.project_memory.add_publish import publish_topics
from memos.project_memory.add_store import PostgresAddStore, json_value
from memos.project_memory.add_view import RelationalProjectView
from memos.project_memory.config import postgres_config
from memos.project_memory.index import Vector
from memos.project_memory.store import RetrievalStore, Scope
from memos.project_memory.types import Domain, Space


@pytest.fixture
def setup(monkeypatch):
    dsn = os.environ.get("PG_TEST_DSN")
    if not dsn:
        pytest.skip("PG_TEST_DSN is required for retrieval publishing")
    from psycopg2 import sql

    tenant, space = f"tenant-{uuid.uuid4().hex}", f"space-{uuid.uuid4().hex}"
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_DSN", raising=False)
    store = PostgresAddStore(
        {
            **postgres_config(3),
            "text_search_parser": "simple",
            "dsn": dsn,
            "schema_name": f"test_add_publish_{uuid.uuid4().hex}",
        },
    )
    view = RelationalProjectView(store)
    view.put_space(
        Space(space_id=space, project_id=tenant, space_name="Ledger", domains=[Domain("开发")])
    )
    try:
        yield store, view, RetrievalStore(store.pool), tenant, space
    finally:
        with store.transaction() as cursor:
            cursor.execute(
                "DELETE FROM memos_project.pm_retrieval_roots WHERE tenant_id = %s", (tenant,)
            )
            cursor.execute("DELETE FROM memos_project.pm_domains WHERE space_id = %s", (space,))
            cursor.execute("DELETE FROM memos_project.pm_spaces WHERE tenant_id = %s", (tenant,))
            cursor.execute(
                sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(store.schema_name))
            )
        store.close()


def _episode(store, space, eid, text, domain):
    with store.transaction() as cursor:
        cursor.execute("SELECT project_id FROM spaces WHERE id = %s", (space,))
        project_id = cursor.fetchone()["project_id"]
        cursor.execute(
            """INSERT INTO messages(project_id, conversation_key, message_id, msg_seq, role,
                          content, chat_time, accept_time, task_id, content_sha256)
               VALUES (%s,%s,%s,1,'user',%s,now(),now(),'task','fixture')""",
            (project_id, eid, eid, text),
        )
        cursor.execute(
            """INSERT INTO episodes(id, space_id, conversation_key, message_seq_start,
                          message_seq_end, first_chat_time, last_chat_time)
               VALUES (%s,%s,%s,1,1,now(),now())""",
            (eid, space, eid),
        )
        cursor.execute(
            """INSERT INTO add_jobs(episode_id, project_id, space_id, conversation_key, user_id,
                          task_ids, domains, stage, attempt, accept_time, organize_result)
               VALUES (%s,%s,%s,%s,'user','{task}',%s,'committing',1,now(),%s)""",
            (
                eid,
                project_id,
                space,
                eid,
                [domain],
                json_value(
                    {
                        "work": {"token": "t"},
                        "task_ranges": {"task": [1, 1]},
                        "task_owners": {"task": {"user_id": "user"}},
                    }
                ),
            ),
        )


def _changeset(space, eid, text, basis):
    draft = {
        "kind": "timeline",
        "content": text,
        "draft_id": eid,
        "episode_id": eid,
        "origin_task_id": "task",
        "origin": "member",
        "authors": ["user"],
        "chat_time": "2026-11-19T11:00:00+08:00",
        "quote": text,
        "source_refs": [
            {"message_id": eid, "source_path": "/content", "start": 0, "end": len(text)}
        ],
    }
    out = prepare_merge(
        None,
        {
            "episode_id": eid,
            "space_id": space,
            "staging": None,
            "staged_updates": [],
            "formation": None,
            "warnings": [],
            "assignments": [
                {"topic": basis, "episodes": [{"id": eid, "space_id": space, "drafts": [draft]}]}
            ],
        },
    )
    out["topics"][0]["topic"]["topic_summary"] = text
    return out


def _commit(store, space, eid, text, basis):
    _episode(store, space, eid, text, basis["domain"])

    def embed(texts):
        return [[0.1, 0.2, 0.3] for _ in texts]

    edit = index_changeset(_changeset(space, eid, text, basis), embed, 3, model_id="fixture")
    (topic_id,) = commit_changeset(store, eid, 1, edit, work_token="t")["topic_ids"]
    return topic_id


def _recall(retrieval, tenant, space, query, vector=None):
    hits, _ = retrieval.recall(
        Scope(tenant, (space,)), "project", query, vector, None, 9, threshold=0
    )
    return hits


def test_commit_publishes_topic_with_entries_and_vectors(setup):
    store, _, retrieval, tenant, space = setup
    basis = {
        "id": "topic-pool",
        "space_id": space,
        "domain": "开发",
        "version": None,
        "topic_name": "连接池配置",
        "topic_summary": "",
        "topic_description": "",
    }
    topic_id = _commit(store, space, "e1", "连接池大小改为 16", basis)
    (hit,) = _recall(retrieval, tenant, space, "连接池大小")
    assert hit.data["id"] == topic_id and hit.data["domain"] == "开发"
    assert hit.data["rank_time"]
    assert [row["content"] for row in hit.data["timeline"]] == ["连接池大小改为 16"]
    vector = Vector(model="fixture", values=[0.1, 0.2, 0.3])
    assert _recall(retrieval, tenant, space, "完全不相关的词", vector)

    (current,) = store.read_topics(space)
    _commit(store, space, "e2", "连接池超时改为 30 秒", {**current, "domain": "开发"})
    (hit,) = _recall(retrieval, tenant, space, "连接池")
    assert len(hit.data["timeline"]) == 2
    with store.transaction(readonly=True) as cursor:
        cursor.execute(
            "SELECT revision FROM memos_project.pm_retrieval_roots WHERE tenant_id = %s", (tenant,)
        )
        assert cursor.fetchone()["revision"] == 2


def test_clear_rename_delete_follow_the_add_space(setup):
    store, view, retrieval, tenant, space = setup
    basis = {
        "id": "topic-a",
        "space_id": space,
        "domain": "开发",
        "version": None,
        "topic_name": "月报归档",
        "topic_summary": "",
        "topic_description": "",
    }
    _commit(store, space, "a1", "月报归档到 archive 目录", basis)

    current = view.get_space(space)
    current.domains[0].name = "研发"
    view.put_space(current)
    (hit,) = _recall(retrieval, tenant, space, "月报归档")
    assert hit.data["domain"] == "研发"
    retrieval.validate(Scope(tenant, (space,), ("研发",)))

    _commit(store, space, "a2", "月报保留十二个月", {**basis, "id": "topic-b", "domain": "研发"})
    assert _recall(retrieval, tenant, space, "月报保留")
    view.clear_space_topics(space)
    assert not _recall(retrieval, tenant, space, "月报保留")
    view.delete_space_nodes(space)
    with pytest.raises(LookupError):
        retrieval.validate(Scope(tenant, (space,)))


def test_list_orders_topics_by_rank_time_and_entries_by_page_order(setup):
    from memos.project_memory.add_publish import topic_snapshot

    store, _, retrieval, tenant, space = setup
    newer = _commit(
        store,
        space,
        "n1",
        "日报归档到 daily 目录",
        {
            "id": "placeholder-newer",
            "space_id": space,
            "domain": "开发",
            "version": None,
            "topic_name": "日报归档",
            "topic_summary": "",
            "topic_description": "",
        },
    )
    older = _commit(
        store,
        space,
        "o1",
        "周报归档到 weekly 目录",
        {
            "id": "placeholder-older",
            "space_id": space,
            "domain": "开发",
            "version": None,
            "topic_name": "周报归档",
            "topic_summary": "",
            "topic_description": "",
        },
    )
    with store.transaction() as cursor:
        # The older Topic earns a large importance bonus; storage keeps it in extra.rank_time.
        cursor.execute(
            """UPDATE topics SET update_time = update_time - interval '1 hour',
                      extra = extra || jsonb_build_object('rank_time',
                                                          (now() + interval '3 days')::text)
               WHERE id = %s""",
            (older,),
        )
        cursor.execute("SELECT project_id, now() AS now FROM spaces WHERE id = %s", (space,))
        row = cursor.fetchone()
        cursor.execute("UPDATE topics SET version = version + 1 WHERE id = %s", (older,))
        publish_topics(cursor, row["project_id"], space, [older], row["now"])
    listed = retrieval.list_topics(Scope(tenant, (space,)), 1, 10, {})
    assert [topic["id"] for topic in listed["topic_detail_list"]] == [older, newer]

    topic = {
        "id": "t",
        "domain": "开发",
        "topic_name": "n",
        "topic_summary": "",
        "topic_description": "",
        "create_time": "2026-11-19T00:00:00+00:00",
        "update_time": "2026-11-19T00:00:00+00:00",
        "sources": [],
        "decisions": [
            {"id": "plain", "content": "a", "time": "2026-11-19T03:00:00+00:00", "user_ids": ["x"]},
            {
                "id": "conflicted",
                "content": "b",
                "time": "2026-11-19T01:00:00+00:00",
                "user_ids": ["x"],
                "conflicts": [{"content": "c", "time": "2026-11-19T02:00:00+00:00"}],
            },
            {
                "id": "shared",
                "content": "d",
                "time": "2026-11-19T00:00:00+00:00",
                "user_ids": ["x", "y"],
            },
        ],
        "experiences": [
            {"id": "low", "time": "2026-11-19T00:00:00+00:00", "confidence": 0.9, "card": {}},
            {
                "id": "verified",
                "time": "2026-11-19T00:00:00+00:00",
                "confidence": 0.5,
                "exp_status": "verified",
                "card": {},
            },
        ],
        "timeline": [
            {"id": "late", "content": "2", "time": "2026-11-19T02:00:00+00:00"},
            {"id": "early", "content": "1", "time": "2026-11-19T01:00:00+00:00"},
        ],
    }
    snapshot = topic_snapshot(topic)
    assert [d.id for d in snapshot.decisions] == ["conflicted", "shared", "plain"]
    assert [e.id for e in snapshot.experiences] == ["verified", "low"]
    assert [t.id for t in snapshot.timeline] == ["early", "late"]
