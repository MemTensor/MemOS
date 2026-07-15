# memos/reranker/base.py
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from memos.memories.textual.item import TextualMemoryItem


class BaseReranker(ABC):
    """Abstract interface for memory rerankers."""

    @abstractmethod
    def rerank(
        self,
        query: str,
        graph_results: list[TextualMemoryItem],
        top_k: int,
        search_filter: dict | None = None,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        """Return top_k (item, score) sorted by score desc."""
        raise NotImplementedError
