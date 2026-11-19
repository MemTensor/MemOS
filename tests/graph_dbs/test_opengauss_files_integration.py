"""Actual Tree/Cube restoration and internal record HTTP contracts."""

import json
import os

from contextlib import contextmanager
from copy import deepcopy
from types import SimpleNamespace

import pytest

from fastapi.testclient import TestClient

from memos.api.config import APIConfig
from memos.exceptions import GraphDBError
from memos.mem_cube.general import GeneralMemCube
from memos.memories.textual.tree import TreeTextMemory
from tests.api.test_server_router import mock_init_server
from tests.graph_dbs.test_opengauss_consumers_integration import environment as _environment
from tests.graph_dbs.test_opengauss_consumers_integration import model_factories
from tests.graph_dbs.test_opengauss_integration import _query, sql
from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores, environment = _database, _stores, _environment
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


def seed(db):
    for owner in ("A", "B"):
        for key, state, vector in [
            ("active", "activated", [1, 0, 0]),
            ("archived", "archived", None),
            ("deleted", "deleted", [0, 1, 0]),
        ]:
            db.add_node(
                key,
                owner + ":" + key,
                {
                    "status": state,
                    "embedding": vector,
                    "memory_type": "LongTermMemory",
                    "created_at": {
                        "active": "2026-01-03",
                        "archived": "2026-01-02",
                        "deleted": "2026-01-01",
                    }[key],
                    "user_id": "u",
                    "tags": ["中文"],
                    "info": {"nested": {"x": 1}},
                },
                user_name=owner,
            )
        db.add_edge("active", "archived", "PARENT", user_name=owner)
        db.add_edge("archived", "deleted", "FOLLOWS", user_name=owner)


def tree(db):
    memory = TreeTextMemory.__new__(TreeTextMemory)
    memory.config = SimpleNamespace(memory_filename="memory.json")
    memory.graph_store = db
    return memory


@pytest.mark.parametrize("include", [False, True])
def test_tree_file_empty_and_merge_restore(stores, tmp_path, include):
    db = stores()
    seed(db)
    memory = tree(db)
    memory.dump(str(tmp_path), include_embedding=include, user_name="A")
    saved = json.loads((tmp_path / "memory.json").read_text())
    assert [n["id"] for n in saved["nodes"]] == ["active", "archived", "deleted"]
    assert [n["metadata"]["status"] for n in saved["nodes"]] == ["activated", "archived", "deleted"]
    assert all(n["metadata"]["user_name"] == "A" for n in saved["nodes"])
    assert saved["edges"] == [
        {"source": "active", "target": "archived", "type": "PARENT"},
        {"source": "archived", "target": "deleted", "type": "FOLLOWS"},
    ]
    if include:
        assert [n["metadata"]["embedding"] for n in saved["nodes"]] == [[1, 0, 0], None, [0, 1, 0]]
    else:
        assert all("embedding" not in n["metadata"] for n in saved["nodes"])
    other = db.export_graph(user_name="B", status=[], include_embedding=True)
    db.clear(user_name="A")
    memory.load(str(tmp_path), user_name="A")
    restored = db.export_graph(user_name="A", status=[], include_embedding=include)
    assert restored == saved
    db.add_node("extra", "outside backup", {}, user_name="A")
    db.add_edge("extra", "active", "PARENT", user_name="A")
    db.update_node("active", {"embedding": [0, 0, 1]}, user_name="A")
    memory.load(str(tmp_path), user_name="A")
    assert db.get_node("extra")["memory"] == "outside backup"
    assert len(db.export_graph(status=[])["edges"]) == 3
    assert db.get_node("active", include_embedding=True)["metadata"]["embedding"] == (
        [1, 0, 0] if include else None
    )
    assert db.export_graph(user_name="B", status=[], include_embedding=True) == other


def test_cube_dump_explicit_full_backup(environment, monkeypatch, tmp_path):
    monkeypatch.setenv("MEMOS_USER_NAME", "A")
    model_factories(monkeypatch)
    config = APIConfig.get_default_cube_config()
    config.text_mem.config.graph_db.config.user_name = "A"
    cube = GeneralMemCube(config)
    try:
        cube.text_mem.graph_store.clear(user_name="A")
        cube.text_mem.graph_store.clear(user_name="B")
        seed(cube.text_mem.graph_store)
        before = cube.text_mem.graph_store.export_graph(status=[], include_embedding=True)
        cube.dump(str(tmp_path))
        saved = json.loads((tmp_path / cube.text_mem.config.memory_filename).read_text())
        assert saved == before and saved["total_nodes"] == 3
        cube.text_mem.graph_store.clear()
        cube.load(str(tmp_path))
        assert cube.text_mem.graph_store.export_graph(status=[], include_embedding=True) == before
    finally:
        cube.close()


@pytest.mark.parametrize("failure", ["cross_cube", "dangling", "sql"])
def test_invalid_restore_and_database_fault_are_atomic(stores, database, tmp_path, failure):
    db = stores()
    seed(db)
    before = db.export_graph(all_cubes=True, status=[], include_embedding=True)
    data = deepcopy(db.export_graph(status=[], include_embedding=True))
    data["nodes"][0]["memory"] = "must not partially apply"
    if failure == "cross_cube":
        data["nodes"][-1]["metadata"]["user_name"] = "B"
    if failure == "dangling":
        data["edges"].append({"source": "active", "target": "absent", "type": "PARENT"})
    (tmp_path / "memory.json").write_text(json.dumps(data))
    admin, config = database
    if failure == "sql":
        _query(
            admin,
            sql.SQL('REVOKE UPDATE ON memos_graph."Memory" FROM {}').format(
                sql.Identifier(config.user)
            ),
        )
    try:
        with pytest.raises(ValueError if failure == "cross_cube" else GraphDBError):
            tree(db).load(str(tmp_path), user_name="A")
    finally:
        if failure == "sql":
            _query(
                admin,
                sql.SQL('GRANT UPDATE ON memos_graph."Memory" TO {}').format(
                    sql.Identifier(config.user)
                ),
            )
    assert db.export_graph(all_cubes=True, status=[], include_embedding=True) == before


@pytest.fixture
def internal(stores, monkeypatch, tmp_path):
    db = stores()
    seed(db)
    db.add_node("unique", "one owner", {}, user_name="B")
    monkeypatch.setenv("FILE_LOCAL_PATH", str(tmp_path))
    with contextmanager(mock_init_server.__wrapped__)() as app:
        import memos.api.routers.server_router as router

        monkeypatch.setattr(router, "graph_db", db)
        yield TestClient(app, raise_server_exceptions=False), db


def test_internal_ownership_and_record_side_effects(internal):
    client, db = internal

    def post(route, body, status=200):
        result = client.post("/product/" + route, json=body)
        assert result.status_code == status, result.text
        return result.json()["data"]

    assert post("get_user_names_by_memory_ids", {"memory_ids": ["unique", "absent"]}) == {
        "unique": "B",
        "absent": None,
    }
    post("get_user_names_by_memory_ids", {"memory_ids": ["active"]}, 500)
    assert post("exist_mem_cube_id", {"mem_cube_id": "A"}) == {"A": True}
    assert post("exist_mem_cube_id", {"mem_cube_id": "absent"}) == {"absent": False}
    before_b = db.export_graph(user_name="B", status=[], include_embedding=True)
    post("delete_memory_by_record_id", {"mem_cube_id": "A", "record_id": "batch1"})
    assert db.get_node("active")["metadata"]["status"] == "deleted"
    assert db.get_node("archived")["metadata"]["status"] == "deleted"
    assert db.get_node("deleted")["metadata"].get("delete_record_id") is None
    post("recover_memory_by_record_id", {"mem_cube_id": "A", "delete_record_id": "absent"})
    assert db.get_node("active")["metadata"]["status"] == "deleted"
    post("recover_memory_by_record_id", {"mem_cube_id": "A", "delete_record_id": "batch1"})
    assert db.get_node("active")["metadata"]["status"] == "activated"
    assert db.get_node("archived")["metadata"]["status"] == "activated"
    assert db.get_node("deleted")["metadata"]["status"] == "deleted"
    post("delete_memory_by_record_id", {"mem_cube_id": "missing", "record_id": "zero"})
    assert db.export_graph(user_name="B", status=[], include_embedding=True) == before_b


@pytest.mark.parametrize(
    "route,payload",
    [
        ("get_user_names_by_memory_ids", {"memory_ids": ["unique"]}),
        ("exist_mem_cube_id", {"mem_cube_id": "A"}),
        ("delete_memory_by_record_id", {"mem_cube_id": "A", "record_id": "batch"}),
        ("recover_memory_by_record_id", {"mem_cube_id": "A", "delete_record_id": "batch"}),
    ],
)
def test_internal_storage_failure_is_not_success(internal, database, route, payload):
    client, db = internal
    admin, config = database
    before = db.export_graph(all_cubes=True, status=[], include_embedding=True)
    _query(
        admin,
        sql.SQL('REVOKE SELECT ON memos_graph."Memory" FROM {}').format(
            sql.Identifier(config.user)
        ),
    )
    try:
        result = client.post("/product/" + route, json=payload)
        assert result.status_code == 500 and result.json()["data"] is None
    finally:
        _query(
            admin,
            sql.SQL('GRANT SELECT ON memos_graph."Memory" TO {}').format(
                sql.Identifier(config.user)
            ),
        )
    assert db.export_graph(all_cubes=True, status=[], include_embedding=True) == before
