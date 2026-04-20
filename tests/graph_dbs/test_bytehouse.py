import pytest

import os
import uuid
import random

from datetime import datetime
from dotenv import load_dotenv

from memos.configs.graph_db import ByteHouseGraphDBConfig
from memos.graph_dbs.bytehouse import ByteHouseGraphDB, _prepare_node_metadata


# ──────────────────────────────────────────────────────────────────────────────
# Help functions
# ──────────────────────────────────────────────────────────────────────────────


def generate_random_vector(dimension: int) -> list[float]:
    """Generate a random vector of the given dimension."""
    return [random.uniform(0, 1) for _ in range(dimension)]


# ──────────────────────────────────────────────────────────────────────────────
# Setup and configuration
# ──────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def config():
    return ByteHouseGraphDBConfig(
        host=os.getenv("BYTEHOUSE_HOST"),
        port=int(os.getenv("BYTEHOUSE_PORT", "8123")),
        user=os.getenv("BYTEHOUSE_USER"),
        password=os.getenv("BYTEHOUSE_PASSWORD"),
        db_name=os.getenv("BYTEHOUSE_DB_NAME", "shared_memos_db"),
        use_multi_db=os.getenv("BYTEHOUSE_USE_MULTI_DB", "false").lower() == "true",
        user_name=f"__test_{uuid.uuid4().hex[:8]}",
        embedding_dimension=2048,
    )


@pytest.fixture
def graph_db(config):
    return ByteHouseGraphDB(config)


# -----------------------------
# Test Node
# -----------------------------


def test_add_and_get_node(graph_db):
    node_id = str(uuid.uuid4())
    memory = "test content add and get"
    metadata = {
        "memory_type": "WorkingMemory",
        "embedding": generate_random_vector(2048),
        "tags": ["test"],
    }

    graph_db.add_node(node_id, memory, metadata, user_name="test_add")

    result = graph_db.get_node(node_id, include_embedding=True, user_name="test_add")

    assert result is not None
    assert result["id"] == node_id
    assert result["memory"] == memory
    assert result["metadata"]["memory_type"] == "WorkingMemory"
    assert "embedding" in result["metadata"]
    assert len(result["metadata"]["embedding"]) == len(metadata["embedding"])

    graph_db.clear(user_name="test_add")


def test_update_node(graph_db):
    node_id = str(uuid.uuid4())
    memory = "test content update"
    metadata = {
        "memory_type": "WorkingMemory",
        "embedding": generate_random_vector(2048),
        "tags": ["test"],
    }

    graph_db.add_node(node_id, memory, metadata, user_name="test_update")
    graph_db.update_node(node_id, {"tags": ["updated"]}, user_name="test_update")

    result = graph_db.get_node(node_id, user_name="test_update")
    assert result["metadata"]["tags"] == ["updated"]

    graph_db.clear(user_name="test_update")


def test_delete_node(graph_db):
    node_id = str(uuid.uuid4())
    memory = "test content delete"
    metadata = {
        "memory_type": "WorkingMemory",
        "embedding": generate_random_vector(2048),
        "tags": ["test"],
    }

    graph_db.add_node(node_id, memory, metadata, user_name="test_delete")

    result = graph_db.get_node(node_id, user_name="test_delete")
    assert result is not None

    graph_db.delete_node(node_id, user_name="test_delete")

    result = graph_db.get_node(node_id, user_name="test_delete")
    assert result is None


# -----------------------------
# Test Edge
# -----------------------------
def test_add_and_get_edge(graph_db):
    source_id = str(uuid.uuid4())
    target_id = str(uuid.uuid4())
    edge_type = "RELATED"

    # Create source node
    graph_db.add_node(
        source_id,
        "Source node",
        {"memory_type": "WorkingMemory"},
        user_name="test_edge",
    )
    # Create target node
    graph_db.add_node(
        target_id,
        "Target node",
        {"memory_type": "WorkingMemory"},
        user_name="test_edge",
    )

    # Add edge between nodes
    graph_db.add_edge(source_id, target_id, edge_type, user_name="test_edge")

    # Verify edge exists
    assert graph_db.edge_exists(source_id, target_id, edge_type, user_name="test_edge")
    assert graph_db.edge_exists(source_id, target_id, "ANY", user_name="test_edge")

    # Clean up
    graph_db.clear(user_name="test_edge")


def test_delete_edge(graph_db):
    source_id = str(uuid.uuid4())
    target_id = str(uuid.uuid4())
    edge_type = "RELATED"

    # Create source node
    graph_db.add_node(
        source_id,
        "Source node",
        {"memory_type": "WorkingMemory"},
        user_name="test_delete_edge",
    )
    # Create target node
    graph_db.add_node(
        target_id,
        "Target node",
        {"memory_type": "WorkingMemory"},
        user_name="test_delete_edge",
    )

    # Add edge
    graph_db.add_edge(source_id, target_id, edge_type, user_name="test_delete_edge")
    assert graph_db.edge_exists(
        source_id, target_id, edge_type, user_name="test_delete_edge"
    )

    # Delete edge
    graph_db.delete_edge(source_id, target_id, edge_type, user_name="test_delete_edge")

    # Verify edge doesn't exist
    assert not graph_db.edge_exists(
        source_id, target_id, edge_type, user_name="test_delete_edge"
    )

    # Clean up
    graph_db.clear(user_name="test_delete_edge")


def test_get_neighbors(graph_db):
    node1 = str(uuid.uuid4())
    node2 = str(uuid.uuid4())
    node3 = str(uuid.uuid4())
    edge_type = "RELATED"

    # Create nodes
    graph_db.add_node(
        node1, "Node 1", {"memory_type": "WorkingMemory"}, user_name="test_neighbors"
    )
    graph_db.add_node(
        node2, "Node 2", {"memory_type": "WorkingMemory"}, user_name="test_neighbors"
    )
    graph_db.add_node(
        node3, "Node 3", {"memory_type": "WorkingMemory"}, user_name="test_neighbors"
    )

    # Add edges: node1 -> node2, node3 -> node1
    graph_db.add_edge(node1, node2, edge_type, user_name="test_neighbors")
    graph_db.add_edge(node3, node1, edge_type, user_name="test_neighbors")

    # Test direction 'out' - should return node2
    out_neighbors = graph_db.get_neighbors(
        node1, edge_type, direction="out", user_name="test_neighbors"
    )
    assert len(out_neighbors) == 1
    assert node2 in out_neighbors

    # Test direction 'in' - should return node3
    in_neighbors = graph_db.get_neighbors(
        node1, edge_type, direction="in", user_name="test_neighbors"
    )
    assert len(in_neighbors) == 1
    assert node3 in in_neighbors

    # Test direction 'both' - should return both node2 and node3
    both_neighbors = graph_db.get_neighbors(
        node1, edge_type, direction="both", user_name="test_neighbors"
    )
    assert len(both_neighbors) == 2
    assert node2 in both_neighbors
    assert node3 in both_neighbors

    # Clean up
    graph_db.clear(user_name="test_neighbors")


# -----------------------------
# Test Search
# -----------------------------
def test_search_by_embedding(graph_db):
    node_id = str(uuid.uuid4())
    memory = "test content search by embedding"
    metadata = {
        "memory_type": "WorkingMemory",
        "embedding": generate_random_vector(2048),
        "tags": ["test"],
    }

    graph_db.add_node(node_id, memory, metadata, user_name="test_search")

    result = graph_db.search_by_embedding(
        generate_random_vector(2048), top_k=1, user_name="test_search"
    )
    assert result is not None
    assert len(result) == 1
    assert result[0]["id"] == node_id
    assert result[0]["score"] > 0

    graph_db.clear(user_name="test_search")


# -----------------------------# Test Memory Management#-----------------------------
def test_remove_oldest_memory(graph_db):
    # Create multiple memories of the same type
    memory_type = "WorkingMemory"
    user_name = "test_remove_oldest"

    # Create 5 test memories
    for i in range(5):
        node_id = str(uuid.uuid4())
        memory = f"Test memory {i}"
        metadata = {
            "memory_type": memory_type,
            "embedding": generate_random_vector(2048),
            "tags": ["test"],
        }
        graph_db.add_node(node_id, memory, metadata, user_name=user_name)

    # Keep only the latest 2 memories
    graph_db.remove_oldest_memory(memory_type, keep_latest=2, user_name=user_name)

    # Get all remaining memories
    all_memories = graph_db.get_all_memory_items(memory_type, user_name=user_name)

    # Verify only 2 memories remain
    assert len(all_memories) == 2

    # Clean up
    graph_db.clear(user_name=user_name)


def test_get_grouped_counts(graph_db):
    user_name = "test_grouped_counts"

    # Create memories with different types and statuses
    memory_types = [
        "WorkingMemory",
        "LongTermMemory",
        "WorkingMemory",
        "LongTermMemory",
    ]
    statuses = ["active", "inactive", "inactive", "active"]

    for i, (memory_type, status) in enumerate(zip(memory_types, statuses)):
        node_id = str(uuid.uuid4())
        memory = f"Test memory {i}"
        metadata = {
            "memory_type": memory_type,
            "status": status,
            "embedding": generate_random_vector(2048),
        }
        graph_db.add_node(node_id, memory, metadata, user_name=user_name)

    # Test grouping by memory_type
    counts_by_type = graph_db.get_grouped_counts(["memory_type"], user_name=user_name)
    assert len(counts_by_type) == 2

    # Test grouping by both memory_type and status
    counts_by_type_and_status = graph_db.get_grouped_counts(
        ["memory_type", "status"], user_name=user_name
    )
    assert len(counts_by_type_and_status) == 4

    # Clean up
    graph_db.clear(user_name=user_name)
