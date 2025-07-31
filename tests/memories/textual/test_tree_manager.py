import uuid

from unittest.mock import MagicMock

import pytest

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager


@pytest.fixture
def mock_graph_store():
    store = MagicMock()
    store.get_node.return_value = {
        "id": str(uuid.uuid4()),
        "memory": "old text",
        "metadata": {
            "confidence": 90,
            "background": "",
            "tags": [],
            "sources": [],
            "usage": [],
        },
    }
    store.search_by_embedding.return_value = [{"id": str(uuid.uuid4()), "score": 0.95}]
    store.get_edges.return_value = [{"from": "from_id", "to": "to_id", "type": "RELATE"}]
    store.edge_exists.return_value = False
    return store


@pytest.fixture
def mock_embedder():
    embedder = MagicMock()
    embedder.embed.side_effect = lambda texts: [[0.1] * 5 for _ in texts]
    return embedder


@pytest.fixture
def mock_llm():
    llm = MagicMock()
    llm.run.side_effect = lambda *args, **kwargs: "mock_output"
    return llm


@pytest.fixture
def memory_manager(mock_graph_store, mock_embedder, mock_llm):
    return MemoryManager(
        graph_store=mock_graph_store,
        embedder=mock_embedder,
        llm=mock_llm,
    )


def test_add_and_replace_working_memory(memory_manager):
    memory = TextualMemoryItem(
        memory="test",
        metadata=TreeNodeTextualMemoryMetadata(embedding=[0.1] * 5, memory_type="WorkingMemory"),
    )
    memory_manager.add([memory])
    memory_manager.replace_working_memory([memory])
    assert memory_manager.graph_store.add_node.called


def test_process_memory_adds_nodes(memory_manager):
    memory = TextualMemoryItem(
        memory="test",
        metadata=TreeNodeTextualMemoryMetadata(
            embedding=[0.1] * 5,
            memory_type="UserMemory",
            tags=["test"],
            key="topic",
            confidence=80.0,
        ),
    )
    memory_manager._process_memory(memory)  # Only pass the single memory item
    assert memory_manager.graph_store.add_node.called


def test_add_to_graph_memory_merges(memory_manager, mock_graph_store):
    memory = TextualMemoryItem(
        memory="to merge",
        metadata=TreeNodeTextualMemoryMetadata(
            embedding=[0.1] * 5, memory_type="UserMemory", confidence=80.0
        ),
    )
    memory_manager._add_to_graph_memory(memory, "UserMemory")
    assert mock_graph_store.add_node.called


def test_add_to_graph_memory_creates_new_node(memory_manager, mock_graph_store):
    mock_graph_store.search_by_embedding.return_value = [{"id": "id1", "score": 0.5}]
    memory = TextualMemoryItem(
        memory="new memory",
        metadata=TreeNodeTextualMemoryMetadata(
            embedding=[0.1] * 5,
            memory_type="LongTermMemory",
            tags=["test"],
            key="topic",
        ),
    )
    memory_manager._add_to_graph_memory(memory, "LongTermMemory")
    assert mock_graph_store.add_node.called


def test_inherit_edges(memory_manager, mock_graph_store):
    from_id = "from_id"
    to_id = "to_id"
    mock_graph_store.get_edges.return_value = [
        {"from": from_id, "to": "node_b", "type": "RELATE"},
        {"from": "node_c", "to": from_id, "type": "RELATE"},
    ]
    memory_manager._inherit_edges(from_id, to_id)
    assert mock_graph_store.add_edge.call_count > 0


def test_ensure_structure_path_creates_new(memory_manager, mock_graph_store):
    mock_graph_store.get_by_metadata.return_value = []
    meta = TreeNodeTextualMemoryMetadata(
        key="hobby",
        embedding=[0.1] * 5,
        user_id="user123",
        session_id="sess",
    )
    node_id = memory_manager._ensure_structure_path("UserMemory", meta)
    assert isinstance(node_id, str)
    assert mock_graph_store.add_node.called


def test_ensure_structure_path_reuses_existing(memory_manager, mock_graph_store):
    mock_graph_store.get_by_metadata.return_value = ["existing_node_id"]
    meta = TreeNodeTextualMemoryMetadata(key="hobby")
    node_id = memory_manager._ensure_structure_path("UserMemory", meta)
    assert node_id == "existing_node_id"


def test_add_returns_written_node_ids(memory_manager):
    memory = TextualMemoryItem(
        memory="test memory",
        metadata=TreeNodeTextualMemoryMetadata(embedding=[0.1] * 5, memory_type="UserMemory"),
    )
    ids = memory_manager.add([memory])
    assert isinstance(ids, list)
    assert all(isinstance(i, str) for i in ids)
    assert len(ids) > 0
