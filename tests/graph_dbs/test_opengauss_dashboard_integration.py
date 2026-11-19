"""Real Dashboard selection, pagination and HTTP contract (not service E2E)."""

import os

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from fastapi.testclient import TestClient

from memos.api.handlers.config_builders import build_graph_db_config
from memos.api.handlers.memory_handler import handle_get_memories_dashboard
from memos.api.product_models import GetMemoryDashboardRequest
from memos.graph_dbs.factory import GraphStoreFactory
from memos.memories.textual.tree import TreeTextMemory
from tests.api.test_server_router import mock_init_server
from tests.graph_dbs.test_opengauss_consumers_integration import environment as _environment
from tests.graph_dbs.test_opengauss_integration import _drop_test_graph, _query, sql
from tests.graph_dbs.test_opengauss_integration import database as _database


database, environment = _database, _environment
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)
KINDS = {
    "text_mem": "LongTermMemory",
    "tool_mem": "ToolTrajectoryMemory",
    "skill_mem": "SkillMemory",
    "pref_mem": "PreferenceMemory",
}
PUBLIC = {"and": [{"object_type": "public"}, {"mem_cube_id": "P"}]}
USER = {"object_type": "user", "mem_cube_id": "P"}


@pytest.fixture
def dashboard(environment, database, monkeypatch):
    admin, _ = database
    if _query(admin, "SELECT 1 FROM ag_catalog.ag_graph WHERE name='memos_graph'"):
        _drop_test_graph(admin)
    monkeypatch.setenv("MEMOS_USER_NAME", "A")
    graph = GraphStoreFactory.from_config(build_graph_db_config(None))
    try:
        for owner in ("A", "B", "P"):
            for category, kind in KINDS.items():
                metadata = {
                    "memory_type": kind,
                    "status": "activated",
                    "created_at": "2026-01-01T00:00:00Z",
                    "user_id": "public" if owner == "P" else "u",
                    "info": {"tag": "y" if owner == "B" else "x"},
                }
                graph.add_node(category, owner + ":" + category, metadata, user_name=owner)
        graph.add_node(
            "deleted", "excluded", {"memory_type": "LongTermMemory", "status": "deleted"}
        )
        for owner in ("A", "P"):
            graph.add_edge("text_mem", "tool_mem", "PARENT", user_name=owner)
        memory = TreeTextMemory.__new__(TreeTextMemory)
        memory.graph_store = graph
        yield SimpleNamespace(text_mem=memory)
    finally:
        graph.close()


@pytest.mark.parametrize(
    "fields,owners,total",
    [
        ({}, ["A"], 1),
        ({"all_cubes": None, "exclude_cube_id": None}, ["A"], 1),
        ({"mem_cube_id": "A"}, ["A"], 1),
        ({"all_cubes": False}, ["A"], 1),
        ({"all_cubes": True}, ["A", "B", "P"], 3),
        ({"all_cubes": True, "exclude_cube_id": "P"}, ["A", "B"], 2),
        ({"all_cubes": True, "exclude_cube_id": "X"}, ["A", "B", "P"], 3),
        ({"mem_cube_id": "P", "filter": PUBLIC}, ["P"], 1),
        ({"filter": USER}, ["A", "B"], 2),
        ({"all_cubes": True, "user_id": "u"}, ["A", "B"], 2),
        ({"filter": {"tag": "x"}}, ["A"], 1),
        ({"page": 2, "page_size": 2}, [], 1),
        ({"all_cubes": True, "page": 2, "page_size": 2, "exclude_cube_id": "P"}, [], 2),
        ({"mem_cube_id": "missing"}, [], 0),
    ],
)
def test_dashboard_real_categories_scopes_pages_and_statistics(dashboard, fields, owners, total):
    response = handle_get_memories_dashboard(GetMemoryDashboardRequest(**fields), dashboard)
    for category in KINDS:
        buckets = response.data[category]
        assert [bucket["cube_id"] for bucket in buckets] == owners
        for bucket in buckets:
            assert bucket["total_nodes"] == 1
            assert [(node["id"], node["memory"]) for node in bucket["memories"]] == [
                (category, bucket["cube_id"] + ":" + category)
            ]
    assert set(response.data["statistics"].values()) == {total}


def test_exclusion_applies_to_induced_edges_and_preserves_data(dashboard):
    graph = dashboard.text_mem.graph_store
    result = graph.export_graph(all_cubes=True, exclude_user_name="P")
    assert result["total_nodes"] == 8
    assert result["edges"] == [
        {"source": "text_mem", "target": "tool_mem", "type": "PARENT", "user_name": "A"}
    ]
    assert graph.export_graph(all_cubes=True)["total_nodes"] == 12


@pytest.mark.parametrize(
    "fields",
    [
        {"exclude_cube_id": "P"},
        {"mem_cube_id": "A", "filter": PUBLIC},
        {"mem_cube_id": "A", "filter": USER},
        {"filter": {"or": [PUBLIC, {"tag": "x"}]}},
        {"filter": {"or": [{}]}},
        {"all_cubes": True, "mem_cube_id": "A"},
        {"page": 1},
        {"page": 0, "page_size": 1},
        {"filter": {"tag": {"unknown": "x"}}},
    ],
)
def test_invalid_input_does_not_borrow_real_connection(dashboard, monkeypatch, fields):
    pool = dashboard.text_mem.graph_store.connection_pool
    borrow = Mock(wraps=pool.getconn)
    monkeypatch.setattr(pool, "getconn", borrow)
    with pytest.raises(ValueError):
        handle_get_memories_dashboard(GetMemoryDashboardRequest(**fields), dashboard)
    borrow.assert_not_called()


@pytest.fixture
def client(dashboard, monkeypatch, tmp_path):
    monkeypatch.setenv("FILE_LOCAL_PATH", str(tmp_path))
    with contextmanager(mock_init_server.__wrapped__)() as app:
        import memos.api.routers.server_router as router

        monkeypatch.setattr(router, "naive_mem_cube", dashboard)
        yield TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "payload,status",
    [
        ({}, 200),
        ({"all_cubes": None}, 200),
        ({"all_cubes": False}, 200),
        ({"all_cubes": True, "exclude_cube_id": "P"}, 200),
        ({"mem_cube_id": "missing"}, 200),
        ({"all_cubes": True, "page": 2, "page_size": 2, "exclude_cube_id": "P"}, 200),
        ({"all_cubes": True, "mem_cube_id": "A"}, 400),
        ({"filter": {"and": []}}, 400),
        ({"all_cubes": "false"}, 422),
        ({"exclude_cube_id": " "}, 422),
    ],
)
def test_http_optional_contract_errors_and_no_virtual_buckets(client, payload, status):
    response = client.post("/product/get_memory_dashboard", json=payload)
    assert response.status_code == status
    body = response.json()
    assert body["code"] == status
    if status != 200:
        assert body["data"] is None
    elif payload.get("mem_cube_id") == "missing" or payload.get("page") == 2:
        assert all(body["data"][category] == [] for category in KINDS)
        assert set(body["data"]["statistics"].values()) == (
            {2} if payload.get("page") == 2 else {0}
        )


def test_real_storage_failure_is_http_500_and_connection_recovers(client, dashboard, database):
    admin, config = database
    _query(
        admin,
        sql.SQL('REVOKE SELECT ON memos_graph."Memory" FROM {}').format(
            sql.Identifier(config.user)
        ),
    )
    try:
        response = client.post("/product/get_memory_dashboard", json={"all_cubes": True})
        assert response.status_code == 500
        assert response.json()["data"] is None
    finally:
        _query(
            admin,
            sql.SQL('GRANT SELECT ON memos_graph."Memory" TO {}').format(
                sql.Identifier(config.user)
            ),
        )
    assert dashboard.text_mem.graph_store.get_node("text_mem")["memory"] == "A:text_mem"
