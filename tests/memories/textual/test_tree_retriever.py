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


def test_graph_recall_fast_mode_substring_fallback(retriever, mock_graph_store):
    """Regression test for issue #1448.

    Memories stored via the fast-mode add pipeline carry the raw chat-formatted
    text as ``key`` and only ``"mode:fast"`` as a tag. When the search query is
    parsed in fine mode by an LLM, ``parsed_goal.keys`` and ``parsed_goal.tags``
    become high-level semantic tokens that never exactly match those stored
    values, so the strict ``key IN ...`` / tag-overlap branches in
    ``get_by_metadata`` return zero candidates and the graph-recall path used to
    drop the memory entirely. The recall layer must therefore fall back to a
    substring-based scan over memories of the requested scope.
    """

    parsed_goal = ParsedTaskGoal(
        keys=["喜欢", "偏好", "兴趣"],
        tags=["personal preference", "user interest", "taste"],
    )

    # Strict candidate retrieval yields nothing (matches the user's Neo4j trace).
    mock_graph_store.get_by_metadata.return_value = []

    matching_id = str(uuid.uuid4())
    other_id = str(uuid.uuid4())
    fallback_items = [
        {
            "id": matching_id,
            "memory": "user: [04:14 PM on 09 April, 2026]: 我喜欢草莓\n",
            "metadata": {
                "key": "user: [04:14 PM on 09 April, 2026]: 我喜欢草莓",
                "tags": ["mode:fast"],
                "memory_type": "UserMemory",
                "status": "activated",
            },
        },
        {
            "id": other_id,
            "memory": "user: 今天天气很好",
            "metadata": {
                "key": "user: 今天天气很好",
                "tags": ["mode:fast"],
                "memory_type": "UserMemory",
                "status": "activated",
            },
        },
    ]
    mock_graph_store.get_all_memory_items.return_value = fallback_items

    results = retriever._graph_recall(
        parsed_goal,
        "UserMemory",
        user_name="b32d0977-cube",
    )

    # The matching fast-mode memory must come back; the unrelated one must not.
    ids = [r.id for r in results]
    assert matching_id in ids, "fast-mode memory containing parsed key should be returned"
    assert other_id not in ids
    mock_graph_store.get_all_memory_items.assert_called_once()


def test_graph_recall_post_filter_keeps_substring_key_match(retriever, mock_graph_store):
    """Post-filter must accept nodes whose ``key`` contains a parsed keyword as
    a substring, not only exact equality."""

    parsed_goal = ParsedTaskGoal(keys=["喜欢"], tags=[])

    node_id = str(uuid.uuid4())
    mock_graph_store.get_by_metadata.return_value = [node_id]
    mock_graph_store.get_nodes.return_value = [
        {
            "id": node_id,
            "memory": "我喜欢草莓",
            "metadata": {
                "key": "user: [04:14 PM]: 我喜欢草莓",
                "tags": ["mode:fast"],
                "memory_type": "UserMemory",
            },
        }
    ]

    results = retriever._graph_recall(parsed_goal, "UserMemory")
    assert [r.id for r in results] == [node_id]


def test_graph_recall_post_filter_single_tag_overlap(retriever, mock_graph_store):
    """Post-filter must accept a single tag overlap when the parsed goal has
    only a small number of tags (previously required >= 2 which excluded most
    fast-mode memories)."""

    parsed_goal = ParsedTaskGoal(keys=[], tags=["personal preference", "user interest"])

    node_id = str(uuid.uuid4())
    mock_graph_store.get_by_metadata.return_value = [node_id]
    mock_graph_store.get_nodes.return_value = [
        {
            "id": node_id,
            "memory": "I like strawberries",
            "metadata": {
                "key": "preference fruit",
                "tags": ["personal preference"],
                "memory_type": "UserMemory",
            },
        }
    ]

    results = retriever._graph_recall(parsed_goal, "UserMemory")
    assert [r.id for r in results] == [node_id]


def test_graph_recall_no_match_returns_empty(retriever, mock_graph_store):
    """Sanity check: when the fallback also fails to substring-match anything,
    graph-recall still returns an empty list and never raises."""

    parsed_goal = ParsedTaskGoal(keys=["完全无关"], tags=["unrelated"])

    mock_graph_store.get_by_metadata.return_value = []
    mock_graph_store.get_all_memory_items.return_value = [
        {
            "id": str(uuid.uuid4()),
            "memory": "I prefer sushi",
            "metadata": {
                "key": "user: I prefer sushi",
                "tags": ["mode:fast"],
                "memory_type": "UserMemory",
            },
        }
    ]
    results = retriever._graph_recall(parsed_goal, "UserMemory")
    assert results == []
