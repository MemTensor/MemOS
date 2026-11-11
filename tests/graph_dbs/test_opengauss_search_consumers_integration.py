"""Real graph candidates through existing ranking/API/dispatcher consumers.

Models are controlled; this is not a live-model or deployed-service E2E test.
"""

import os

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from fastapi.testclient import TestClient

from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import APISearchRequest
from memos.exceptions import GraphDBError
from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import RunningTaskItem
from memos.mem_scheduler.task_schedule_modules.dispatcher import SchedulerDispatcher
from memos.memories.textual.tree_text_memory.retrieve.recall import GraphMemoryRetriever
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from tests.api.test_server_router import mock_init_server
from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import (
    database as _database,
)
from tests.graph_dbs.test_opengauss_integration import (
    stores as _stores,
)


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


@pytest.fixture
def pipeline(stores):
    db = stores()
    for owner, key, memory, vector in [
        ("A", "00000000-0000-0000-0000-000000000001", "apple orchard", [1, 0, 0]),
        ("A", "00000000-0000-0000-0000-000000000002", "apple harvest", [1, 0, 0]),
        ("B", "00000000-0000-0000-0000-000000000001", "blue ocean", [0, 1, 0]),
        ("B", "00000000-0000-0000-0000-000000000002", "sailing yachts", [0, 1, 0]),
        ("B", "00000000-0000-0000-0000-000000000003", "星港 travel", None),
    ]:
        db.add_node(
            key,
            memory,
            {
                "embedding": vector,
                "memory_type": "LongTermMemory",
                "status": "activated",
                "created_at": "2026-01-01T00:00:00Z",
            },
            user_name=owner,
        )
    embedder = Mock()
    embedder.embed.return_value = [[0, 0, 1]]
    retriever = GraphMemoryRetriever(db, embedder, include_embedding=True)

    def vector_search(**kwargs):
        return retriever._vector_recall(
            [[1, 1, 0]],
            "LongTermMemory",
            top_k=kwargs["top_k"],
            user_name=kwargs["user_name"],
            search_filter=kwargs.get("search_filter"),
        )

    # Control only model/query work; run the real DataVec candidate consumer and SingleCube paths.
    searcher = Searcher.__new__(Searcher)
    searcher.graph_store = db
    searcher.embedder = embedder
    searcher.reranker = None
    searcher._extract_weighted_keyword_terms = Mock(return_value=["星港"])
    searcher.retrieve = lambda **kw: searcher._retrieve_from_keyword(
        kw["query"],
        None,
        [[1, 1, 0]],
        kw["top_k"],
        "LongTermMemory",
        user_name=kw["user_name"],
        search_filter=kw.get("search_filter"),
        rerank=False,
    )
    scheduler = Mock()
    scheduler.retriever.enhance_memories_with_query.side_effect = lambda **kw: (
        kw["memories"],
        None,
    )
    mixture = SimpleNamespace(
        config=SimpleNamespace(use_redis_queue=True),
        searcher=searcher,
        api_module=Mock(get_history_memories=Mock(return_value=[])),
        history_memory_turns=1,
        reranker=Mock(rerank=Mock(return_value=[])),
        submit_memory_history_async_task=Mock(),
    )
    scheduler.mix_search_memories = lambda **kw: OptimizedScheduler.mix_search_memories(
        mixture, **kw
    )
    handler = SearchHandler(
        HandlerDependencies(
            naive_mem_cube=SimpleNamespace(text_mem=SimpleNamespace(search=vector_search)),
            mem_reader=Mock(),
            mem_scheduler=scheduler,
            searcher=searcher,
            deepsearch_agent=Mock(),
            reranker=None,
        )
    )
    yield db, handler, searcher


@pytest.mark.parametrize(
    "dedup,top_k,expected",
    [
        (
            "no",
            4,
            [
                (
                    "A",
                    [
                        "00000000-0000-0000-0000-000000000001",
                        "00000000-0000-0000-0000-000000000002",
                    ],
                ),
                (
                    "B",
                    [
                        "00000000-0000-0000-0000-000000000001",
                        "00000000-0000-0000-0000-000000000002",
                    ],
                ),
            ],
        ),
        (
            "sim",
            1,
            [
                ("A", ["00000000-0000-0000-0000-000000000001"]),
                ("B", ["00000000-0000-0000-0000-000000000001"]),
            ],
        ),
        (
            "mmr",
            1,
            [
                ("A", ["00000000-0000-0000-0000-000000000001"]),
                ("B", ["00000000-0000-0000-0000-000000000001"]),
            ],
        ),
    ],
)
def test_real_candidates_final_identity_order_and_no_mutation(pipeline, dedup, top_k, expected):
    db, handler, _ = pipeline
    before = db.export_graph(all_cubes=True, status=[], include_embedding=True)
    req = APISearchRequest(
        query="query",
        user_id="u",
        readable_cube_ids=["A", "B", "A"],
        dedup=dedup,
        top_k=top_k,
        mode="fast",
        relativity=0,
    )
    result = handler.handle_search_memories(req).data["text_mem"]
    assert [(b["cube_id"], [m["id"] for m in b["memories"]]) for b in result] == expected
    for bucket in result:
        for mem in bucket["memories"]:
            assert mem["memory"] in (
                {"apple orchard", "apple harvest"}
                if bucket["cube_id"] == "A"
                else {"blue ocean", "sailing yachts"}
            )
            assert mem["metadata"]["relativity"] == pytest.approx((1 + 2**-0.5) / 2)
    assert db.export_graph(all_cubes=True, status=[], include_embedding=True) == before


def test_keyword_missing_embedding_and_valid_empty(pipeline):
    db, handler, searcher = pipeline
    pairs = searcher.retrieve(query="星港", top_k=10, user_name="B")
    assert [m.id for m, _ in pairs] == ["00000000-0000-0000-0000-000000000003"]
    node = pairs[0][0].model_dump()
    assert node["metadata"]["embedding"] is None
    assert handler._extract_embeddings([node]) == [[0, 0, 1]]
    searcher.embedder.embed.assert_called_once_with(["星港 travel"])
    assert (
        db.get_node("00000000-0000-0000-0000-000000000003", include_embedding=True, user_name="B")[
            "metadata"
        ]["embedding"]
        is None
    )
    assert searcher.retrieve(query="星港", top_k=10, user_name="A") == []


@pytest.fixture
def client(pipeline, monkeypatch, tmp_path):
    monkeypatch.setenv("FILE_LOCAL_PATH", str(tmp_path))
    with contextmanager(mock_init_server.__wrapped__)() as app:
        import memos.api.routers.server_router as router

        monkeypatch.setattr(router, "search_handler", pipeline[1])
        yield TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("mode", ["fast", "fine", "mixture"])
@pytest.mark.parametrize("fault", ["sql", "filter"])
def test_required_reads_fail_through_actual_modes_and_http(pipeline, database, client, mode, fault):
    from psycopg2 import sql

    db, handler, _ = pipeline
    admin, config = database
    payload = {
        "query": "query",
        "user_id": "u",
        "readable_cube_ids": ["A", "B"],
        "mode": mode,
        "dedup": "no",
    }
    if fault == "filter":
        payload["filter"] = {"and": [{"tag": {"unknown": "x"}}]}
    else:
        _query(
            admin,
            sql.SQL('REVOKE SELECT ON memos_graph."Memory" FROM {}').format(
                sql.Identifier(config.user)
            ),
        )
    try:
        with pytest.raises(GraphDBError if fault == "sql" else ValueError):
            handler.handle_search_memories(APISearchRequest(**payload))
        response = client.post("/product/search", json=payload)
        assert response.status_code == (500 if fault == "sql" else 400), response.text
        assert response.json()["data"] is None
    finally:
        if fault == "sql":
            _query(
                admin,
                sql.SQL('GRANT SELECT ON memos_graph."Memory" TO {}').format(
                    sql.Identifier(config.user)
                ),
            )
    assert db.get_node("00000000-0000-0000-0000-000000000001")["memory"] == "apple orchard"


def test_scheduler_marks_required_storage_failure_failed(pipeline, database):
    from psycopg2 import sql

    db, handler, _ = pipeline
    admin, config = database
    tracker = Mock()
    dispatcher = SchedulerDispatcher(max_workers=1, metrics=Mock(), status_tracker=tracker)
    message = ScheduleMessageItem(
        item_id="required-search", user_id="u", mem_cube_id="A", label="query", content="query"
    )
    task = RunningTaskItem(
        user_id="u",
        mem_cube_id="A",
        task_info="required read",
        task_name="query",
        messages=[message],
    )
    dispatcher._running_tasks[task.item_id] = task
    req = APISearchRequest(query="query", user_id="u", readable_cube_ids=["A", "B"], mode="fast")
    work = dispatcher._create_task_wrapper(
        lambda messages: handler.handle_search_memories(req), task
    )
    _query(
        admin,
        sql.SQL('REVOKE SELECT ON memos_graph."Memory" FROM {}').format(
            sql.Identifier(config.user)
        ),
    )
    try:
        future = dispatcher.dispatcher_executor.submit(work, [message])
        with pytest.raises(GraphDBError):
            future.result(timeout=10)
        assert task.status == "failed"
        tracker.task_failed.assert_called_once()
        assert tracker.task_failed.call_args.kwargs["error_message"]
        tracker.task_completed.assert_not_called()
    finally:
        dispatcher.close()
        _query(
            admin,
            sql.SQL('GRANT SELECT ON memos_graph."Memory" TO {}').format(
                sql.Identifier(config.user)
            ),
        )
