"""Tests for deferred candidate construction in the recall pipeline.

Covers the ``DeferredTextualMemoryItem`` view: attribute passthrough,
``build()`` equivalence against eager construction, and pipeline-level
equivalence for rerank / dedup / sort-and-trim when candidates are deferred.
"""

import copy
import uuid

import pytest

from unittest.mock import patch

from memos.memories.textual.item import (
    DeferredTextualMemoryItem,
    SearchedTreeNodeTextualMemoryMetadata,
    TextualMemoryItem,
)
from memos.memories.textual.tree_text_memory.retrieve.searcher import (
    Searcher,
    _materialize_candidate,
)
from memos.reranker.cosine_local import CosineLocalReranker


def make_node(i, with_embedding=True, with_relativity=True, memory_type="LongTermMemory"):
    md = {
        "memory_type": memory_type,
        "background": "fact",
        "timestamp": 1735689600.0,
        "created_at": "2026-01-15T10:30:00",
        "updated_at": "2026-01-15T10:30:00",
        "confidence": 0.9,
        "usage": ["u1"],
        "sources": [
            {
                "conversation_id": str(uuid.uuid4()),
                "content": f"source content {i}",
                "timestamp": "2026-01-15T10:30:00",
                "role": "user",
            }
        ],
    }
    if with_embedding:
        md["embedding"] = [float(i), 1.0, 2.0, 3.0]
    if with_relativity:
        md["relativity"] = 0.5
    return {
        "id": str(uuid.uuid4()),
        "memory": f"memory content {i}",
        "metadata": md,
    }


def test_view_attribute_passthrough():
    node = make_node(1)
    view = DeferredTextualMemoryItem(node)
    assert view.id == node["id"]
    assert view.memory == node["memory"]
    assert view.metadata.embedding == node["metadata"]["embedding"]
    assert view.metadata.background == "fact"
    assert view.metadata.memory_type == "LongTermMemory"
    with pytest.raises(AttributeError):
        view.metadata.nonexistent


def test_view_unknown_field_hasattr_getattr_semantics():
    view = DeferredTextualMemoryItem(make_node(1))
    assert not hasattr(view.metadata, "no_such_field")
    assert getattr(view.metadata, "no_such_field", "fallback") == "fallback"


def test_view_known_field_defaults_match_built_item():
    node = make_node(3)
    node["metadata"] = {
        k: v for k, v in node["metadata"].items()
        if k not in ("memory_type", "usage", "file_ids", "knowledge_summary_ids")
    }
    view = DeferredTextualMemoryItem(node)
    built = TextualMemoryItem.from_dict(node)
    assert view.metadata.memory_type == built.metadata.memory_type == "WorkingMemory"
    assert view.metadata.usage == built.metadata.usage == []
    assert view.metadata.file_ids == built.metadata.file_ids == []
    assert view.metadata.knowledge_summary_ids == built.metadata.knowledge_summary_ids == []


def test_view_defaults_are_not_shared_mutable_state():
    view = DeferredTextualMemoryItem({"id": "x", "memory": "m", "metadata": {}})
    view.metadata.usage.append("corrupted")
    fresh = DeferredTextualMemoryItem({"id": "y", "memory": "m", "metadata": {}})
    assert fresh.metadata.usage == []


def test_view_missing_metadata():
    view = DeferredTextualMemoryItem({"id": "x", "memory": "m"})
    assert view.id == "x"
    assert view.memory == "m"
    # Missing keys fall back to the pydantic field defaults, matching what a
    # built item would expose for the same node dict.
    assert view.metadata.memory_type == "WorkingMemory"
    with pytest.raises(AttributeError):
        view.metadata.no_such_field


def test_view_id_matches_real_item_id():
    node = make_node(2)
    assert DeferredTextualMemoryItem(node).id == TextualMemoryItem.from_dict(node).id


def test_build_equivalence():
    nodes = [make_node(i) for i in range(5)]
    nodes.append(make_node(9, with_embedding=False, with_relativity=False))
    nodes.append(make_node(11, memory_type="UserMemory"))
    for node in nodes:
        assert (
            DeferredTextualMemoryItem(node).build().to_dict()
            == TextualMemoryItem.from_dict(node).to_dict()
        )


def test_materialize_helper():
    node = make_node(3)
    view = DeferredTextualMemoryItem(node)
    item = TextualMemoryItem.from_dict(node)
    assert _materialize_candidate(view).to_dict() == item.to_dict()
    assert _materialize_candidate(item) is item


def test_rerank_equivalence_views_vs_items():
    nodes = [make_node(i, with_embedding=(i % 3 != 0)) for i in range(8)]
    items = [TextualMemoryItem.from_dict(n) for n in nodes]
    views = [DeferredTextualMemoryItem(n) for n in nodes]
    query_embedding = [0.5, 1.0, 2.0, 3.0]
    reranker = CosineLocalReranker()

    out_items = reranker.rerank(
        query="q", graph_results=items, top_k=5, query_embedding=query_embedding
    )
    out_views = reranker.rerank(
        query="q", graph_results=views, top_k=5, query_embedding=query_embedding
    )

    assert len(out_items) == len(out_views)
    for (item_a, score_a), (item_b, score_b) in zip(out_items, out_views, strict=True):
        assert score_a == score_b
        assert item_a.memory == item_b.memory


def test_maybe_rerank_materializes_before_rerank():
    """Reranker strategies mutate items (e.g. single_turn reassigns memory)."""

    class MutatingReranker:
        def rerank(self, query, graph_results, top_k, **kwargs):
            out = []
            for i, item in enumerate(graph_results[:top_k]):
                item.memory = f"{item.memory} enriched"  # would fail on a view
                out.append((item, 1.0 - i * 0.1))
            return out

    searcher = Searcher.__new__(Searcher)
    searcher.reranker = MutatingReranker()
    result = searcher._maybe_rerank(
        True, query="q", graph_results=[DeferredTextualMemoryItem(make_node(4))], top_k=5
    )
    assert len(result) == 1
    assert isinstance(result[0][0], TextualMemoryItem)
    assert result[0][0].memory == "memory content 4 enriched"


def test_maybe_rerank_disabled_path_materializes():
    """Searcher.retrieve() must never hand deferred views to its callers."""
    searcher = Searcher.__new__(Searcher)
    searcher.reranker = None
    result = searcher._maybe_rerank(
        False, query="q", graph_results=[DeferredTextualMemoryItem(make_node(6))], top_k=5
    )
    assert len(result) == 1
    assert isinstance(result[0][0], TextualMemoryItem)
    assert result[0][1] == 0.0


def test_sort_and_trim_defaults_missing_memory_type():
    """A node without memory_type is WorkingMemory by default and must
    survive the textual branch filter instead of being silently dropped."""
    node = make_node(7)
    node["metadata"] = {k: v for k, v in node["metadata"].items() if k != "memory_type"}
    searcher = Searcher.__new__(Searcher)
    out = searcher._sort_and_trim([(DeferredTextualMemoryItem(node), 0.8)], 4)
    assert len(out) == 1
    assert out[0].metadata.memory_type == "WorkingMemory"


def test_deduplicate_results_mixed():
    searcher = Searcher.__new__(Searcher)
    nodes = [make_node(i) for i in range(4)]
    items = [TextualMemoryItem.from_dict(n) for n in nodes]
    results = [
        (DeferredTextualMemoryItem(nodes[0]), 0.1),
        (items[0], 0.9),
        (items[1], 0.5),
        (DeferredTextualMemoryItem(nodes[1]), 0.4),
    ]
    deduped = searcher._deduplicate_results(results)
    assert len(deduped) == 2
    assert deduped[0][1] == 0.9
    assert deduped[0][0].memory == items[0].memory


def test_sort_and_trim_equivalence():
    nodes = [make_node(i) for i in range(10)]
    items = [TextualMemoryItem.from_dict(n) for n in nodes]
    scores = [0.9 - i * 0.05 for i in range(10)]
    results_items = list(zip(items, scores, strict=True))
    results_mixed = [
        (DeferredTextualMemoryItem(nodes[i]) if i % 2 == 0 else items[i], scores[i])
        for i in range(10)
    ]

    searcher = Searcher.__new__(Searcher)
    out_items = searcher._sort_and_trim(results_items, 4)
    out_mixed = searcher._sort_and_trim(results_mixed, 4)

    assert [it.to_dict() for it in out_items] == [it.to_dict() for it in out_mixed]
    for it in out_mixed:
        assert isinstance(it, TextualMemoryItem)
        assert isinstance(it.metadata, SearchedTreeNodeTextualMemoryMetadata)


def test_sort_and_trim_tool_branch_materializes():
    node = make_node(21, memory_type="ToolSchemaMemory")
    view = DeferredTextualMemoryItem(node)
    searcher = Searcher.__new__(Searcher)
    out = searcher._sort_and_trim([(view, 0.7)], 6, search_tool_memory=True)
    assert len(out) == 1
    assert isinstance(out[0], TextualMemoryItem)
    assert out[0].metadata.memory_type == "ToolSchemaMemory"


def test_plugin_zero_score_skips_materialization():
    view = DeferredTextualMemoryItem(make_node(5))
    searcher = Searcher.__new__(Searcher)
    with patch.object(
        DeferredTextualMemoryItem, "build", side_effect=AssertionError("should not build")
    ) as mock_build:
        out = searcher._sort_and_trim([(view, 0.001)], 3, plugin=True)
    assert out == []
    assert mock_build.call_count == 0


def test_deepcopy_safety():
    view = DeferredTextualMemoryItem(make_node(7))
    copied = copy.deepcopy(view)
    assert copied.memory == view.memory
    assert copied.build().to_dict() == view.build().to_dict()
