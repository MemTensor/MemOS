"""HTTP retrieval against isolated schemas on PostgreSQL with pgvector and btree_gist."""

import os
import time

from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from memos.api.handlers.project_retrieval import ProjectAccess
from memos.api.product_models import SearchResponse
from memos.project_memory.add_store import PostgresAddStore
from memos.project_memory.index import Vector
from memos.project_memory.retrieval import ProjectRetrieval
from memos.project_memory.store import RetrievalStore


VECTOR = Vector(model="fixture", values=[1, 0, 0])


@pytest.fixture
def service():
    from psycopg2 import sql

    dsn = os.getenv("PG_TEST_DSN") or os.getenv("MEMOS_TEST_PROJECT_DSN")
    if not dsn:
        pytest.skip("Set PG_TEST_DSN to a PostgreSQL database with vector and btree_gist")
    db = PostgresAddStore(
        {"dsn": dsn, "schema_name": "read_" + uuid4().hex, "embedding_dimension": 3}
    )
    store = RetrievalStore(db.pool, db.schema_name)
    with store.cursor() as cur:
        cur.execute("""
          INSERT INTO spaces(id,project_id,space_name)
          VALUES ('A','tenant','A'),('B','tenant','B'),('C','other','C'),('empty','tenant','Empty');
          INSERT INTO domains(id,space_id,domain) VALUES ('dev','A','开发'),('ops','A','运维'),('b','B','开发');
          INSERT INTO topics(id,space_id,domain_id,topic_name,topic_summary,topic_description,
                             sources,conversation_ids,create_time,update_time)
          VALUES ('topic-db','A','dev','release','build summary','release notes',
            '[{"user_id":["author"],"conversation_id":"builder"}]','{builder}',now(),now());
          UPDATE topics SET embedding='[0,1,0]';
          INSERT INTO project_entries(id,topic_id,space_id,entry_type,content,chat_time,extra)
          VALUES ('decision-1','topic-db','A','decision','release now',now(),'{}'),
                 ('exp-1','topic-db','A','experience','test build',now(),
                   '{"card":{"task_intent":"test","problem":"build","principle":"cache"},"exp_status":"verified","confidence":0.8}'),
                 ('event-1','topic-db','A','timeline','release complete',now(),'{}');
          INSERT INTO project_entries(id,topic_id,space_id,entry_type,status,parent_decision_id,content,chat_time)
          VALUES ('old','topic-db','A','decision',1,'decision-1','release later',now());
          INSERT INTO messages(project_id,conversation_key,message_id,msg_seq,role,content,chat_time,accept_time,task_id,content_sha256)
          VALUES ('tenant','builder','u',1,'user','release plan',now(),now(),'job','fixture'),
                 ('tenant','builder','t',2,'tool','verbose output ERR409',now(),now(),'job','fixture'),
                 ('tenant','builder','a',3,'assistant','done',now(),now(),'job','fixture'),
                 ('tenant','builder','x',4,'user','hidden release',now(),now(),'job','fixture'),
                 ('tenant','second','u',1,'user','release release release',now(),now(),'job','fixture'),
                 ('other','builder','u',1,'user','foreign release',now(),now(),'job','fixture');
          INSERT INTO episodes(id,space_id,conversation_key,message_seq_start,message_seq_end,
                               topic_id,episode_summary,embedding,first_chat_time,last_chat_time)
          VALUES ('ep','A','builder',1,3,'topic-db','release summary','[1,0,0]',now(),now()),
                 ('ep2','A','second',1,1,'topic-db','lexical only',NULL,now(),now()),
                 ('other-ep','C','builder',1,1,NULL,'foreign summary','[1,0,0]',now(),now()),
                 ('partial','B','builder',2,4,NULL,NULL,NULL,now(),now());
          UPDATE messages SET tool_calls='[{"type":"function","id":"call","function":{"name":"build","arguments":"{}"}}]',tool_call_id='call'
            WHERE message_id='t' AND role='tool';
          INSERT INTO turns(project_id,conversation_key,turn_id,msg_ids,content,embedding)
          VALUES ('tenant','builder','u','{u,t,a}','release plan — build — done','[1,0,0]');
        """)
    retrieval = ProjectRetrieval(store, lambda _: VECTOR)
    try:
        yield retrieval
    finally:
        retrieval.close()
        with store.cursor() as cur:
            cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(db.schema_name)))
        db.close()


@pytest.fixture
def client(service):
    with patch(
        "memos.api.handlers.init_server",
        return_value={
            k: Mock()
            for k in (
                "mem_scheduler",
                "llm",
                "naive_mem_cube",
                "redis_client",
                "graph_db",
                "chat_llms",
                "searcher",
                "deepsearch_agent",
                "mem_reader",
                "feedback_server",
                "reranker",
            )
        },
    ):
        from memos.api.routers import server_router
    app = FastAPI()
    from fastapi import HTTPException

    from memos.api.exceptions import APIExceptionHandler

    app.add_exception_handler(HTTPException, APIExceptionHandler.http_error_handler)
    app.state.project_retrieval = service

    @app.middleware("http")
    async def fake_gateway(req, call_next):
        if req.headers.get("Authorization") == "Token test-member":
            req.state.project_access = ProjectAccess(
                "tenant", frozenset(("A", "B", "empty", "missing"))
            )
        return await call_next(req)

    app.include_router(server_router.router)
    with TestClient(app, headers={"Authorization": "Token test-member"}) as http:
        yield http


def search(client, query="release", views=("project",), **options):
    return client.post(
        "/product/search",
        json={
            "query": query,
            "user_id": "another-author",
            "space_ids": "A",
            "conversation_id": "builder",
            "include_memory_view": views,
            **options,
        },
    )


def get(client, id_, space="A", view="content"):
    return client.get("/product/get_memory/" + id_, params={"space_id": space, "view": view})


def hit_kind(row):
    if "topic_name" in row:
        return "topic"
    if "message_ids" in row:
        return "turn"
    return "message" if "role" in row else "episode"


def project_hits(data, *kinds):
    return [row for row in data["project_item_list"] if hit_kind(row) in kinds]


def test_three_paths_fuse_highest_messages_and_return_summaries(client, service):
    data = search(client).json()["data"]
    assert not data["degraded"]
    (topic,) = project_hits(data, "topic")
    assert topic["id"] == "topic-db"
    assert topic["decisions"][0]["history"][0]["content"] == "release later"
    assert [entry["id"] for entry in topic["timeline"]] == ["event-1"]
    hits = project_hits(data, "message", "turn")
    assert [(r["conversation_id"], r["message_id"]) for r in hits[:2]] == [
        ("builder", "u"),
        ("second", "u"),
    ]
    assert {r["message_id"] for r in hits} == {"u", "a", "t"}
    assert all("message_id" in r for r in hits)
    assert hits[0]["relativity"] > hits[1]["relativity"]
    assert [(r["id"], r["content"]) for r in project_hits(data, "episode")] == [
        ("ep", "release summary")
    ]
    assert (
        len(project_hits(search(client, memory_limit_number=1).json()["data"], "message", "turn"))
        <= 1
    )
    assert (
        sum(
            len(v)
            for k, v in search(client, memory_limit_number=2).json()["data"].items()
            if k.endswith("_list")
        )
        == 2
    )


def test_no_lexical_message_returns_only_turn_skeleton(client):
    data = search(client, "unmatched").json()["data"]
    (turn,) = project_hits(data, "message", "turn")
    assert "role" not in turn and turn["message_ids"] == ["u", "t", "a"]
    assert turn["content"] == "release plan — build — done"
    assert project_hits(data, "episode")[0]["content"] == "release summary"
    # A tool result may be read in B, but the Turn contains a user question outside B.
    assert not project_hits(
        search(client, "unmatched", space_ids="B").json()["data"], "message", "turn"
    )
    (tool,) = project_hits(
        search(client, "ERR409", space_ids="B").json()["data"], "message", "turn"
    )
    assert tool["message_id"] == "t"
    assert tool["tool_calls"][0]["function"] == {"name": "build", "arguments": "{}"}
    assert "ERR409" in tool["content"]


@pytest.mark.parametrize("embedding", [None, lambda _: Vector(model="fixture", values=[1, 0])])
def test_lexical_survives_unavailable_or_wrong_dimension_embedding(client, service, embedding):
    service.embed = embedding
    data = search(client).json()["data"]
    assert (
        project_hits(data, "message", "turn")
        and project_hits(data, "topic")
        and project_hits(data, "episode")
    )
    assert {"trajectory.vector", "episode.vector", "project.vector"} <= set(data["degraded"])
    assert all("message_id" in r for r in project_hits(data, "message", "turn"))
    assert not project_hits(search(client, "unknown").json()["data"], "message", "turn")


def test_domain_tenant_clear_and_partial_scope(client, service):
    assert search(client, space_ids=["A", "C"]).status_code == 404
    assert search(client, space_ids=["A", "missing"]).status_code == 404
    assert search(client, space_ids=["A", "B"], domains="运维").status_code == 400
    assert not project_hits(search(client, domains="运维").json()["data"], "message", "turn")
    with service.store.cursor() as cur:
        cur.execute("UPDATE spaces SET clear_time=clock_timestamp() WHERE id='A'")
        cur.execute("DELETE FROM topics WHERE space_id='A'")
    data = search(client).json()["data"]
    assert not (
        project_hits(data, "topic")
        or project_hits(data, "message", "turn")
        or project_hits(data, "episode")
    )
    assert get(client, "ep").status_code == 404
    assert get(client, "other-ep", "C").status_code == 404


def test_read_and_list_contract(client):
    topic = next(
        row for row in search(client).json()["data"]["project_item_list"] if "topic_name" in row
    )
    assert (topic["decisions"][0]["id"], topic["domain"]) == ("decision-1", "开发")
    assert get(client, "old").json()["data"]["id"] == "decision-1"
    detail = get(client, "topic-db").json()["data"]
    assert detail["experiences"][0]["card"]["principle"] == "cache"
    assert "content" not in get(client, "decision-1", view="metadata").json()["data"]
    listing = client.post(
        "/product/get_memory", json={"space_id": "A", "filter": {"related_id": "author"}}
    ).json()["data"]
    assert listing["total"] == 1 and listing["topic_detail_list"][0]["id"] == "topic-db"
    assert (
        client.post(
            "/product/get_memory", json={"space_id": "A", "filter": {"bogus": 1}}
        ).status_code
        == 400
    )
    assert "history" not in listing["topic_detail_list"][0]["decisions"][0]
    page = client.post(
        "/product/get_memory", json={"topic_id": "topic-db", "type": "decision"}
    ).json()["data"]
    assert page["total"] == 1 and page["entry_detail_list"][0]["history"]
    assert search(client, views=["trajectory"]).status_code == 400


def test_evidence_ids_and_message_read_are_scoped(client):
    assert get(client, "u").status_code == 409
    for kind, content in (("turn", "release plan — build — done"), ("message", "release plan")):
        response = client.get(
            "/product/get_memory/u",
            params={"space_id": "A", "conversation_id": "builder", "kind": kind},
        )
        assert response.json()["data"]["content"] == content
    assert get(client, "ep").json()["data"]["content"] == "release summary"
    msgs = client.post(
        "/product/get_message",
        json={"conversation_id": "builder", "space_id": "A", "message_limit_number": 2},
    ).json()["data"]
    assert [m["message_id"] for m in msgs["message_detail_list"]] == ["t", "a"]
    assert (
        client.post(
            "/product/get_message", json={"space_id": "C", "conversation_id": "builder"}
        ).status_code
        == 404
    )


def test_timeout_in_personal_recall_keeps_project_results(client):
    from memos.api.routers import server_router

    def slow_personal(_):
        time.sleep(0.7)
        return SearchResponse(message="ok", data={})

    with patch.object(
        server_router.search_handler, "handle_search_memories", side_effect=slow_personal
    ):
        data = search(client, views=["project", "detail_factual"]).json()["data"]
        assert "personal" in data["degraded"] and project_hits(data, "topic")


def test_lifespan_reuses_the_shared_database(service, monkeypatch):
    from memos.api.handlers.project_retrieval import project_retrieval_lifespan

    monkeypatch.setenv("PROJECT_MEMORY_POSTGRES_SCHEMA", service.store.schema)
    app = FastAPI()
    with project_retrieval_lifespan(app, {"project_db": SimpleNamespace(pool=service.store.pool)}):
        assert app.state.project_retrieval.store.pool is service.store.pool
        assert app.state.project_retrieval.store.schema == service.store.schema


def test_same_messages_shared_to_two_spaces_only_score_once(client, service):
    with service.store.cursor() as cur:
        cur.execute("UPDATE episodes SET message_seq_start=1 WHERE id='partial'")
    hits = project_hits(search(client, space_ids=["A", "B"]).json()["data"], "message", "turn")
    keys = [(row["conversation_id"], row["message_id"]) for row in hits]
    assert len(keys) == len(set(keys)) and keys[0] == ("builder", "u")
    turns = project_hits(
        search(client, "unmatched", space_ids=["A", "B"]).json()["data"], "message", "turn"
    )
    assert [row["id"] for row in turns] == ["u"]


def test_three_channel_search_latency(client, service):
    """In-process HTTP p95 for 10,000 topic headers with a deterministic query vector."""
    with service.store.cursor() as cur:
        # The request's SQL timeout does not apply to building the benchmark fixture.
        cur.execute("SET LOCAL statement_timeout=0")
        cur.execute("""INSERT INTO topics(id,space_id,domain_id,topic_name,topic_summary,topic_description,
                          create_time,update_time,embedding)
                       SELECT 'bench-'||n, 'A','dev','bench-'||n,'bench','',now(),now(),
                              ARRAY[0,1,n/10000.0]::vector
                       FROM generate_series(1,10000) n""")
        cur.execute("ANALYZE topics")
    samples = []
    for _ in range(51):
        start = time.perf_counter()
        data = search(client).json()["data"]
        samples.append((time.perf_counter() - start) * 1000)
        assert not data["degraded"]
        assert {hit_kind(row) for row in data["project_item_list"]} == {
            "topic",
            "episode",
            "message",
        }
    p95 = sorted(samples[1:])[47]
    print(f"Three-channel HTTP search (10,000 topics): p95 {p95:.1f} ms")
    assert p95 <= 500


def test_mixed_request_uses_core_threshold_and_personal_id_fallback(client):
    from memos.api.routers import server_router

    handler = server_router.search_handler
    cube = Mock()
    cube.search_memories.return_value = {
        "text_mem": [
            {
                "cube_id": "me",
                "memories": [
                    {
                        "id": "personal",
                        "memory": "release notes",
                        "metadata": {"relativity": 1, "memory_type": "WorkingMemory"},
                    }
                ],
            }
        ]
    }
    with (
        patch.object(handler, "_build_cube_view", return_value=cube),
        patch.object(
            handler, "_apply_relativity_threshold", wraps=handler._apply_relativity_threshold
        ) as threshold,
    ):
        data = search(
            client,
            views=["project", "detail_factual"],
            dedup="no",
            relativity=0,
        ).json()["data"]
    assert [m["id"] for m in threshold.call_args.args[0]["project_mem"][0]["memories"]] == [
        "topic-db"
    ]
    assert [m["id"] for m in data["memory_detail_list"]] == ["personal"]
    assert any(row["id"] == "topic-db" for row in data["project_item_list"])
    with patch.object(
        server_router.handlers.memory_handler,
        "handle_get_memory",
        return_value={"code": 200, "message": "ok", "data": {"id": "personal"}},
    ) as personal:
        assert client.get("/product/get_memory/personal").json()["data"] == {"id": "personal"}
        personal.assert_called_once()


def test_topic_current_session_boost_threshold_and_page_bounds(client, service):
    service.embed = None
    with service.store.cursor() as cur:
        cur.execute("""INSERT INTO topics(id,space_id,domain_id,topic_name,topic_summary,topic_description,
                          conversation_ids,create_time,update_time)
                       SELECT 't-'||n,'A','dev','repair','', '',
                              CASE WHEN n=29 THEN '{builder}'::text[] ELSE '{}'::text[] END,
                              now(), now() FROM generate_series(1,29) n""")

    def items(**kwargs):
        return search(client, "repair", **kwargs).json()["data"]["project_item_list"]

    hits = items(memory_limit_number=99)
    assert len(hits) == 25 and hits[0]["id"] == "t-29"
    assert len(items(memory_limit_number=0)) == 9
    assert [h["id"] for h in items(relativity=0.55)] == ["t-29"]
    page = client.post("/product/get_memory", json={"space_id": "A", "page": 50, "size": 1}).json()[
        "data"
    ]
    assert page["total"] == 30 and page["topic_detail_list"] == []


def test_project_view_returns_one_ranked_list(client):
    data = search(client).json()["data"]
    items = data["project_item_list"]
    assert not {"trajectory_detail_list", "episode_detail_list", "topic_detail_list"} & data.keys()
    assert {hit_kind(row) for row in items} == {"topic", "message", "episode"}
    assert all("id" in row and "relativity" in row for row in items)


def test_project_tool_input_survives_api_validation():
    from memos.api.product_models import APIADDRequest

    call = {"id": "call_1", "type": "function", "function": {"name": "run", "arguments": "{}"}}
    req = APIADDRequest(
        user_id="u",
        space_ids=["A"],
        allow_memory_view=["project"],
        messages=[
            {
                "message_id": "msg_7",
                "role": "tool",
                "tool_call_id": "call_1",
                "tool_calls": [call],
                "content": "success",
            }
        ],
    )
    assert req.model_dump()["messages"][0]["tool_calls"] == [call]


def test_topic_preview_caps_each_type_and_paginates_entries(client, service):
    with service.store.cursor() as cur:
        cur.execute("""INSERT INTO project_entries(id,topic_id,space_id,entry_type,content,chat_time,extra)
                       SELECT kind||n, 'topic-db', 'A', kind, 'entry '||n, now()+n*interval '1 day',
                              CASE WHEN kind='experience' THEN (SELECT extra FROM project_entries WHERE id='exp-1') ELSE '{}'::jsonb END
                       FROM unnest(ARRAY['decision','experience','timeline']) kind,generate_series(1,7) n""")
    topic = client.post("/product/get_memory", json={"space_id": "A"}).json()["data"][
        "topic_detail_list"
    ][0]
    for kind, field in (
        ("decision", "decisions"),
        ("experience", "experiences"),
        ("timeline", "timeline"),
    ):
        assert [r["id"] for r in topic[field]] == [f"{kind}{n}" for n in (7, 6, 5, 4, 3)]
        page = client.post(
            "/product/get_memory", json={"topic_id": "topic-db", "type": kind, "page": 2, "size": 3}
        ).json()["data"]
        assert page["total"] == 8
        assert [r["id"] for r in page["entry_detail_list"]] == [f"{kind}{n}" for n in (4, 3, 2)]
    assert (
        client.post(
            "/product/get_memory", json={"topic_id": "topic-db", "type": "decision", "size": 51}
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "params",
    [
        {"space_id": "A", "size": 51},
        {"space_id": "A", "topic_id": "topic-db", "type": "decision"},
        {"topic_id": "topic-db"},
    ],
)
def test_invalid_listing_does_not_fall_through_to_personal_memory(client, params):
    assert client.post("/product/get_memory", json=params).status_code == 422
