from unittest.mock import MagicMock

import pytest

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.base import BaseReranker


@pytest.fixture
def mock_searcher():
    dispatcher_llm = MagicMock()
    graph_store = MagicMock()
    embedder = MagicMock()

    reranker = MagicMock(spec=BaseReranker)
    s = Searcher(dispatcher_llm, graph_store, embedder, reranker)

    # Mock internals
    s.task_goal_parser = MagicMock()
    s.graph_retriever = MagicMock()
    s.reasoner = MagicMock()

    return s


def make_item(content: str, score: float, memory_type: str = "WorkingMemory"):
    # Simulate a TextualMemoryItem with usage list for update test
    return (
        TextualMemoryItem(
            memory=content,
            metadata=TreeNodeTextualMemoryMetadata(
                embedding=[0.1] * 5,
                memory_type=memory_type,
                usage=[],
            ),
        ),
        score,
    )


def test_searcher_fast_path(mock_searcher):
    query = "Tell me about cats"
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Cats are cute"]

    mock_searcher.task_goal_parser.parse.return_value = parsed_goal

    mock_searcher.embedder.embed.return_value = [[0.1] * 5, [0.2] * 5]

    # working path mock
    # For "All", _retrieve_from_working_memory calls once (WorkingMemory),
    # and _retrieve_from_long_term_and_user calls 3 times (LongTermMemory, UserMemory, RawFileMemory)
    # Use a function to handle concurrent calls with different memory_scope
    def retrieve_side_effect(*args, **kwargs):
        memory_scope = kwargs.get("memory_scope", "")
        if memory_scope == "WorkingMemory":
            return [make_item("wm1", 0.9)[0]]
        elif memory_scope == "LongTermMemory":
            return [make_item("lt1", 0.8)[0]]
        elif memory_scope == "UserMemory":
            return [make_item("um1", 0.7)[0]]
        elif memory_scope == "RawFileMemory":
            return [make_item("rm1", 0.6)[0]]
        else:
            return []

    mock_searcher.graph_retriever.retrieve.side_effect = retrieve_side_effect
    mock_searcher.reranker.rerank.return_value = [
        make_item("wm1", 0.9),
        make_item("lt1", 0.8),
        make_item("um1", 0.7),
    ]

    result = mock_searcher.search(
        query=query, top_k=2, info={"test": True}, mode="fast", memory_type="All"
    )

    assert mock_searcher.task_goal_parser.parse.called
    mock_searcher.embedder.embed.assert_called_once()

    assert len(result) <= 2
    assert all(isinstance(item, TextualMemoryItem) for item in result)


def test_searcher_fine_mode_triggers_reasoner(mock_searcher):
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Cats"]

    mock_searcher.task_goal_parser.parse.return_value = parsed_goal
    mock_searcher.embedder.embed.return_value = [[0.1] * 5]

    # working + long-term/user
    mock_searcher.graph_retriever.retrieve.return_value = [make_item("mem", 0.5)[0]]
    mock_searcher.reranker.rerank.return_value = [make_item("mem", 0.5)]

    # Simulate reasoner output
    mock_searcher.reasoner.reason.return_value = [make_item("mem", 0.5)[0]]

    result = mock_searcher.search(
        query="Tell me about dogs",
        top_k=1,
        mode="fine",
    )
    assert len(result) == 1


def test_fine_search_embeds_query_when_parser_returns_no_memory_expansions(mock_searcher):
    query = "我喜欢什么"
    user_memory = make_item("我喜欢草莓", 0.9, memory_type="UserMemory")[0]

    mock_searcher.task_goal_parser.parse.return_value = ParsedTaskGoal(
        keys=["喜欢", "偏好", "兴趣"],
        tags=["personal preference", "user interest", "taste"],
        memories=[],
        rephrased_query="",
    )
    mock_searcher.embedder.embed.return_value = [[0.1] * 5]

    def retrieve_side_effect(*args, **kwargs):
        if kwargs.get("memory_scope") == "UserMemory":
            assert kwargs["query_embedding"] == [[0.1] * 5]
            return [user_memory]
        return []

    mock_searcher.graph_retriever.retrieve.side_effect = retrieve_side_effect
    mock_searcher.reranker.rerank.return_value = [(user_memory, 0.9)]

    result = mock_searcher.search(query=query, top_k=1, mode="fine", memory_type="UserMemory")

    mock_searcher.embedder.embed.assert_called_once_with([query])
    assert len(result) == 1
    assert result[0].memory == "我喜欢草莓"


def test_fine_search_runs_vector_recall_when_metadata_recall_misses():
    query = "What do I like"
    dispatcher_llm = MagicMock()
    graph_store = MagicMock()
    embedder = MagicMock()
    reranker = MagicMock(spec=BaseReranker)
    searcher = Searcher(dispatcher_llm, graph_store, embedder, reranker)

    searcher.task_goal_parser = MagicMock()
    searcher.task_goal_parser.parse.return_value = ParsedTaskGoal(
        keys=["likes", "preferences", "interests"],
        tags=["personal preferences", "user profile", "taste"],
        memories=[],
        rephrased_query="",
    )
    embedder.embed.return_value = [[0.1] * 5]

    memory_id = "abfd6604-3f73-4c0c-bdfa-d100834f0596"
    graph_store.get_by_metadata.side_effect = [[], []]
    graph_store.search_by_embedding.return_value = [{"id": memory_id, "score": 0.82}]
    graph_store.get_nodes.return_value = [
        {
            "id": memory_id,
            "memory": "On April 14, 2026 at 1:48 PM, the user expressed that they like strawberries.",
            "metadata": {
                "memory_type": "UserMemory",
                "embedding": [0.2] * 5,
                "key": "Preference for strawberries",
                "tags": ["food preference", "fruit", "personal taste"],
            },
        }
    ]

    def rerank_side_effect(*, graph_results, **kwargs):
        return [(item, item.metadata.relativity or 0.82) for item in graph_results]

    reranker.rerank.side_effect = rerank_side_effect

    result = searcher.search(
        query=query,
        top_k=1,
        mode="fine",
        memory_type="UserMemory",
        user_name="b32d0977-435d-4828-a86f-4f47f8b55bca",
    )

    embedder.embed.assert_called_once_with([query])
    graph_store.search_by_embedding.assert_called_once()
    assert graph_store.search_by_embedding.call_args.kwargs["scope"] == "UserMemory"
    assert graph_store.search_by_embedding.call_args.kwargs["user_name"] == (
        "b32d0977-435d-4828-a86f-4f47f8b55bca"
    )
    assert len(result) == 1
    assert "strawberries" in result[0].memory


def test_searcher_respects_memory_type(mock_searcher):
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Something"]
    mock_searcher.task_goal_parser.parse.return_value = parsed_goal
    mock_searcher.embedder.embed.return_value = [[0.1] * 5]

    mock_searcher.graph_retriever.retrieve.return_value = []
    mock_searcher.reranker.rerank.return_value = []

    mock_searcher.search(
        query="x",
        top_k=1,
        mode="fast",
        memory_type="WorkingMemory",
    )
    # WorkingMemory triggers only once path A
    assert mock_searcher.graph_retriever.retrieve.call_args[1]["memory_scope"] == "WorkingMemory"
