import uuid

from unittest.mock import MagicMock

import numpy as np
import pytest

from memos.memories.textual.item import (
    SearchedTreeNodeTextualMemoryMetadata,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
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


def test_searcher_can_skip_rerank_per_request(mock_searcher):
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Cats are cute"]
    parsed_goal.rephrased_query = None
    mock_searcher.task_goal_parser.parse.return_value = parsed_goal
    mock_searcher.embedder.embed.return_value = [[0.1] * 5, [0.2] * 5]
    mock_searcher.graph_retriever.retrieve.return_value = [make_item("wm1", 0.9)[0]]

    result = mock_searcher.search(
        query="Tell me about cats",
        top_k=1,
        info={"test": True},
        mode="fast",
        memory_type="WorkingMemory",
        rerank=False,
    )

    mock_searcher.reranker.rerank.assert_not_called()
    assert len(result) == 1
    assert result[0].memory == "wm1"


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


def test_deduplicate_rawfile_results_uses_knowledge_summary_ids(mock_searcher):
    summary_id = str(uuid.uuid4())
    material_id = str(uuid.uuid4())
    summary = TextualMemoryItem(
        id=summary_id,
        memory="summary",
        metadata=TreeNodeTextualMemoryMetadata(memory_type="LongTermMemory"),
    )
    raw_file = TextualMemoryItem(
        id=material_id,
        memory="material",
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="RawFileMemory",
            knowledge_summary_ids=[summary.id],
        ),
    )

    result = mock_searcher._deduplicate_rawfile_results([summary, raw_file], user_name="cube-1")

    assert result == [raw_file]
    mock_searcher.graph_store.get_edges.assert_not_called()


def make_searched_item(content: str, score: float, relativity: float = 0.5):
    """Build a Searched-type candidate as produced by vector/fulltext recall."""
    return (
        TextualMemoryItem(
            id=str(uuid.uuid4()),
            memory=content,
            metadata=SearchedTreeNodeTextualMemoryMetadata(
                memory_type="LongTermMemory",
                embedding=[0.1] * 5,
                usage=[],
                sources=[{"type": "chat", "role": "user", "content": "context"}],
                relativity=relativity,
            ),
        ),
        score,
    )


def rebuild_like_before(item: TextualMemoryItem, score: float) -> TextualMemoryItem:
    """Reference implementation of the pre-optimization dump-and-rebuild behavior."""
    meta_data = item.metadata.model_dump()
    meta_data["relativity"] = score
    return TextualMemoryItem(
        id=item.id,
        memory=item.memory,
        metadata=SearchedTreeNodeTextualMemoryMetadata(**meta_data),
    )


def test_sort_and_trim_hot_path_decoupled_copies(mock_searcher):
    """Searched-type items come back as decoupled copies matching the old rebuild."""
    inputs = [
        make_searched_item("m-high", 0.9),
        make_searched_item("m-mid", 0.8),
        make_searched_item("m-low", 0.7),
    ]
    input_items = {item.id: item for item, _ in inputs}

    result = mock_searcher._sort_and_trim(inputs, top_k=2)

    assert [item.memory for item in result] == ["m-high", "m-mid"]
    for item, score in zip(result, [0.9, 0.8], strict=True):
        # Selected items are decoupled copies, not the caller-owned objects.
        assert item is not input_items[item.id]
        assert item.metadata.relativity == score
        assert isinstance(item.metadata.relativity, float)
        # Output is exactly what the old dump-and-rebuild path produced.
        assert item.to_dict() == rebuild_like_before(input_items[item.id], score).to_dict()
    # Caller-owned items keep the relativity injected at recall time.
    assert input_items[result[0].id].metadata.relativity == 0.5
    assert input_items[result[1].id].metadata.relativity == 0.5


def test_sort_and_trim_cold_path_type_upgrade(mock_searcher):
    """Non-Searched metadata (e.g. graph/bm25 results) is still rebuilt."""
    original = make_item("graph-mem", 0.8)

    result = mock_searcher._sort_and_trim([original], top_k=2)

    assert len(result) == 1
    rebuilt = result[0]
    assert rebuilt is not original[0]  # cold path produces a new item
    assert isinstance(rebuilt.metadata, SearchedTreeNodeTextualMemoryMetadata)
    assert rebuilt.metadata.relativity == 0.8
    assert rebuilt.to_dict() == rebuild_like_before(original[0], 0.8).to_dict()


def test_sort_and_trim_mixed_types(mock_searcher):
    """Mixed Searched/TreeNode candidates all come back as Searched with final scores."""
    inputs = [
        make_searched_item("hot-1", 0.6),
        make_item("cold-1", 0.95),
        make_searched_item("hot-2", 0.7),
    ]

    result = mock_searcher._sort_and_trim(inputs, top_k=3)

    assert [item.memory for item in result] == ["cold-1", "hot-2", "hot-1"]
    assert all(isinstance(item.metadata, SearchedTreeNodeTextualMemoryMetadata) for item in result)
    assert [item.metadata.relativity for item in result] == [0.95, 0.7, 0.6]


def test_sort_and_trim_beyond_top_k_untouched(mock_searcher):
    """Candidates trimmed away keep the relativity injected at recall time."""
    inputs = [
        make_searched_item("keep", 0.9),
        make_searched_item("drop-1", 0.5),
        make_searched_item("drop-2", 0.4),
    ]

    result = mock_searcher._sort_and_trim(inputs, top_k=1)

    assert [item.memory for item in result] == ["keep"]
    for item, _ in inputs[1:]:
        assert item.metadata.relativity == 0.5


def test_sort_and_trim_plugin_filters_zero_scores(mock_searcher):
    """plugin=True drops candidates whose score rounds to 0.00 without writing."""
    inputs = [make_searched_item("near-zero", 0.001, relativity=0.42)]

    result = mock_searcher._sort_and_trim(inputs, top_k=5, plugin=True)

    assert result == []
    assert inputs[0][0].metadata.relativity == 0.42


def test_sort_and_trim_reuses_input_list_safely(mock_searcher):
    """Calling _sort_and_trim twice on the same candidates is idempotent."""
    inputs = [
        make_searched_item("m-1", 0.9),
        make_item("m-2", 0.8),
    ]

    first = mock_searcher._sort_and_trim(list(inputs), top_k=2)
    second = mock_searcher._sort_and_trim(list(inputs), top_k=2)

    assert [item.to_dict() for item in first] == [item.to_dict() for item in second]
    assert [item.metadata.relativity for item in first] == [0.9, 0.8]


def test_sort_and_trim_coerces_numpy_score(mock_searcher):
    """The in-place write applies the same float() coercion pydantic validation did."""
    item, _score = make_searched_item("np-mem", 0.0)

    result = mock_searcher._sort_and_trim([(item, np.float64(0.9))], top_k=1)

    assert isinstance(result[0].metadata.relativity, float)
    assert result[0].metadata.relativity == 0.9
