"""Reorganizer candidate projection and optimize_structure control flow."""

import json

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.memories.textual.tree_text_memory.organize import reorganizer as module
from tests.graph_dbs.test_postgres_400_compat import postgres_db as _postgres_db


postgres_db = _postgres_db


@pytest.fixture
def case():
    graph = MagicMock()
    graph.node_not_exist.return_value = 0
    graph.get_memory_count.return_value = 20
    graph.get_structure_optimization_candidates.return_value = [
        {
            "id": f"00000000-0000-4000-8000-{i:012}",
            "memory": "fixture",
            "metadata": {"memory_type": "LongTermMemory", "embedding": [1, 0, 0]},
        }
        for i in range(20)
    ]
    instance = module.GraphStructureReorganizer(graph, MagicMock(), MagicMock(), False)
    instance._is_optimizing = {"LongTermMemory": False, "UserMemory": False}
    instance._partition = MagicMock(side_effect=lambda nodes: [nodes])
    instance._process_cluster_and_write = MagicMock()
    return instance, graph


def test_candidate_embedding_and_cube_reach_nonempty_partition(case):
    instance, graph = case
    instance.optimize_structure(user_name="B")
    graph.get_structure_optimization_candidates.assert_called_once_with(
        "LongTermMemory", include_embedding=True, user_name="B"
    )
    nodes = instance._partition.call_args.args[0]
    assert len(nodes) == 20 and all(n.metadata.embedding == [1, 0, 0] for n in nodes)
    instance._process_cluster_and_write.assert_called_once_with(nodes, "LongTermMemory", 10, 4, "B")
    assert not instance._is_optimizing["LongTermMemory"]


@pytest.mark.parametrize("reason", ["busy", "missing", "empty", "too-small", "no-groups"])
def test_early_returns_do_not_submit_clusters(case, reason):
    instance, graph = case
    if reason == "busy":
        instance._is_optimizing["LongTermMemory"] = True
    elif reason == "missing":
        graph.node_not_exist.return_value = 1
    elif reason in {"empty", "too-small"}:
        graph.get_structure_optimization_candidates.return_value = (
            []
            if reason == "empty"
            else graph.get_structure_optimization_candidates.return_value[:19]
        )
    else:
        instance._partition.return_value = []
        instance._partition.side_effect = None
    instance.optimize_structure(user_name="A")
    instance._process_cluster_and_write.assert_not_called()
    assert instance._is_optimizing["LongTermMemory"] == (reason == "busy")
    if reason in {"busy", "missing"}:
        graph.get_structure_optimization_candidates.assert_not_called()


@pytest.mark.parametrize("stage", [1, 2, 3, 4])
def test_each_deadline_resets_busy_flag(case, monkeypatch, stage):
    instance, _ = case
    logger = MagicMock()
    monkeypatch.setattr(module, "logger", logger)
    monkeypatch.setattr(
        module, "time", SimpleNamespace(time=MagicMock(side_effect=[0] * stage + [601]))
    )
    instance.optimize_structure()
    logger.error.assert_called_once()
    assert not instance._is_optimizing["LongTermMemory"]
    assert instance._process_cluster_and_write.call_count == int(stage == 4)


def test_candidate_failure_propagates_and_cluster_failure_is_logged(case, monkeypatch):
    instance, graph = case
    graph.get_structure_optimization_candidates.side_effect = ValueError("candidate failure")
    with pytest.raises(ValueError, match="candidate failure"):
        instance.optimize_structure()
    assert not instance._is_optimizing["LongTermMemory"]
    graph.get_structure_optimization_candidates.side_effect = None
    instance._process_cluster_and_write.side_effect = ValueError("cluster failure")
    logger = MagicMock()
    monkeypatch.setattr(module, "logger", logger)
    assert instance.optimize_structure() is None
    assert "Cluster processing failed" in logger.warning.call_args.args[0]
    assert not instance._is_optimizing["LongTermMemory"]


@pytest.mark.parametrize("backend", ["neo4j", "polardb", "postgres"])
def test_existing_candidate_methods_return_requested_embedding(backend, postgres_db):
    props = {
        "id": "memory-1",
        "memory": "fixture",
        "status": "activated",
        "memory_type": "LongTermMemory",
        "user_name": "tenant-a",
    }
    if backend == "neo4j":
        from memos.graph_dbs.neo4j import Neo4jGraphDB

        db = Neo4jGraphDB.__new__(Neo4jGraphDB)
        db.config = SimpleNamespace(user_name="tenant-a", use_multi_db=False)
        db.db_name = "test"
        db.driver = MagicMock()
        db.driver.session.return_value.__enter__.return_value.run.return_value = [
            {"id": "memory-1", "node": {**props, "embedding": [1, 0, 0]}}
        ]
    elif backend == "polardb":
        from memos.graph_dbs.polardb import PolarDBGraphDB

        db = PolarDBGraphDB.__new__(PolarDBGraphDB)
        db.config = {"user_name": "tenant-a"}
        db.db_name = "test"
        db._get_connection = MagicMock()
        cursor = db._get_connection.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = [("[1,0,0]", json.dumps({"properties": props}) + "::vertex")]
    else:
        db, cursor = postgres_db
        cursor.fetchall.return_value = [
            ("memory-1", "fixture", props, None, None, "[1,0,0]", "tenant-a")
        ]
    result = db.get_structure_optimization_candidates(
        "LongTermMemory", include_embedding=True, user_name="tenant-a"
    )
    assert len(result) == 1 and result[0]["id"] == "memory-1"
    assert result[0]["metadata"]["embedding"] == [1, 0, 0]
