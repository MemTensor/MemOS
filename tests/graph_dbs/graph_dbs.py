import uuid

from datetime import datetime
from unittest.mock import patch

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.graph_dbs.neo4j import Neo4jGraphDB


@pytest.fixture
def config():
    return Neo4jGraphDBConfig(
        uri="bolt://localhost:7687",
        user="neo4j",
        password="test",
        db_name="test_memory_db",
        auto_create=False,
        embedding_dimension=3,
    )


@pytest.fixture
def mock_driver():
    with patch("memos.graph_dbs.neo4j.GraphDatabase.driver") as mock:
        yield mock


@pytest.fixture
def graph_db(config, mock_driver):
    return Neo4jGraphDB(config)


def test_add_node(graph_db):
    session_mock = graph_db.driver.session.return_value.__enter__.return_value
    node_id = str(uuid.uuid4())
    memory = "test content"
    metadata = {
        "memory_type": "WorkingMemory",
        "embedding": [0.1, 0.2, 0.3],
        "tags": ["test"],
    }

    graph_db.add_node(node_id, memory, metadata)

    # Confirm at least one MERGE node call
    calls = session_mock.run.call_args_list
    assert any("MERGE (n:Memory" in call.args[0] for call in calls), "Expected MERGE to be called"


def test_get_node(graph_db):
    session_mock = graph_db.driver.session.return_value.__enter__.return_value
    node_id = str(uuid.uuid4())

    session_mock.run.return_value.single.return_value = {
        "n": {
            "id": node_id,
            "memory": "hello",
            "memory_type": "WorkingMemory",
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
    }

    result = graph_db.get_node(node_id)
    assert result["id"] == node_id
    assert result["memory"] == "hello"
    assert result["metadata"]["memory_type"] == "WorkingMemory"


def test_update_node(graph_db):
    session_mock = graph_db.driver.session.return_value.__enter__.return_value
    node_id = str(uuid.uuid4())

    graph_db.update_node(
        node_id, {"tags": ["updated"], "updated_at": datetime.utcnow().isoformat()}
    )

    calls = session_mock.run.call_args_list
    assert any("SET n.updated_at = datetime($updated_at)" in call.args[0] for call in calls), (
        "Expected UPDATE to be called"
    )


def test_delete_node(graph_db):
    session_mock = graph_db.driver.session.return_value.__enter__.return_value
    node_id = "123"
    graph_db.delete_node(node_id)

    calls = session_mock.run.call_args_list
    assert any("DETACH DELETE" in call.args[0] for call in calls), "Expected DELETE to be called"


def test_remove_oldest_memory(graph_db):
    session_mock = graph_db.driver.session.return_value.__enter__.return_value
    graph_db.remove_oldest_memory(memory_type="WorkingMemory", keep_latest=10)
    query = session_mock.run.call_args[0][0]
    assert "SKIP 10" in query
    assert "ORDER BY n.updated_at DESC" in query


def test_get_memory_count(graph_db):
    session_mock = graph_db.driver.session.return_value.__enter__.return_value
    session_mock.run.return_value.single.return_value = {"count": 42}
    count = graph_db.get_memory_count("WorkingMemory")
    assert count == 42
