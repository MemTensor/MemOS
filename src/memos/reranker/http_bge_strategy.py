import re
import json
import requests
from typing import TYPE_CHECKING, Literal

from memos.log import get_logger

from .base import BaseReranker
from .item import DialogueRankingTracker
from .concat import concat_original_source, concat_single_turn

logger = get_logger(__name__)

from memos.memories.textual.item import TextualMemoryItem

_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


class HTTPBGEWithStrategyReranker(BaseReranker):
    """
    HTTP-based BGE reranker with enhanced source text processing.
    Supports multiple text concatenation strategies including dialogue pairing.
    """

    def __init__(
        self,
        reranker_url: str,
        token: str = "",
        model: str = "bge-reranker-v2-m3",
        timeout: int = 10,
        headers_extra: dict | None = None,
        rerank_source: list[str] | None = None,
        concat_strategy: Literal["user", "assistant", "single_turn"] = "single_turn",
        source_weight: float = 0.3,
    ):
        if not reranker_url:
            raise ValueError("reranker_url must not be empty")
        
        self.reranker_url = reranker_url
        self.token = token or ""
        self.model = model
        self.timeout = timeout
        self.headers_extra = headers_extra or {}
        self.concat_strategy = concat_strategy
        self.source_weight = source_weight

    def _prepare_documents(self, graph_results: list) -> tuple[DialogueRankingTracker, dict[str, any], list[str]]:
        """Prepare documents based on the concatenation strategy.
        Args:
            graph_results: List of graph results
        Returns:
            tuple[DialogueRankingTracker, dict[str, any], list[str]]: Tracker, original items, documents
        """
        documents = []
        tracker = None
        original_items = None

        if self.concat_strategy == "single_turn":
            tracker, original_items = concat_single_turn(graph_results)
            documents = tracker.get_documents_for_ranking()

        elif self.concat_strategy == "user":
            raise NotImplementedError("User strategy is not implemented")

        elif self.concat_strategy == "assistant":
            raise NotImplementedError("Assistant strategy is not implemented")

        else:
            raise ValueError(f"Unknown concat_strategy: {self.concat_strategy}")
        
        return tracker, original_items, documents

    def rerank(
        self,
        query: str,
        graph_results: list,
        top_k: int,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        if not graph_results:
            return []

        tracker, original_items, documents = self._prepare_documents(graph_results)
        
        logger.info(
            f"[HTTPBGEWithSourceReranker] strategy: {self.concat_strategy}, "
            f"query: {query}, documents count: {len(documents)}"
        )
        logger.debug(f"[HTTPBGEWithSourceReranker] sample documents: {documents[:2]}...")

        if not documents:
            return []

        headers = {"Content-Type": "application/json", **self.headers_extra}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        payload = {"model": self.model, "query": query, "documents": documents}

        try:
            resp = requests.post(
                self.reranker_url, headers=headers, json=payload, timeout=self.timeout
            )
            resp.raise_for_status()
            data = resp.json()
            logger.info(f"[HTTPBGEWithStrategyReranker] response: {json.dumps(data, indent=4)}")
            # Parse ranking results
            ranked_indices = []
            scores = []

            if "results" in data:
                rows = data.get("results", [])
                for r in rows:
                    idx = r.get("index")
                    if isinstance(idx, int) and 0 <= idx < len(documents):
                        score = float(r.get("relevance_score", r.get("score", 0.0)))
                        ranked_indices.append(idx)
                        scores.append(score)

            elif "data" in data:
                rows = data.get("data", [])
                score_list = [float(r.get("score", 0.0)) for r in rows]
                
                # Create ranked indices based on scores
                indexed_scores = [(i, score) for i, score in enumerate(score_list)]
                indexed_scores.sort(key=lambda x: x[1], reverse=True)
                
                ranked_indices = [idx for idx, _ in indexed_scores]
                scores = [score for _, score in indexed_scores]

            else:
                # Fallback: return original items with zero scores
                return [(item, 0.0) for item in graph_results[:top_k]]

            # Reconstruct memory items from ranked dialogue pairs
            reconstructed_items = tracker.reconstruct_memory_items(
                ranked_indices, scores, original_items, top_k
            )
            
            logger.info(f"[HTTPBGEDialogueReranker] reconstructed {len(reconstructed_items)} memory items")
            return reconstructed_items

        except Exception as e:
            logger.error(f"[HTTPBGEWithSourceReranker] request failed: {e}")
            return [(item, 0.0) for item in graph_results[:top_k]] 