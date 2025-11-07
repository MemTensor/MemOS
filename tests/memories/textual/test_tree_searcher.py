from unittest.mock import MagicMock

import pytest

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
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


def make_item(content: str, score: float):
    # Simulate a TextualMemoryItem with usage list for update test
    return (
        TextualMemoryItem(
            memory=content,
            metadata=TreeNodeTextualMemoryMetadata(
                embedding=[0.1] * 5,
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
    mock_searcher.graph_retriever.retrieve.side_effect = [
        [make_item("wm1", 0.9)[0]],  # working memory
        [make_item("lt1", 0.8)[0]],  # long-term
        [make_item("um1", 0.7)[0]],  # user
    ]
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
