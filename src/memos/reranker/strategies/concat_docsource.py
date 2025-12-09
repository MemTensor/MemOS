# memos/reranker/strategies/single_turn.py
from __future__ import annotations

import re

from typing import Any

from .base import BaseRerankerStrategy
from .dialogue_common import DialogueRankingTracker


_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


class ConcatDocSourceStrategy(BaseRerankerStrategy):
    """
    Concat background strategy.

    This strategy processes dialogue pairs by concatenating background and
    user and assistant messages into single strings for ranking. Each dialogue pair becomes a
    separate document for ranking.
    """

    """
    Concat background strategy.

    This strategy processes dialogue pairs by concatenating background and
    user and assistant messages into single strings for ranking. Each dialogue pair becomes a
    separate document for ranking.
    """

    def prepare_documents(
        self,
        query: str,
        graph_results: list,
        top_k: int,
        **kwargs,
    ) -> tuple[DialogueRankingTracker, dict[str, Any], list[str]]:
        """
        Prepare documents based on single turn concatenation strategy.

        Args:
            query: The search query
            graph_results: List of graph results
            top_k: Maximum number of items to return

        Returns:
            tuple[DialogueRankingTracker, dict[str, Any], list[str]]:
            - Tracker: DialogueRankingTracker instance
            - original_items: Dict mapping memory_id to original TextualMemoryItem
            - documents: List of text documents ready for ranking
        """

        original_items = {}
        tracker = DialogueRankingTracker()
        documents = []
        for item in graph_results:
            memory = getattr(item, "memory", None)
            if isinstance(memory, str):
                memory = _TAG1.sub("", memory)

            chunk_text = ""
            if hasattr(item, "metadata") and hasattr(item.metadata, "sources"):
                sources = getattr(item.metadata, "sources", [])
                for source in sources:
                    if source.type == "file":
                        chunk_text += source.content
            if chunk_text:
                documents.append(f"{memory}\n\n[Sources]:\n{chunk_text}")
            else:
                documents.append(memory)
        return tracker, original_items, documents

    def reconstruct_items(
        self,
        ranked_indices: list[int],
        scores: list[float],
        tracker: DialogueRankingTracker,
        original_items: dict[str, Any],
        top_k: int,
        **kwargs,
    ) -> list[tuple[Any, float]]:
        """
        Reconstruct TextualMemoryItem objects from ranked dialogue pairs.

        Args:
            ranked_indices: List of dialogue pair indices sorted by relevance
            scores: Corresponding relevance scores
            tracker: DialogueRankingTracker instance
            original_items: Dict mapping memory_id to original TextualMemoryItem
            top_k: Maximum number of items to return

        Returns:
            List of (reconstructed_memory_item, aggregated_score) tuples
        """
        graph_results = kwargs.get("graph_results")
        documents = kwargs.get("documents")
        reconstructed_items = []
        for idx in ranked_indices:
            item = graph_results[idx]
            item.memory = f"{documents[idx]}"
            reconstructed_items.append((item, scores[idx]))

        reconstructed_items.sort(key=lambda x: x[1], reverse=True)
        return reconstructed_items[:top_k]
