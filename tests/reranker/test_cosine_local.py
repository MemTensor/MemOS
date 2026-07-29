"""Tests for CosineLocalReranker numerical stability."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from memos.reranker.cosine_local import CosineLocalReranker, _cosine_one_to_many


class MemoryStub:
    def __init__(self, memory_id, embedding, background="fact"):
        self.id = memory_id
        self.memory = f"memory-{memory_id}"
        self.metadata = SimpleNamespace(embedding=embedding, background=background)


def _make_items(embeddings, backgrounds=None):
    backgrounds = backgrounds or ["fact"] * len(embeddings)
    return [MemoryStub(i, emb, bg) for i, (emb, bg) in enumerate(zip(embeddings, backgrounds, strict=False))]


class TestCosineOneToManyNumerical:
    def test_basic_identical_vector_returns_one(self):
        q = [1.0, 0.0, 0.0]
        m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        result = _cosine_one_to_many(q, m)
        assert len(result) == 2
        assert abs(result[0] - 1.0) < 1e-6
        assert abs(result[1]) < 1e-6

    def test_orthogonal_returns_zero(self):
        q = [1.0, 0.0]
        m = [[0.0, 1.0]]
        result = _cosine_one_to_many(q, m)
        assert abs(result[0]) < 1e-6

    def test_opposite_direction(self):
        q = [1.0, 0.0]
        m = [[-1.0, 0.0]]
        result = _cosine_one_to_many(q, m)
        assert abs(result[0] - (-1.0)) < 1e-6

    def test_empty_matrix_returns_empty(self):
        q = [1.0, 2.0, 3.0]
        m = []
        result = _cosine_one_to_many(q, m)
        assert result == []

    def test_zero_query_vector(self):
        q = [0.0, 0.0, 0.0]
        m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        result = _cosine_one_to_many(q, m)
        assert len(result) == 2
        for r in result:
            assert r == 0.0

    def test_zero_candidate_vectors(self):
        q = [1.0, 0.0, 0.0]
        m = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
        result = _cosine_one_to_many(q, m)
        assert len(result) == 2
        assert result[0] == 0.0
        assert abs(result[1] - 1.0) < 1e-6

    def test_2d_query_vector_flattened(self):
        q = [[1.0, 0.0, 0.0]]
        m = [[1.0, 0.0, 0.0]]
        result = _cosine_one_to_many(q, m)
        assert len(result) == 1
        assert abs(result[0] - 1.0) < 1e-6

    def test_no_nan_in_output_normalized_vectors(self):
        q = [1.0]
        m = [[0.0]]
        result = _cosine_one_to_many(q, m)
        assert not any(r != r for r in result)
        assert result[0] == 0.0

    def test_multiple_equal_length_vectors(self):
        q = [1.0, 2.0]
        m = [[3.0, 4.0], [1.0, 2.0], [0.5, 1.0]]
        result = _cosine_one_to_many(q, m)
        assert len(result) == 3
        assert all(-1.0 - 1e-6 <= r <= 1.0 + 1e-6 for r in result)


class TestCosineLocalReranker:
    def test_empty_graph_results(self):
        reranker = CosineLocalReranker()
        assert reranker.rerank("query", [], top_k=5) == []

    def test_rerank_preserves_top_items(self):
        embeddings = [
            [1.0, 0.0, 0.0],
            [0.9, 0.1, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.9, 0.1],
        ]
        items = _make_items(embeddings)
        query_emb = [1.0, 0.0, 0.0]
        reranker = CosineLocalReranker()
        result = reranker.rerank("any", items, top_k=2, query_embedding=query_emb)
        ids = [it.id for it, _ in result]
        assert len(result) == 2
        assert ids[0] == 0 or ids[0] == 1
        assert ids[1] == 0 or ids[1] == 1

    def test_rerank_without_embeddings_falls_back(self):
        items = [MemoryStub(i, None) for i in range(3)]
        query_emb = [1.0, 0.0, 0.0]
        reranker = CosineLocalReranker()
        result = reranker.rerank("any", items, top_k=5, query_embedding=query_emb)
        assert len(result) == 3

    def test_level_weights_applied(self):
        embeddings = [[1.0, 0.0], [1.0, 0.0]]
        backgrounds = ["topic", "fact"]
        items = _make_items(embeddings, backgrounds)
        query_emb = [1.0, 0.0]
        reranker = CosineLocalReranker(
            level_weights={"topic": 2.0, "concept": 1.0, "fact": 0.5},
            level_field="background",
        )
        result = reranker.rerank("any", items, top_k=2, query_embedding=query_emb)
        ids = [it.id for it, _ in result]
        scores = {it.id: sc for it, sc in result}
        assert ids[0] == 0
        assert scores[0] > scores[1]
