"""Integration with actual PostgreSQL/pgvector. Only the upstream producers and auth are fixtures."""

import os
import time

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from memos.api.handlers.project_retrieval import ProjectAccess
from memos.api.product_models import SearchResponse
from memos.project_memory.index import Topic, Turn, Vector, replace_snapshot, set_embedding
from memos.project_memory.retrieval import ProjectRetrieval
from memos.project_memory.store import RetrievalStore


NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
VECTOR = Vector(model="fixture-model", values=[1, 0, 0])
TOPIC = Topic.model_validate(
    {
        "id": "topic-db",
        "domain": "开发",
        "topic_name": "数据存储",
        "topic_summary": "完整摘要",
        "topic_description": "完整描述",
        "create_time": "2025-01",
        "update_time": "2026-01",
        "sources": [{"conversation_id": "builder", "user_id": ["author"]}],
        "decisions": [
            {
                "id": "decision-1",
                "content": "目前采用 PostgreSQL",
                "time": "2026",
                "user_ids": ["author"],
                "history": [
                    {
                        "content": "旧版使用 SQLite",
                        "reason": "多成员写入冲突",
                        "time": "2025",
                        "user_ids": ["author"],
                    }
                ],
                "conflicts": [
                    {"content": "建议保留文件方案", "time": "2026", "user_ids": ["reviewer"]}
                ],
            }
        ],
        "experiences": [
            {"id": "exp-1", "content": "清理索引可回收空间", "time": "2026", "user_ids": ["author"]}
        ],
        "timeline": [
            {"id": "event-1", "content": "灰度上线", "time": "2026", "user_ids": ["author"]}
        ],
    }
)
TURN = Turn(
    id="turn-1",
    turn_id="local-1",
    conversation_id="builder",
    source_task_id="task-1",
    user_id="author",
    agent_id="memmy",
    chat_time="2026",
    content=("visible\n" * 300) + "SQLite ERR409",
    topic_ids=[TOPIC.id],
    message_ids=["msg-1"],
    domains=["开发"],
)


@pytest.fixture(scope="module")
def pool(tmp_path_factory):
    pg = pytest.importorskip("psycopg2")
    from psycopg2 import sql
    from psycopg2.pool import ThreadedConnectionPool

    dsn = os.getenv("MEMOS_TEST_PROJECT_DSN")
    if not dsn:
        pgserver = pytest.importorskip(
            "pgserver", reason="Set MEMOS_TEST_PROJECT_DSN or install pgserver"
        )
        server = pgserver.get_server(tmp_path_factory.mktemp("project_pg"))
        dsn = server.get_uri()
    # Never install schemas or delete rows in the supplied database.
    db = "pm_test_" + uuid4().hex
    admin = pg.connect(dsn)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db)))
        pool = ThreadedConnectionPool(1, 12, pg.extensions.make_dsn(dsn, dbname=db))
        try:
            conn = pool.getconn()
            try:
                with conn, conn.cursor() as cur:
                    cur.execute("""
                       CREATE SCHEMA memos_project;
                       CREATE TABLE memos_project.pm_spaces (tenant_id text,space_id text PRIMARY KEY,
                           cleared_at timestamptz,deleted_at timestamptz);
                       CREATE TABLE memos_project.pm_domains(space_id text,domain text);
                       INSERT INTO memos_project.pm_spaces(tenant_id,space_id)
                           VALUES ('tenant','A'),('tenant','B'),('other','C'),('tenant','empty');
                       INSERT INTO memos_project.pm_domains VALUES ('A','开发'),('B','开发'),('C','开发');
                    """)
                    from memos.project_memory import index

                    cur.execute(Path(index.__file__).with_name("schema.sql").read_text())
            finally:
                pool.putconn(conn)
            yield pool
        finally:
            pool.closeall()
    finally:
        with admin.cursor() as cur:
            cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db)))
        admin.close()


@pytest.fixture
def service(pool):
    store = RetrievalStore(pool)
    with store.cursor() as cur:
        cur.execute("TRUNCATE memos_project.pm_retrieval_roots CASCADE")
        cur.execute("TRUNCATE memos_project.pm_retrieval_log")
        for tenant, space in (("tenant", "A"), ("tenant", "B"), ("other", "C")):
            for snapshot in (TOPIC, TURN):
                replace_snapshot(cur, tenant, space, snapshot.id, 1, NOW, snapshot)
    retrieval = ProjectRetrieval(store)
    yield retrieval
    retrieval.close()


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


def search(client, query="SQLite", views=("project",), **options):
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


def test_decision_history_matches_and_ids_resolve(client, service):
    data = search(client).json()["data"]
    assert data["degraded"] == ["project.vector"]
    assert "trajectory_detail_list" not in data
    (topic,) = data["topic_detail_list"]
    assert topic["topic_description"] == TOPIC.topic_description
    assert topic["topic_summary"] == TOPIC.topic_summary
    assert topic["experiences"] == topic["timeline"] == []
    assert "sources" not in topic and "create_time" not in topic
    (decision,) = topic["decisions"]
    assert decision == TOPIC.decisions[0].model_dump(exclude_none=True)
    for id_, kind in (("decision-1", "decision"), ("exp-1", "experience"), ("event-1", "timeline")):
        item = get(client, id_).json()["data"]
        assert (item["kind"], item["topic_id"], item["cache_policy"]) == (kind, TOPIC.id, "live")
        assert (
            "content" in item and "content" not in get(client, id_, view="metadata").json()["data"]
        )
    assert get(client, TOPIC.id).json()["data"]["sources"] == TOPIC.sources
    with service.store.cursor() as cur:
        cur.execute(
            "SELECT decision_ids,conflicting_decision_ids FROM memos_project.pm_retrieval_log"
        )
        assert cur.fetchall() == [(["decision-1"], ["decision-1"])]


def test_trajectory_is_scoped_chunked_and_retractable(client, service):
    (turn,) = search(client, views=["trajectory"]).json()["data"]["trajectory_detail_list"]
    assert "ERR409" in turn["content"] and len(turn["content"]) <= 2000
    assert get(client, TURN.id).json()["data"]["content"] == TURN.content
    with service.store.cursor() as cur:
        replace_snapshot(
            cur,
            "tenant",
            "A",
            TURN.id,
            2,
            NOW,
            TURN.model_copy(update={"content": "short excerpt"}),
        )
    assert not search(client, views=["trajectory"]).json()["data"]["trajectory_detail_list"]
    assert get(client, TURN.id).json()["data"]["content"] == "short excerpt"
    with service.store.cursor() as cur:
        assert replace_snapshot(cur, "tenant", "A", TURN.id, 3, NOW, None)
        assert not replace_snapshot(cur, "tenant", "A", TURN.id, 1, NOW, TURN)
    assert get(client, TURN.id).status_code == 404
    assert get(client, TURN.id, "B").status_code == 200


def test_space_domain_and_identity_validation(client):
    for spaces in ([], [""], ["A", None], None, ["A"] * 21):
        assert search(client, space_ids=spaces).status_code == 422
    for domains in (None, "", []):
        assert search(client, domains=domains).status_code == 422
    assert search(client, domains=["unknown"]).status_code == 400
    assert search(client, domains="开发").json()["data"]["topic_detail_list"]
    assert search(client, user_id=" ").status_code == 422
    assert search(client, space_ids=["A", "missing"]).status_code == 404
    assert search(client, space_ids="empty").json()["data"]["topic_detail_list"] == []
    assert search(client, query="据").json()["data"]["topic_detail_list"][0]["id"] == TOPIC.id
    assert get(client, TURN.id, "C").status_code == 404
    assert search(client, space_ids="C").status_code == 404


def test_mixed_search_vector_ranking_budget_and_fallback(client, service):
    service.embed = Mock(return_value=VECTOR)
    with service.store.cursor() as cur:
        assert set_embedding(cur, "tenant", "A", TOPIC.id, 1, "exp-1", 0, VECTOR)
        assert not set_embedding(cur, "tenant", "A", TOPIC.id, 0, "exp-1", 0, VECTOR)
    from memos.api.routers import server_router

    views = ["project", "trajectory", "detail_factual"]
    with patch.object(
        server_router.search_handler,
        "handle_search_memories",
        return_value=SearchResponse(
            message="ok",
            data={"text_mem": [{"memories": [{"id": "fact", "memory": "SQLite fact"}]}]},
        ),
    ) as personal:
        result = search(client, views=views, memory_limit_number=2).json()["data"]
        assert result["channels"] == ["personal", "project", "trajectory"]
        assert (
            sum(
                len(result[k])
                for k in ("memory_detail_list", "trajectory_detail_list", "topic_detail_list")
            )
            == 2
        )
        assert result["truncated"]
        assert personal.call_args.args[0].include_memory_view == views
    service.embed.assert_called_once()
    (hit,) = search(client, query="no-lexical-match").json()["data"]["topic_detail_list"]
    assert hit["experiences"][0]["id"] == "exp-1"
    service.embed.side_effect = OSError()
    with patch.object(
        server_router.search_handler, "handle_search_memories", side_effect=TimeoutError()
    ):
        result = search(client, views=views).json()["data"]
        assert "personal" in result["degraded"] and "project.vector" in result["degraded"]
        assert result["topic_detail_list"] and result["trajectory_detail_list"]


def test_shared_turn_and_topic_latency(client, service):
    from memos.api.routers import server_router

    size = 1000
    dimension = 384
    with service.store.cursor() as cur:
        for i in range(size):
            values = [0.0] * dimension
            values[i % dimension] = 1.0
            vector = Vector(model="fixture-model", values=values)
            for snapshot in (
                TOPIC.model_copy(
                    update={
                        "id": f"bench-topic-{i}",
                        "decisions": [],
                        "experiences": [],
                        "timeline": [],
                    }
                ),
                TURN.model_copy(update={"id": f"bench-turn-{i}", "content": f"release step {i}"}),
            ):
                replace_snapshot(cur, "tenant", "empty", snapshot.id, 1, NOW, snapshot)
                assert set_embedding(cur, "tenant", "empty", snapshot.id, 1, snapshot.id, 0, vector)
        cur.execute("ANALYZE memos_project.pm_retrieval_items")
    service.embed = lambda query: Vector(
        model="fixture-model", values=[1.0] + [0.0] * (dimension - 1)
    )
    personal = SearchResponse(
        message="ok", data={"text_mem": [{"memories": [{"id": "fact", "memory": "release facts"}]}]}
    )
    with patch.object(
        server_router.search_handler, "handle_search_memories", return_value=personal
    ):
        for views in (["trajectory"], ["project", "trajectory", "detail_factual"]):
            times = []
            for _ in range(51):
                start = time.perf_counter()
                response = search(client, "release", views=views, space_ids="empty")
                times.append(1000 * (time.perf_counter() - start))
                data = response.json()["data"]
                assert data["degraded"] == [] and data["trajectory_detail_list"]
                if "project" in views:
                    assert data["topic_detail_list"] and data["memory_detail_list"]
            p95 = sorted(times[1:])[47]
            print(f"{'+'.join(views)}: {len(times) - 1} requests, P95 {p95:.1f} ms")
            assert p95 <= 500


def test_authorized_id_lookup_and_immutable_invalidation(client, service):
    turn = TURN.model_copy(update={"id": "sealed", "content": "final", "cache_policy": "immutable"})
    with service.store.cursor() as cur:
        replace_snapshot(cur, "tenant", "A", turn.id, 1, NOW, turn)
    lookup = "/product/get_memory/sealed"
    assert client.get(lookup).json()["data"]["content"] == "final"
    assert (
        client.get(lookup, params={"view": "metadata"}).json()["data"]["cache_policy"]
        == "immutable"
    )
    assert client.get("/product/get_memory/turn-1").status_code == 409
    with service.store.cursor() as cur:
        replace_snapshot(
            cur, "tenant", "A", turn.id, 2, NOW, turn.model_copy(update={"content": "redacted"})
        )
    assert client.get(lookup, params={"view": "metadata"}).json()["data"]["cache_policy"] == "live"
    assert client.get(lookup).json()["data"]["content"] == "redacted"


def test_real_domain_filter_and_deleted_space(client, service):
    with service.store.cursor() as cur:
        cur.execute("INSERT INTO memos_project.pm_domains VALUES ('A','运维')")
        second = TOPIC.model_copy(
            update={
                "id": "ops",
                "domain": "运维",
                "decisions": [],
                "experiences": [],
                "timeline": [],
            }
        )
        replace_snapshot(cur, "tenant", "A", second.id, 1, NOW, second)
    assert [
        x["id"] for x in search(client, "数据", domains="运维").json()["data"]["topic_detail_list"]
    ] == ["ops"]
    try:
        with service.store.cursor() as cur:
            cur.execute("UPDATE memos_project.pm_spaces SET cleared_at=now() WHERE space_id='A'")
            assert not replace_snapshot(cur, "tenant", "A", TOPIC.id, 5, NOW, TOPIC)
        assert not search(client).json()["data"]["topic_detail_list"]
        assert get(client, TOPIC.id).status_code == 404
        with service.store.cursor() as cur:
            cur.execute("UPDATE memos_project.pm_spaces SET deleted_at=now() WHERE space_id='A'")
        assert search(client, space_ids=["B", "A"]).status_code == 404
        assert get(client, TOPIC.id, "B").status_code == 200
    finally:
        with service.store.cursor() as cur:
            cur.execute(
                "UPDATE memos_project.pm_spaces SET deleted_at=NULL,cleared_at=NULL WHERE space_id='A'"
            )
            cur.execute("DELETE FROM memos_project.pm_domains WHERE domain='运维'")


def test_index_queries_keep_scores_and_scopes(service):
    from memos.project_memory.store import IndexQuery, MissingSpaceError, Scope

    scope = Scope("tenant", ("A", "B"), ("开发",))
    results = service.store.query_index(
        scope,
        "entry",
        [IndexQuery("q1", "SQLite"), IndexQuery("q2", "上线")],
        4,
        topic_ids=[TOPIC.id],
        conversation_id="builder",
    )
    for group, id_ in zip(results["results"], ["decision-1", "event-1"], strict=True):
        assert {h["id"] for h in group["hits"]} == {id_}
        assert {h["space_id"] for h in group["hits"]} == {"A", "B"}
        assert all(h["scores"]["lexical"] > 0 and h["from_conversation"] for h in group["hits"])
    assert results["degraded"] == ["vector"]
    assert not service.store.query_index(
        scope, "entry", [IndexQuery("q", "SQLite")], 4, topic_ids=[]
    )["results"][0]["hits"]
    with pytest.raises(MissingSpaceError):
        service.store.query_index(Scope("other", ("A",)), "trajectory", [], 4)


def test_slow_personal_channel_cannot_hold_back_a_project_hit(client):
    from memos.api.routers import server_router

    def slow_personal(_):
        time.sleep(0.7)
        return SearchResponse(message="ok", data={})

    with patch.object(
        server_router.search_handler, "handle_search_memories", side_effect=slow_personal
    ):
        start = time.perf_counter()
        result = search(client, views=["project", "detail_factual"]).json()["data"]
        assert time.perf_counter() - start < 0.5
        assert result["degraded"] == ["personal", "project.vector"] and result["topic_detail_list"]


def test_mismatched_vector_keeps_fulltext_results(client, service):
    with service.store.cursor() as cur:
        set_embedding(cur, "tenant", "A", TOPIC.id, 1, TOPIC.id, 0, VECTOR)
    for vector in (
        Vector(model="new-model", values=VECTOR.values),
        Vector(model=VECTOR.model, values=[1.0, 0.0]),
    ):
        service.embed = lambda _, vector=vector: vector
        data = search(client, "SQLite").json()["data"]
        assert data["degraded"] == ["project.vector"] and data["topic_detail_list"]
        assert not search(client, "unrelated").json()["data"]["topic_detail_list"]


def test_engineering_requests_need_only_the_retrieval_database(client, service, monkeypatch):
    from contextlib import asynccontextmanager

    from memos.api.handlers.project_retrieval import project_retrieval_lifespan
    from memos.api.routers import server_router

    conn = service.store.pool.getconn()
    try:
        monkeypatch.setenv("MEMOS_PROJECT_MEMORY_DSN", conn.dsn)
    finally:
        service.store.pool.putconn(conn)
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_TENANT_ID", raising=False)
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_GATEWAY_KEY", raising=False)
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_INTERNAL", raising=False)

    @asynccontextmanager
    async def lifespan(app):
        with project_retrieval_lifespan(app, {}):
            yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(server_router.router)
    with TestClient(app) as gateway:
        assert search(gateway).status_code == 200
        assert search(gateway).json()["data"]["topic_detail_list"][0]["id"] == TOPIC.id
        assert get(gateway, "exp-1").json()["data"]["content"] == TOPIC.experiences[0].content
        assert (
            search(gateway, space_ids="C").json()["data"]["topic_detail_list"][0]["space_id"] == "C"
        )
        assert search(gateway, space_ids=["A", "C"]).status_code == 404
        assert get(gateway, "exp-1", "missing").status_code == 404
        assert (
            gateway.post("/product/get_memory", json={"space_id": "B"}).json()["data"]["total"] == 1
        )
        assert gateway.get("/product/get_memory/exp-1").status_code == 409
        unique = TOPIC.model_copy(
            update={"id": "only-in-C", "decisions": [], "experiences": [], "timeline": []}
        )
        with service.store.cursor() as cur:
            replace_snapshot(cur, "other", "C", unique.id, 1, NOW, unique)
            cur.execute("SELECT DISTINCT tenant_id,space_id FROM memos_project.pm_retrieval_log")
            assert set(cur.fetchall()) == {("tenant", "A"), ("other", "C")}
        assert (
            gateway.get("/product/get_memory/only-in-C").json()["data"]["topic_detail_list"][0][
                "space_id"
            ]
            == "C"
        )


def test_review_read_contract(client):
    result = search(
        client,
        project_result_format="item",
        project_item_types=["decision"],
        memory_limit_number=0,
        relativity=0,
    ).json()
    assert result["code"] == 200
    assert "topic_detail_list" not in result["data"]
    (decision,) = result["data"]["project_item_list"]
    assert (decision["id"], decision["topic_id"], decision["domain"]) == (
        "decision-1",
        TOPIC.id,
        "开发",
    )
    detail = client.get("/product/get_memory/decision-1", params={"space_id": "A"}).json()
    assert detail["data"]["project_item_list"][0]["topic_name"] == TOPIC.topic_name
    listing = client.post(
        "/product/get_memory", json={"space_id": "A", "size": 1, "filter": {"related_id": "author"}}
    )
    assert listing.json()["data"]["topic_detail_list"][0]["sources"] == TOPIC.sources
    assert search(client, project_item_types=["bogus"]).status_code == 400


def test_review_full_and_compact_components(client, service):
    fields = TOPIC.model_dump()
    fields["sources"] = [
        {"conversation_id": "current", "user_id": ["author"], "agent_id": ["agent-x"]}
    ]
    source = {"conversation_id": "current", "message_id": "first", "quote": "the evidence"}
    fields["decisions"][0].update(user_labels={"author": "甲"}, source=source)
    fields["decisions"][0]["history"][0].update(source=source, change_source=source)
    fields["decisions"][0]["conflicts"][0]["source"] = source
    fields["experiences"][0].update(
        exp_status="candidate",
        confidence=0.65,
        task_intent="清理索引",
        lifecycle="active",
        card={"task_intent": "清理索引", "problem": "容量", "principle": "回收空间"},
        version=3,
        sources=[{"chat_time": "2001-01-01T00:00:00Z", "signal": "test"}],
    )
    fields["timeline"] = [
        {
            "id": "late",
            "content": "release final",
            "time": "2020-01-02T01:00:00+08:00",
            "user_ids": [],
        },
        {"id": "early", "content": "release beta", "time": "2020-01-01T12:00:00Z", "user_ids": []},
    ]
    with service.store.cursor() as cur:
        replace_snapshot(cur, "tenant", "A", TOPIC.id, 2, NOW, Topic.model_validate(fields))
    short = search(client, "SQLite").json()["data"]["topic_detail_list"][0]["decisions"][0]
    assert short["user_labels"] == {"author": "甲"} and "source" not in short
    assert "change_source" not in short["history"][0] and "source" not in short["conflicts"][0]
    exp = search(
        client, "索引", project_result_format="item", project_item_types=["experience"]
    ).json()["data"]["project_item_list"][0]
    assert (
        exp["task_intent"] == "清理索引"
        and exp["lifecycle"] == "stale"
        and exp["confidence"] == 0.65
    )
    assert not {"sources", "version", "card"} & exp.keys()
    item = client.get("/product/get_memory/exp-1", params={"space_id": "A"}).json()["data"][
        "project_item_list"
    ][0]
    assert item["version"] == 3 and item["sources"] and item["card"]
    full = client.get("/product/get_memory/" + TOPIC.id, params={"space_id": "A"}).json()["data"][
        "topic_detail_list"
    ][0]
    assert full["decisions"][0]["history"][0]["change_source"] == source
    assert [t["id"] for t in full["timeline"]] == ["early", "late"]
    assert (
        search(client, "release", project_item_types=["timeline"]).json()["data"][
            "topic_detail_list"
        ][0]["timeline"]
        == full["timeline"]
    )


def test_review_session_scores_limit_and_domain_errors(client, service):
    with service.store.cursor() as cur:
        cur.execute("INSERT INTO memos_project.pm_domains VALUES ('A','A-only')")
        for i in range(29):
            snapshot = TOPIC.model_copy(
                update={
                    "id": f"topic-limit-{i}",
                    "topic_name": "rebuild",
                    "sources": [
                        {"conversation_id": "boost" if i == 28 else "other", "user_id": ["user"]}
                    ],
                    "decisions": [],
                    "timeline": [],
                    "experiences": [],
                }
            )
            replace_snapshot(cur, "tenant", "A", snapshot.id, 1, NOW, snapshot)
    opts = {
        "project_result_format": "item",
        "project_item_types": ["topic"],
        "conversation_id": "boost",
    }
    items = search(client, "rebuild", memory_limit_number=99, **opts).json()["data"][
        "project_item_list"
    ]
    assert len(items) == 25 and items[0]["id"] == "topic-limit-28"
    assert items[0]["relativity"] - items[1]["relativity"] == pytest.approx(0.1)
    assert (
        len(
            search(client, "rebuild", memory_limit_number=0, **opts).json()["data"][
                "project_item_list"
            ]
        )
        == 9
    )
    assert (
        len(
            search(client, "rebuild", relativity=items[1]["relativity"] + 0.01, **opts).json()[
                "data"
            ]["project_item_list"]
        )
        == 1
    )
    bad = search(client, space_ids=["A", "B"], domains="A-only")
    assert bad.status_code == 400 and bad.json()["reason"] == "DOMAIN_NOT_REGISTERED"
    assert search(client, space_ids=None).json()["reason"] == "SCOPE_REQUIRED"
    assert search(client, space_ids="missing").json()["reason"] == "SPACE_NOT_FOUND"
    assert search(client, project_result_format="flat").json()["reason"] == "INVALID_PARAM"


def test_review_list_pages_time_and_sources(client, service):
    with service.store.cursor() as cur:
        for i in range(3):
            snapshot = TOPIC.model_copy(
                update={
                    "id": f"list-{i}",
                    "update_time": f"2026-05-0{i + 1}T03:00:00+08:00",
                    "sources": [
                        {"user_id": ["member"], "agent_id": "codex" if i == 1 else ["codex"]}
                    ],
                    "decisions": [],
                    "experiences": [],
                    "timeline": [],
                }
            )
            replace_snapshot(cur, "tenant", "A", snapshot.id, 1, NOW, snapshot)
    url = "/product/get_memory"

    def page(**opts):
        return client.post(url, json={"space_id": "A", **opts})

    filt = {
        "related_id": {"contains": "codex"},
        "update_time": {"gte": "2026-05-01", "lt": "2026-05-03"},
    }
    result = page(page_size=1, page=2, filter=filt).json()["data"]
    assert result["total"] == 2 and [t["id"] for t in result["topic_detail_list"]] == ["list-0"]
    assert len(page(filter={"related_id": "member"}).json()["data"]["topic_detail_list"]) == 3
    assert page(page_size=1, page=9, filter=filt).json()["data"]["total"] == 2
    for invalid in (
        {"related_id": ["member"]},
        {"related_id": {"in": ["member"]}},
        {"update_time": {"foo": "2025"}},
    ):
        assert page(filter=invalid).json()["reason"] == "INVALID_FILTER"


def test_review_messages_use_committed_message_store(client, service):
    from types import SimpleNamespace

    def message(id_, role, content, second):
        return SimpleNamespace(
            id=id_,
            role=role,
            text=content,
            chat_time=f"2026-02-01T00:00:0{second}Z",
            user_id="",
            name="",
            tool_name="Bash",
            tool_args="test",
        )

    original = message("1", "member", "first", 0)
    tool = message("2", "tool", "result", 1)
    reply = message("3", "agent", "done", 2)
    by_space = {
        "A": [original, tool],
        "B": [original, reply],
        "C": [message("4", "agent", "outside", 3)],
    }
    writer = Mock()
    writer.list_messages.side_effect = (
        lambda space, conv: by_space.get(space, []) if conv == "s" else []
    )
    service.message_store = writer

    def read(**opts):
        return client.post("/product/get_message", json={"conversation_id": "s", **opts})

    result = read(user_id="other", message_limit_number=2).json()
    assert result["code"] == 200
    assert [m["message_id"] for m in result["data"]["message_detail_list"]] == ["2", "3"]
    assert result["data"]["message_detail_list"][0]["tool_args"] == "test"
    assert [m["role"] for m in read(space_id="A").json()["data"]["message_detail_list"]] == [
        "user",
        "tool",
    ]
    assert read(space_id="C").status_code == 404 and all(
        c.args[0] != "C" for c in writer.list_messages.call_args_list
    )


def test_mixed_request_uses_core_threshold_and_unknown_id_falls_back(client):
    from memos.api.routers import server_router

    handler = server_router.search_handler
    original = handler._apply_relativity_threshold
    observed = []

    def threshold(results, relativity):
        observed.extend(m["id"] for b in results["project_mem"] for m in b["memories"])
        return original(results, relativity)

    cube = Mock()
    cube.search_memories.return_value = {
        "text_mem": [
            {
                "cube_id": "me",
                "memories": [
                    {
                        "id": "personal",
                        "memory": "SQLite note",
                        "metadata": {"relativity": 1.0, "memory_type": "WorkingMemory"},
                    }
                ],
            }
        ]
    }
    with (
        patch.object(handler, "_build_cube_view", return_value=cube),
        patch.object(handler, "_apply_relativity_threshold", side_effect=threshold),
    ):
        data = search(
            client,
            views=["project", "detail_factual"],
            dedup="no",
            relativity=0,
            project_result_format="item",
            project_item_types=["decision"],
        ).json()["data"]
    assert observed == ["decision-1"]
    assert (
        data["project_item_list"][0]["id"] == "decision-1"
        and data["memory_detail_list"][0]["id"] == "personal"
    )
    assert cube.search_memories.call_count == 1
    with patch.object(
        server_router.handlers.memory_handler,
        "handle_get_memory",
        return_value={"code": 200, "message": "ok", "data": {"id": "personal-only"}},
    ) as legacy:
        assert (
            client.get("/product/get_memory/personal-only").json()["data"]["id"] == "personal-only"
        )
        legacy.assert_called_once()


def test_fixed_tenant_still_restricts_internal_reads(client, service, monkeypatch):
    from memos.api.routers import server_router

    monkeypatch.setenv("MEMOS_PROJECT_MEMORY_TENANT_ID", "tenant")
    new = TOPIC.model_copy(
        update={"id": "unique-topic", "decisions": [], "experiences": [], "timeline": []}
    )
    with service.store.cursor() as cur:
        replace_snapshot(cur, "tenant", "B", new.id, 1, NOW, new)
    client.headers.pop("Authorization")
    assert (
        client.get("/product/get_memory/" + new.id).json()["data"]["topic_detail_list"][0]["id"]
        == new.id
    )
    assert search(client, space_ids="C").json()["reason"] == "SPACE_NOT_FOUND"
    with patch.object(
        server_router.handlers.memory_handler,
        "handle_get_memory",
        return_value={"code": 200, "message": "ok", "data": {"id": "personal-id"}},
    ):
        client.headers["Authorization"] = "Token personal-key"
        assert client.get("/product/get_memory/personal-id").json()["data"] == {"id": "personal-id"}


def test_internal_messages_without_tenant_or_credentials(client, service, monkeypatch):
    from memos.api.routers import server_router

    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_TENANT_ID", raising=False)
    app = FastAPI()
    app.state.project_retrieval = service
    app.include_router(server_router.router)
    message = {"message_id": "m1", "role": "user", "chat_time": "2026-02-01", "content": "hello"}
    by_space = {"A": [message], "B": [message]}
    service.message_store = Mock()
    service.message_store.list_messages.side_effect = (
        lambda space, conv: by_space.get(space, []) if conv == "conv" else []
    )
    with TestClient(app) as internal:

        def read(**options):
            return internal.post(
                "/product/get_message", json={"conversation_id": "conv", **options}
            )

        assert read().json()["data"]["message_detail_list"] == [message]
        by_space["C"] = [message]
        assert read().status_code == 409
        assert read(space_id="B").json()["data"]["message_detail_list"] == [message]


def test_project_database_is_used_for_search_and_add_without_separate_dsn(service, monkeypatch):
    from types import SimpleNamespace

    from memos.api.handlers.project_retrieval import project_retrieval_lifespan
    from memos.plugins.manager import PluginManager
    from memos.project_memory.config import postgres_config
    from memos.project_memory.plugin import CommunityProjectMemoryPlugin
    from memos.project_memory.store import Scope

    monkeypatch.setenv("PROJECT_DB_BACKEND", "postgres")
    monkeypatch.setenv("PROJECT_DB_HOST", "deployment-db")
    monkeypatch.setenv("PROJECT_MEMORY_GRAPH_DB", "sqlite")
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_DSN", raising=False)
    monkeypatch.delenv("MEMOS_ENABLED_PLUGINS", raising=False)
    plugin = CommunityProjectMemoryPlugin()
    assert PluginManager._is_plugin_enabled(plugin)
    assert postgres_config()["retrieval_index"]
    app = FastAPI()
    pool = service.store.pool
    components = {"project_db": SimpleNamespace(pool=pool)}
    plugin.init_components({"shared": components})
    assert plugin._uses_episode_store()
    with project_retrieval_lifespan(app, components):
        store = app.state.project_retrieval.store
        assert store.pool is pool
        assert store.get(Scope("tenant", ("A",), ()), "decision-1", False)["id"] == "decision-1"
    assert not pool.closed
