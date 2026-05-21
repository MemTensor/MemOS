from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.reranker.cosine_local import CosineLocalReranker
from memos.reranker.noop import NoopReranker


def _memory_item(item_id: str, memory: str, embedding: list[float] | None = None):
    return TextualMemoryItem(
        id=item_id,
        memory=memory,
        metadata=TreeNodeTextualMemoryMetadata(
            background="topic",
            embedding=embedding,
            sources=[],
        ),
    )


def test_noop_reranker_returns_top_k_items_with_zero_scores():
    items = [
        _memory_item("00000000-0000-0000-0000-000000000001", "first"),
        _memory_item("00000000-0000-0000-0000-000000000002", "second"),
        _memory_item("00000000-0000-0000-0000-000000000003", "third"),
    ]

    ranked = NoopReranker().rerank("query", items, top_k=2)

    assert ranked == [(items[0], 0.0), (items[1], 0.0)]


def test_cosine_local_reranker_returns_empty_for_empty_results():
    assert CosineLocalReranker().rerank("query", [], top_k=3, query_embedding=[1.0, 0.0]) == []


def test_cosine_local_reranker_falls_back_without_query_embedding():
    items = [_memory_item("00000000-0000-0000-0000-000000000001", "first")]

    assert CosineLocalReranker().rerank("query", items, top_k=1) == [(items[0], 0.0)]


def test_cosine_local_reranker_scores_and_sorts_embedded_items():
    near = _memory_item(
        "00000000-0000-0000-0000-000000000001",
        "near",
        embedding=[1.0, 0.0],
    )
    far = _memory_item(
        "00000000-0000-0000-0000-000000000002",
        "far",
        embedding=[0.0, 1.0],
    )

    ranked = CosineLocalReranker().rerank(
        "query",
        [far, near],
        top_k=2,
        query_embedding=[1.0, 0.0],
    )

    assert ranked[0][0] == near
    assert ranked[0][1] > ranked[1][1]


def test_cosine_local_reranker_fills_missing_embeddings_with_negative_score():
    embedded = _memory_item(
        "00000000-0000-0000-0000-000000000001",
        "embedded",
        embedding=[1.0, 0.0],
    )
    missing = _memory_item("00000000-0000-0000-0000-000000000002", "missing")

    ranked = CosineLocalReranker().rerank(
        "query",
        [missing, embedded],
        top_k=2,
        query_embedding=[1.0, 0.0],
    )

    assert ranked[0][0] == embedded
    assert ranked[1] == (missing, -1.0)
