"""Nonempty real Reorganizer -> AGE writes, controlling only model services."""

import json
import os
import re
import uuid

from datetime import datetime
from unittest.mock import MagicMock

import pytest

from memos.memories.textual.tree_text_memory.organize.reorganizer import GraphStructureReorganizer
from tests.graph_dbs.test_opengauss_integration import database as _database
from tests.graph_dbs.test_opengauss_integration import stores as _stores


database, stores = _database, _stores
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)
GROUPS = [
    [f"00000000-0000-4000-8000-{i:012}" for i in range(start, start + 12)] for start in (1, 13)
]


def seed(db):
    for index, keys in enumerate(GROUPS):
        db.add_nodes_batch(
            [
                {
                    "id": key,
                    "memory": f"group-{index} child {key}",
                    "metadata": {
                        "memory_type": "LongTermMemory",
                        "status": "activated",
                        "key": f"group-{index}",
                        "embedding": [1, 0, 0] if index == 0 else [0, 1, 0],
                        "created_at": "2000-01-01T00:00:00",
                        "updated_at": "2000-01-01T00:00:00",
                    },
                }
                for key in keys
            ]
        )
    db.add_node(
        GROUPS[0][0],
        "foreign",
        {"status": "activated", "memory_type": "LongTermMemory"},
        user_name="B",
    )


def controlled_models(db, action=None):
    llm, embedder = MagicMock(), MagicMock()

    def generate(messages):
        prompt = messages[0]["content"]
        keys = re.findall(r"- ID: ([\w-]+) \|", prompt)
        if keys:
            assert keys in GROUPS  # Requires actual embedding partition; all 24 fails.
            if action is not None:
                action()
            return json.dumps({"clusters": [{"ids": keys}]})
        indices = [i for i in (0, 1) if f"group-{i}" in prompt]
        assert len(indices) == 1
        i = indices[0]
        return json.dumps(
            {
                "key": f"parent-{i}",
                "value": f"summary-{i}",
                "tags": [f"group-{i}"],
                "summary": f"background-{i}",
            }
        )

    llm.generate.side_effect = generate
    embedder.embed.side_effect = lambda texts: [[0, 0, 1] for _ in texts]
    instance = GraphStructureReorganizer(db, llm, embedder, False)
    instance._is_optimizing = {"LongTermMemory": False, "UserMemory": False}
    return instance, llm, embedder


def test_real_partition_summary_and_parent_edges(stores, monkeypatch):
    db = stores(maxconn=4)
    seed(db)
    keys = [key for group in GROUPS for key in group]
    before = db.get_nodes(keys, include_embedding=True)
    foreign = db.get_node(keys[0], user_name="B")
    instance, llm, embedder = controlled_models(db)
    spy = MagicMock(wraps=db.get_structure_optimization_candidates)
    monkeypatch.setattr(db, "get_structure_optimization_candidates", spy)
    start = datetime.now()
    assert instance.optimize_structure(user_name="A") is None
    end = datetime.now()
    spy.assert_called_once_with("LongTermMemory", include_embedding=True, user_name="A")
    assert llm.generate.call_count == 4 and embedder.embed.call_count == 2
    assert db.get_memory_count("LongTermMemory") == 26
    assert db.get_nodes(keys, include_embedding=True) == before
    assert db.get_node(keys[0], user_name="B") == foreign
    parents = []
    for i, group in enumerate(GROUPS):
        edges = db.get_edges(group[0], "PARENT", "INCOMING")
        assert len(edges) == 1
        parent_id = edges[0]["from"]
        assert str(uuid.UUID(parent_id)) == parent_id and parent_id not in keys
        parents.append(parent_id)
        parent = db.get_node(parent_id, include_embedding=True)
        assert parent["memory"] == f"summary-{i}"
        metadata = parent["metadata"]
        for field in ("created_at", "updated_at"):
            assert start <= datetime.fromisoformat(metadata.pop(field)) <= end
        assert metadata == {
            "status": "activated",
            "memory_type": "LongTermMemory",
            "key": f"parent-{i}",
            "tags": [f"group-{i}"],
            "background": f"background-{i}",
            "embedding": [0, 0, 1],
            "usage": [],
            "confidence": 0.66,
            "type": "topic",
            "evolve_to": [],
            "version": 1,
            "history": [],
            "file_ids": [],
            "knowledge_material_ids": [],
            "knowledge_summary_ids": [],
            "sources": [
                {"type": "chat", "content": f"group-{i} child {key}", "node_id": key}
                for key in group
            ],
        }
        assert db.get_edges(parent_id) == [
            {"from": parent_id, "to": key, "type": "PARENT"} for key in group
        ]
    assert len(set(parents)) == 2
    assert db.get_structure_optimization_candidates("LongTermMemory") == []
    assert not instance._is_optimizing["LongTermMemory"]


@pytest.mark.parametrize("action", ["delete", "model-failure"])
def test_after_candidate_snapshot_failure_boundary(stores, action, caplog):
    db = stores(maxconn=4)
    seed(db)

    # Each model call happens after the candidate read, using an independent connection.
    def intervene():
        if action == "delete":
            db.delete_node(GROUPS[0][0])
        else:
            raise ValueError("synthetic model failure")

    instance, llm, embedder = controlled_models(db, intervene)
    assert instance.optimize_structure(user_name="A") is None
    assert not instance._is_optimizing["LongTermMemory"]
    if action == "model-failure":
        assert "Cluster processing failed" in caplog.text
        assert db.get_memory_count("LongTermMemory") == 24
        assert db.get_edges(GROUPS[0][0]) == []
        embedder.embed.assert_not_called()
    else:
        assert db.get_node(GROUPS[0][0]) is None
        assert db.get_memory_count("LongTermMemory") == 25
        # The already-read source stays in the summary; missing-endpoint add_edge is a no-op.
        parent = db.get_edges(GROUPS[0][1], "PARENT", "INCOMING")[0]["from"]
        assert len(db.get_edges(parent)) == 11
        assert [
            source["node_id"] for source in db.get_node(parent)["metadata"]["sources"]
        ] == GROUPS[0]
    assert db.get_node(GROUPS[0][0], user_name="B")["memory"] == "foreign"
