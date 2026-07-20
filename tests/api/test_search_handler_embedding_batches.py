from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.search_handler import SearchHandler


class BatchLimitedEmbedder:
    def __init__(self, *, limit: int):
        self.limit = limit
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        if len(texts) > self.limit:
            raise AssertionError(f"batch too large: {len(texts)}")
        return [[float(len(text)), 0.0] for text in texts]


def _handler(embedder: BatchLimitedEmbedder) -> SearchHandler:
    searcher = type("FakeSearcher", (), {"embedder": embedder})()
    return SearchHandler(
        HandlerDependencies(
            naive_mem_cube=object(),
            mem_scheduler=object(),
            searcher=searcher,
            deepsearch_agent=object(),
        )
    )


def test_extract_embeddings_batches_missing_documents():
    embedder = BatchLimitedEmbedder(limit=10)
    handler = _handler(embedder)
    memories = [
        {"memory": f"memory {idx}", "metadata": {}}
        for idx in range(25)
    ]

    embeddings = handler._extract_embeddings(memories)

    assert [len(call) for call in embedder.calls] == [10, 10, 5]
    assert len(embeddings) == 25
    assert all(mem["metadata"]["embedding"] for mem in memories)
