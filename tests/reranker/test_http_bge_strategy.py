from unittest.mock import Mock, patch

import pytest

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.reranker.http_bge_strategy import HTTPBGERerankerStrategy


@pytest.mark.parametrize("strategy", ["concat_background", "concat_docsource"])
@pytest.mark.parametrize("top_k", [1, 2])
@pytest.mark.parametrize(
    "results",
    [
        [
            {"index": 1, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.1},
        ],
        [{"index": 1, "relevance_score": 0.9}],
    ],
    ids=["reordered", "partial"],
)
def test_concat_strategies_keep_scores_with_returned_memories(
    strategy: str, top_k: int, results: list[dict[str, int | float]]
) -> None:
    items = [
        TextualMemoryItem(
            id=f"00000000-0000-0000-0000-{index:012d}",
            memory=f"Memory {name}",
            metadata=TreeNodeTextualMemoryMetadata(
                background=f"Background {name}",
                sources=[{"type": "file", "content": f"Source {name}"}],
            ),
        )
        for index, name in enumerate(["A", "B"], start=1)
    ]
    reranker = HTTPBGERerankerStrategy(
        reranker_url="https://reranker.example/rerank",
        reranker_strategy=strategy,
    )
    response = Mock()
    response.json.return_value = {"results": results}

    with patch("memos.reranker.http_bge_strategy.requests.post", return_value=response) as post:
        ranked = reranker.rerank("query", items, top_k=top_k)

    post.assert_called_once()
    response.raise_for_status.assert_called_once()
    expected = [(items[1], 0.9)]
    if len(results) == 2 and top_k == 2:
        expected.append((items[0], 0.1))
    assert ranked == expected
