# memos/reranker/cosine_local.py
from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.utils import timed

from .base import BaseReranker


if TYPE_CHECKING:
    from memos.memories.textual.item import TextualMemoryItem

try:
    import numpy as _np

    _HAS_NUMPY = True
except Exception:
    _HAS_NUMPY = False

logger = get_logger(__name__)


def _cosine_one_to_many(q: list[float], m: list[list[float]]) -> list[float]:
    """
    Compute cosine similarities between a single vector q and a matrix m (rows are candidates).
    """
    if not _HAS_NUMPY:

        def dot(a, b):  # lowercase per N806
            return sum(x * y for x, y in zip(a, b, strict=False))

        def norm(a):  # lowercase per N806
            return sum(x * x for x in a) ** 0.5

        qn = norm(q) or 1e-10
        sims = []
        for v in m:
            vn = norm(v) or 1e-10
            sims.append(dot(q, v) / (qn * vn))
        return sims

    qv = _np.asarray(q, dtype=float)  # lowercase
    mv = _np.asarray(m, dtype=float)  # lowercase
    qn = _np.linalg.norm(qv) or 1e-10
    mn = _np.linalg.norm(mv, axis=1)  # lowercase
    dots = mv @ qv
    return (dots / (mn * qn + 1e-10)).tolist()


class CosineLocalReranker(BaseReranker):
    def __init__(
        self,
        level_weights: dict[str, float] | None = None,
        level_field: str = "background",
        **kwargs,
    ):
        self.level_weights = level_weights or {"topic": 1.0, "concept": 1.0, "fact": 1.0}
        self.level_field = level_field

    @timed
    def rerank(
        self,
        query: str,
        graph_results: list,
        top_k: int,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        if not graph_results:
            return []

        query_embedding: list[float] | None = kwargs.get("query_embedding")
        if not query_embedding:
            return [(item, 0.0) for item in graph_results[:top_k]]

        items_with_emb = [
            it
            for it in graph_results
            if getattr(it, "metadata", None) and getattr(it.metadata, "embedding", None)
        ]
        if not items_with_emb:
            return [(item, 0.5) for item in graph_results[:top_k]]

        cand_vecs = [it.metadata.embedding for it in items_with_emb]
        sims = _cosine_one_to_many(query_embedding, cand_vecs)

        def get_weight(it: TextualMemoryItem) -> float:
            level = getattr(it.metadata, self.level_field, None)
            return self.level_weights.get(level, 1.0)

        weighted = [sim * get_weight(it) for sim, it in zip(sims, items_with_emb, strict=False)]
        scored_pairs = list(zip(items_with_emb, weighted, strict=False))
        scored_pairs.sort(key=lambda x: x[1], reverse=True)

        top_items = scored_pairs[:top_k]
        if len(top_items) < top_k:
            chosen = {it.id for it, _ in top_items}
            remain = [(it, -1.0) for it in graph_results if it.id not in chosen]
            top_items.extend(remain[: top_k - len(top_items)])
        logger.info(f"CosineLocalReranker rerank result: {top_items[:1]}")
        return top_items
