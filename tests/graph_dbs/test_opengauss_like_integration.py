"""Literal LIKE and default Feedback writes against ordinary-role openGauss."""

import os
import uuid

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError
from memos.mem_feedback.simple_feedback import SimpleMemFeedback
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
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


def test_like_pattern_scopes_status_projection_and_order(stores):
    db = stores()
    for owner in ["B", "A"]:
        for key, text in [
            ("quote", "星港 O'Reilly"),
            ("percent", "a%b"),
            ("underscore", "a_b"),
            ("wild", "acb"),
            ("slash", "a\\b"),
            ("empty", ""),
        ]:
            db.add_node(
                key,
                text,
                {
                    "memory_type": "LongTermMemory",
                    "status": "activated",
                    "user_id": "u",
                    "embedding": [1, 0, 0],
                    "info": {"tag": "x"},
                },
                user_name=owner,
            )
    db.add_node("archived", "星港", {"status": "archived", "memory_type": "UserMemory"})
    for pattern, expected in [
        ("%O'Reilly%", ["quote"]),
        ("%星港%", ["quote"]),
        ("a_b", ["percent", "slash", "underscore", "wild"]),
        (r"a\%b", ["percent"]),
        (r"a\_b", ["underscore"]),
        (r"a\\b", ["slash"]),
        ("", ["empty"]),
        ("acb", ["wild"]),
        ("%missing%", []),
    ]:
        assert db.search_by_keywords_like(pattern) == [{"id": key} for key in expected]
    assert db.search_by_keywords_like("%星港%", status="archived", scope="UserMemory") == [
        {"id": "archived"}
    ]
    assert db.search_by_keywords_like("%", search_filter={"user_id": "absent"}) == []
    assert db.search_by_keywords_like("%", filter={"info.tag": "missing"}) == []
    result = db.search_by_keywords_like(
        "%星港%",
        knowledgebase_ids=["B", "A"],
        return_fields=["memory", "embedding", "user_name", "absent"],
    )
    assert result == [
        {
            "id": "quote",
            "memory": "星港 O'Reilly",
            "embedding": [1, 0, 0],
            "user_name": owner,
            "absent": None,
        }
        for owner in ["A", "B"]
    ]
    assert db.search_by_keywords_like("%星港%", knowledgebase_ids=["B"]) == [
        {"id": "quote", "user_name": owner} for owner in ["A", "B"]
    ]
    with pytest.raises(ValueError):
        db.search_by_keywords_like("bad\\")
    assert db.search_by_keywords_like("acb") == [{"id": "wild"}]


def test_like_has_no_hidden_limit(stores):
    db = stores()
    db.add_nodes_batch(
        [
            {"id": str(i).zfill(4), "memory": "many targets", "metadata": {"status": "activated"}}
            for i in range(1001)
        ]
    )
    assert db.search_by_keywords_like("%targets%") == [{"id": str(i).zfill(4)} for i in range(1001)]


@pytest.fixture
def feedback(stores):
    db = stores()
    embedder = Mock(config=SimpleNamespace(embedding_dims=3))
    embedder.embed.side_effect = lambda texts, **kwargs: [[0, 1, 0] for _ in texts]
    manager = MemoryManager(
        db,
        embedder,
        Mock(),
        memory_size={"WorkingMemory": 100, "LongTermMemory": 100, "UserMemory": 100},
        is_reorganize=False,
    )
    fb = SimpleMemFeedback(
        Mock(), embedder, db, manager, SimpleNamespace(memory_version_switch="off"), Mock(), Mock()
    )
    fb._keyword_replace_judgement = Mock(
        return_value={
            "if_keyword_replace": "true",
            "original": "旧词",
            "target": "新词",
            "doc_scope": "NONE",
        }
    )
    fb._generate_answer = Mock(return_value="updated")
    return db, fb


@pytest.mark.parametrize("kind", ["WorkingMemory", "LongTermMemory"])
def test_default_feedback_keyword_replacement_real_mutation(feedback, kind):
    db, fb = feedback
    ids = {key: str(uuid.uuid5(uuid.NAMESPACE_DNS, key)) for key in ["target", "other", "deleted"]}
    for owner, key, agent, state in [
        ("A", "target", "app", "activated"),
        ("B", "target", "app", "activated"),
        ("A", "other", "else", "activated"),
        ("A", "deleted", "app", "deleted"),
    ]:
        db.add_node(
            ids[key],
            "旧词 内容",
            {
                "memory_type": kind,
                "status": state,
                "tags": ["旧词"],
                "embedding": [1, 0, 0],
                "info": {"agent_id": agent},
            },
            user_name=owner,
        )
    before_b = db.export_graph(user_name="B", status=[], include_embedding=True)
    assert fb.DB_IDX_READY is False
    result = fb.process_feedback(
        "u", "A", [], "请将旧词改为新词", info={"agent_id": "app"}, corrected_answer=True
    )
    updates = result["record"]["update"]
    assert result["answer"] == "updated" and len(updates) == 1 and result["record"]["add"] == []
    new_id = updates[0]["id"]
    uuid.UUID(new_id)
    assert updates[0]["origin_memory"] == "旧词 内容" and updates[0]["archived_id"] == ids["target"]
    node = db.get_node(new_id, include_embedding=True)
    assert node["memory"] == "新词 内容" and node["metadata"]["tags"] == ["新词"]
    assert node["metadata"]["embedding"] == [0, 1, 0] and node["metadata"]["memory_type"] == kind
    if kind == "WorkingMemory":
        assert new_id == ids["target"]
    else:
        assert (
            new_id != ids["target"]
            and db.get_node(ids["target"])["metadata"]["status"] == "archived"
        )
        assert node["metadata"]["covered_history"] == ids["target"]
    assert db.get_node(ids["other"])["memory"] == "旧词 内容"
    assert db.get_node(ids["deleted"])["metadata"]["status"] == "deleted"
    assert db.export_graph(user_name="B", status=[], include_embedding=True) == before_b
    expected_ids = {new_id}
    if kind == "LongTermMemory":
        working_id = node["metadata"]["working_binding"]
        assert working_id != new_id
        working = db.get_node(working_id, include_embedding=True)
        assert working["metadata"]["memory_type"] == "WorkingMemory"
        assert working["memory"] == "新词 内容" and working["metadata"]["embedding"] == [0, 1, 0]
        expected_ids.add(working_id)
    assert db.search_by_keywords_like("%新词%") == [{"id": value} for value in sorted(expected_ids)]
    assert new_id in [n["id"] for n in db.search_by_embedding([0, 1, 0], scope=kind)]
    assert new_id in [n["id"] for n in db.search_by_fulltext(["新词"], scope=kind)]


@pytest.mark.parametrize(
    "permission,kind",
    [("SELECT", "WorkingMemory"), ("UPDATE", "WorkingMemory"), ("CONSTRAINT", "LongTermMemory")],
)
def test_default_feedback_sql_error_visible_and_recovers(feedback, database, permission, kind):
    from psycopg2 import sql

    db, fb = feedback
    key = str(uuid.uuid4())
    db.add_node(key, "旧词 内容", {"memory_type": kind, "status": "activated", "tags": []})
    admin, config = database
    if permission == "CONSTRAINT":
        _query(
            admin,
            "ALTER TABLE memos_graph.\"Memory\" ADD CONSTRAINT reject_feedback CHECK (memory <> '新词 内容')",
        )
    else:
        _query(
            admin,
            sql.SQL("REVOKE " + permission + ' ON memos_graph."Memory" FROM {}').format(
                sql.Identifier(config.user)
            ),
        )
    try:
        with pytest.raises(GraphDBError):
            fb.process_feedback("u", "A", [], "替换")
    finally:
        if permission == "CONSTRAINT":
            _query(admin, 'ALTER TABLE memos_graph."Memory" DROP CONSTRAINT reject_feedback')
        else:
            _query(
                admin,
                sql.SQL("GRANT " + permission + ' ON memos_graph."Memory" TO {}').format(
                    sql.Identifier(config.user)
                ),
            )
    assert db.get_node(key)["memory"] == "旧词 内容"
    assert db.get_node(key)["metadata"]["status"] == "activated"


def test_answer_failure_preserves_real_feedback_update(feedback):
    db, fb = feedback
    key = str(uuid.uuid4())
    db.add_node(
        key, "旧词 内容", {"memory_type": "WorkingMemory", "status": "activated", "tags": []}
    )
    fb._generate_answer = Mock(side_effect=ValueError("optional model failure"))
    result = fb.process_feedback("u", "A", [], "替换", corrected_answer=True)
    assert result["answer"] == "" and result["answer_status"] == "unavailable"
    assert result["record"]["update"][0]["id"] == key
    assert db.get_node(key)["memory"] == "新词 内容"


def test_feedback_http_and_actual_scheduler_handler_fail_on_storage(
    feedback, database, monkeypatch, tmp_path
):
    import json

    from contextlib import contextmanager

    from fastapi.testclient import TestClient
    from psycopg2 import sql

    from memos.api.handlers.base_handler import HandlerDependencies
    from memos.api.handlers.feedback_handler import FeedbackHandler
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.mem_scheduler.schemas.task_schemas import RunningTaskItem
    from memos.mem_scheduler.task_schedule_modules.dispatcher import SchedulerDispatcher
    from memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler import (
        FeedbackMessageHandler,
    )
    from tests.api.test_server_router import mock_init_server

    db, fb = feedback
    db.add_node(
        str(uuid.uuid4()), "旧词 内容", {"memory_type": "WorkingMemory", "status": "activated"}
    )
    api = FeedbackHandler(
        HandlerDependencies(
            mem_reader=Mock(),
            mem_scheduler=Mock(),
            searcher=Mock(),
            reranker=Mock(),
            feedback_server=fb,
        )
    )
    context = Mock()
    context.get_feedback_server.return_value = fb
    scheduler_handler = FeedbackMessageHandler(context)
    tracker = Mock()
    dispatcher = SchedulerDispatcher(max_workers=1, metrics=Mock(), status_tracker=tracker)
    payload = {
        "user_id": "u",
        "writable_cube_ids": ["A"],
        "history": [],
        "feedback_content": "替换",
        "async_mode": "sync",
    }
    msg = ScheduleMessageItem(
        item_id="feedback-fault",
        user_id="u",
        mem_cube_id="A",
        label="mem_feedback",
        content=json.dumps(payload),
    )
    task = RunningTaskItem(
        user_id="u", mem_cube_id="A", task_info="feedback", task_name="feedback", messages=[msg]
    )
    dispatcher._running_tasks[task.item_id] = task
    admin, config = database
    _query(
        admin,
        sql.SQL('REVOKE SELECT ON memos_graph."Memory" FROM {}').format(
            sql.Identifier(config.user)
        ),
    )
    monkeypatch.setenv("FILE_LOCAL_PATH", str(tmp_path))
    try:
        with contextmanager(mock_init_server.__wrapped__)() as app:
            import memos.api.routers.server_router as router

            monkeypatch.setattr(router, "feedback_handler", api)
            response = TestClient(app, raise_server_exceptions=False).post(
                "/product/feedback", json=payload
            )
            assert response.status_code == 500 and response.json()["data"] is None
        future = dispatcher.dispatcher_executor.submit(
            dispatcher._create_task_wrapper(scheduler_handler, task), [msg]
        )
        with pytest.raises(GraphDBError):
            future.result(timeout=10)
        assert task.status == "failed"
        tracker.task_failed.assert_called_once()
        tracker.task_completed.assert_not_called()
    finally:
        dispatcher.close()
        _query(
            admin,
            sql.SQL('GRANT SELECT ON memos_graph."Memory" TO {}').format(
                sql.Identifier(config.user)
            ),
        )


def test_like_discards_terminated_connection_and_recovers(stores, database):
    db = stores(maxconn=1)
    db.add_node("one", "recover", {})
    with db._get_connection() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        pid = cursor.fetchone()[0]
    admin, _ = database
    _query(admin, "SELECT pg_terminate_backend(%s)", (pid,))
    with pytest.raises(GraphDBError):
        db.search_by_keywords_like("%recover%")
    assert db.search_by_keywords_like("%recover%") == [{"id": "one"}]
