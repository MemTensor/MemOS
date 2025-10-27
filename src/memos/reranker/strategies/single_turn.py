# memos/reranker/strategies/single_turn.py
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .base import BaseRerankerStrategy
from .dialogue_common import DialogueRankingTracker, extract_content, strip_memory_tags


class SingleTurnStrategy(BaseRerankerStrategy):
    """
    Single turn dialogue strategy.

    This strategy processes dialogue pairs by concatenating user and assistant
    messages into single strings for ranking. Each dialogue pair becomes a
    separate document for ranking.
    example:
        >>> documents = ["chat_time: 2025-01-01 12:00:00\nuser: hello\nassistant: hi there"]
        >>> output memory item: ["Memory:xxx \n\n chat_time: 2025-01-01 12:00:00\nuser: hello\nassistant: hi there"]
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
        for item in graph_results:
            memory = strip_memory_tags(item)
            sources = getattr(item.metadata, "sources", [])
            original_items[item.id] = item

            # Group messages into pairs and concatenate
            for i in range(0, len(sources), 2):
                user_msg = sources[i] if i < len(sources) else {}
                assistant_msg = sources[i + 1] if i + 1 < len(sources) else {}

                user_content = extract_content(user_msg)
                assistant_content = extract_content(assistant_msg)
                chat_time = getattr(user_msg, "chat_time", "")

                if user_content or assistant_content:  # Only add non-empty pairs
                    pair_index = i // 2
                    tracker.add_dialogue_pair(
                        item.id, pair_index, user_msg, assistant_msg, memory or "", chat_time
                    )

        documents = tracker.get_documents_for_ranking()
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
        reconstructed_items = []
        for idx, score in zip(ranked_indices, scores, strict=False):
            dialogue_pair = tracker.get_dialogue_pair_by_index(idx)
            if dialogue_pair and (dialogue_pair.memory_id in original_items):
                original_item = original_items[dialogue_pair.memory_id]
                reconstructed_item = deepcopy(original_item)
                reconstructed_item.memory = (
                    dialogue_pair.memory
                    + "\n\nsources-dialogue-pairs"
                    + dialogue_pair.combined_text
                )
                reconstructed_items.append((reconstructed_item, score))

        # Sort by aggregated score and return top_k
        reconstructed_items.sort(key=lambda x: x[1], reverse=True)
        return reconstructed_items[:top_k]
