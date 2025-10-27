from abc import ABC, abstractmethod
from typing import Any

from memos.memories.textual.item import TextualMemoryItem

from .dialogue_common import DialogueRankingTracker


class BaseRerankerStrategy(ABC):
    """Abstract interface for memory rerankers with concatenation strategy."""

    @abstractmethod
    def prepare_documents(
        self,
        query: str,
        graph_results: list[TextualMemoryItem],
        top_k: int,
        **kwargs,
    ) -> tuple[DialogueRankingTracker, dict[str, Any], list[str]]:
        """
        Prepare documents for ranking based on the strategy.

        Args:
            query: The search query
            graph_results: List of TextualMemoryItem objects to process
            top_k: Maximum number of items to return
            **kwargs: Additional strategy-specific parameters

        Returns:
            tuple[DialogueRankingTracker, dict[str, Any], list[str]]:
            - Tracker: DialogueRankingTracker instance
            - original_items: Dict mapping memory_id to original TextualMemoryItem
            - documents: List of text documents ready for ranking
        """
        raise NotImplementedError

    @abstractmethod
    def reconstruct_items(
        self,
        ranked_indices: list[int],
        scores: list[float],
        tracker: DialogueRankingTracker,
        original_items: dict[str, Any],
        top_k: int,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        """
        Reconstruct TextualMemoryItem objects from ranked results.

        Args:
            ranked_indices: List of indices sorted by relevance
            scores: Corresponding relevance scores
            tracker: DialogueRankingTracker instance
            original_items: Dict mapping memory_id to original TextualMemoryItem
            top_k: Maximum number of items to return
            **kwargs: Additional strategy-specific parameters

        Returns:
            List of (reconstructed_memory_item, aggregated_score) tuples
        """
        raise NotImplementedError
