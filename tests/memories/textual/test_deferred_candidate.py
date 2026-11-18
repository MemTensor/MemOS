import uuid

from unittest.mock import Mock, patch

import pytest

from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.recall import GraphMemoryRetriever
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher


@pytest.fixture
def retriever():
    store = Mock()
    store.get_nodes.return_value = [
        {
            "id": str(uuid.uuid4()),
            "memory": "first",
            "metadata": {"metadata": {"memory_type": "SkillMemory"}},
        },
        {"id": str(uuid.uuid4()), "memory": "second", "metadata": {"memory_type": "UserMemory"}},
    ]
    store.search_by_embedding.return_value = [
        {"id": node["id"], "score": 1.0 - i / 10}
        for i, node in enumerate(store.get_nodes.return_value)
    ]
    return GraphMemoryRetriever(store, Mock())


@pytest.mark.parametrize("mixed", [False, True])
def test_public_recall_materializes_legacy_nested_metadata(retriever, mixed):
    if mixed:
        results = retriever.retrieve_from_mixed(top_k=2, query_embedding=[[0.1]])
    else:
        results = retriever.retrieve(
            "query",
            ParsedTaskGoal(keys=[], tags=[]),
            top_k=2,
            memory_scope="SkillMemory",
            query_embedding=[[0.1]],
        )

    assert all(isinstance(item, TextualMemoryItem) for item in results)
    assert [item.metadata.memory_type for item in results] == ["SkillMemory", "UserMemory"]


def test_plugin_search_materializes_only_subgroup_survivors(retriever):
    searcher = Searcher.__new__(Searcher)
    searcher.graph_retriever = retriever
    searcher.tokenizer = None
    searcher.embedder = Mock()
    searcher.embedder.embed.return_value = [[0.1], [0.2]]
    searcher.reranker = Mock()
    searcher.reranker.rerank.side_effect = lambda **kw: [(kw["graph_results"][0], 0.7)]

    with (
        patch.object(TextualMemoryItem, "from_dict", wraps=TextualMemoryItem.from_dict) as build,
        patch(
            "memos.memories.textual.tree_text_memory.retrieve.searcher.find_best_unrelated_subgroup",
            return_value=([0], None),
        ),
    ):
        [(result, score)] = searcher._retrieve_simple("sample", top_k=1)

    assert result.metadata.memory_type == "SkillMemory"
    assert score == 0.7
    build.assert_called_once()
    assert build.call_args.args[0]["memory"] == "first"
