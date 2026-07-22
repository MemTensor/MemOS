import uuid

from unittest.mock import MagicMock

import pytest

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.recall import GraphMemoryRetriever
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal


@pytest.fixture
def mock_graph_store():
    return MagicMock()


@pytest.fixture
def mock_embedder():
    return MagicMock()


@pytest.fixture
def retriever(mock_graph_store, mock_embedder):
    return GraphMemoryRetriever(mock_graph_store, mock_embedder)


def test_retrieve_working_memory(retriever, mock_graph_store):
    mock_items = [
        {"id": str(uuid.uuid4()), "memory": "m1", "metadata": {"memory_type": "WorkingMemory"}},
        {"id": str(uuid.uuid4()), "memory": "m2", "metadata": {"memory_type": "WorkingMemory"}},
    ]
    mock_graph_store.get_all_memory_items.return_value = mock_items

    result = retriever.retrieve(
        query="",
        parsed_goal=ParsedTaskGoal(keys=[], tags=[]),
        top_k=5,
        memory_scope="WorkingMemory",
        query_embedding=None,
    )
    assert len(result) == 2
    assert isinstance(result[0], TextualMemoryItem)


def test_graph_recall_filters(retriever, mock_graph_store):
    parsed_goal = ParsedTaskGoal(keys=["goal_key"], tags=["tag1", "tag2", "tag3"])

    key_node_id = str(uuid.uuid4())
    tag_node_id = str(uuid.uuid4())

    mock_graph_store.get_by_metadata.side_effect = [[key_node_id], [tag_node_id]]

    mock_nodes = [
        {"id": key_node_id, "memory": "m1", "metadata": {"key": "goal_key"}},
        {"id": tag_node_id, "memory": "m2", "metadata": {"tags": ["tag1", "tag2"]}},
    ]
    mock_graph_store.get_nodes.return_value = mock_nodes

    results = retriever._graph_recall(parsed_goal, "LongTermMemory")
    assert len(results) == 2
    ids = [r.id for r in results]
    assert key_node_id in ids
    assert tag_node_id in ids


def test_vector_recall_combines_and_dedups(retriever, mock_graph_store):
    n1_id = str(uuid.uuid4())
    n2_id = str(uuid.uuid4())

    vec = [[0.1] * 5]
    mock_graph_store.search_by_embedding.return_value = [{"id": n1_id}, {"id": n2_id}]

    mock_graph_store.get_nodes.return_value = [
        {"id": n1_id, "memory": "m1", "metadata": {}},
        {"id": n2_id, "memory": "m2", "metadata": {}},
    ]

    results = retriever._vector_recall(vec, "LongTermMemory", top_k=5)
    assert len(results) == 2
    assert all(isinstance(r, TextualMemoryItem) for r in results)


def test_vector_recall_uses_lightweight_hits_without_get_nodes(
    retriever, mock_graph_store, monkeypatch
):
    monkeypatch.setenv("MEMOS_POLARDB_LIGHTWEIGHT_SEARCH_ENABLED", "true")
    mock_graph_store.supports_lightweight_vector_search = True
    node_id = str(uuid.uuid4())
    mock_graph_store.search_by_embedding.return_value = [
        {
            "id": node_id,
            "score": 0.91,
            "memory": "remembered content",
            "memory_type": "LongTermMemory",
            "user_name": "cube-a",
            "key": "topic",
            "tags": ["tag-a"],
        }
    ]

    results = retriever._vector_recall([[0.1] * 5], "LongTermMemory", top_k=5, user_name="cube-a")

    assert len(results) == 1
    assert results[0].id == node_id
    assert results[0].memory == "remembered content"
    assert results[0].metadata.memory_type == "LongTermMemory"
    assert results[0].metadata.user_name == "cube-a"
    assert results[0].metadata.relativity == pytest.approx(0.91)
    mock_graph_store.get_nodes.assert_not_called()
    search_kwargs = mock_graph_store.search_by_embedding.call_args.kwargs
    assert search_kwargs["light_weight_mode"] is True
    assert "memory" in search_kwargs["return_fields"]
    assert "memory_type" in search_kwargs["return_fields"]
    assert "user_name" in search_kwargs["return_fields"]
    assert "embedding" not in search_kwargs["return_fields"]


def test_vector_recall_falls_back_when_lightweight_hit_lacks_required_fields(
    retriever, mock_graph_store, monkeypatch
):
    monkeypatch.setenv("MEMOS_POLARDB_LIGHTWEIGHT_SEARCH_ENABLED", "true")
    mock_graph_store.supports_lightweight_vector_search = True
    node_id = str(uuid.uuid4())
    mock_graph_store.search_by_embedding.return_value = [{"id": node_id, "score": 0.8}]
    mock_graph_store.get_nodes.return_value = [
        {
            "id": node_id,
            "memory": "fallback content",
            "metadata": {"memory_type": "LongTermMemory"},
        }
    ]

    results = retriever._vector_recall([[0.1] * 5], "LongTermMemory", top_k=5)

    assert results[0].memory == "fallback content"
    mock_graph_store.get_nodes.assert_called_once()


def test_retrieve_merges_graph_and_vector(retriever, mock_graph_store):
    parsed_goal = ParsedTaskGoal(keys=["k"], tags=["t"])

    g1_id = str(uuid.uuid4())
    v1_id = str(uuid.uuid4())

    retriever._graph_recall = MagicMock(
        return_value=[
            TextualMemoryItem(id=g1_id, memory="m1", metadata=TreeNodeTextualMemoryMetadata())
        ]
    )
    retriever._vector_recall = MagicMock(
        return_value=[
            TextualMemoryItem(id=v1_id, memory="m2", metadata=TreeNodeTextualMemoryMetadata())
        ]
    )

    results = retriever.retrieve(
        query="q",
        parsed_goal=parsed_goal,
        top_k=5,
        memory_scope="LongTermMemory",
        query_embedding=[[0.1] * 5],
    )
    assert len(results) == 2
    ids = [r.id for r in results]
    assert g1_id in ids and v1_id in ids
