# memos/reranker/http_bge.py
from __future__ import annotations

import re

from typing import TYPE_CHECKING

import requests

from memos.log import get_logger

from .base import BaseReranker
from .concat import concat_original_source


logger = get_logger(__name__)


if TYPE_CHECKING:
    from memos.memories.textual.item import TextualMemoryItem

# Strip a leading "[...]" tag (e.g., "[2025-09-01] ..." or "[meta] ...")
# before sending text to the reranker. This keeps inputs clean and
# avoids misleading the model with bracketed prefixes.
_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


class HTTPBGEReranker(BaseReranker):
    """
    HTTP-based BGE reranker.

    This class sends (query, documents[]) to a remote HTTP endpoint that
    performs cross-encoder-style re-ranking (e.g., BGE reranker) and returns
    relevance scores. It then maps those scores back onto the original
    TextualMemoryItem list and returns (item, score) pairs sorted by score.

    Notes
    -----
    - The endpoint is expected to accept JSON:
        {
          "model": "<model-name>",
          "query": "<query text>",
          "documents": ["doc1", "doc2", ...]
        }
    - Two response shapes are supported:
        1) {"results": [{"index": <int>, "relevance_score": <float>}, ...]}
           where "index" refers to the *position in the documents array*.
        2) {"data": [{"score": <float>}, ...]} (aligned by list order)
    - If the service fails or responds unexpectedly, this falls back to
      returning the original items with 0.0 scores (best-effort).
    """

    def __init__(
        self,
        reranker_url: str,
        token: str = "",
        model: str = "bge-reranker-v2-m3",
        timeout: int = 10,
        headers_extra: dict | None = None,
        rerank_source: list[str] | None = None,
        **kwargs,
    ):
        """
        Parameters
        ----------
        reranker_url : str
            HTTP endpoint for the reranker service.
        token : str, optional
            Bearer token for auth. If non-empty, added to the Authorization header.
        model : str, optional
            Model identifier understood by the server.
        timeout : int, optional
            Request timeout (seconds).
        headers_extra : dict | None, optional
            Additional headers to merge into the request headers.
        """
        if not reranker_url:
            raise ValueError("reranker_url must not be empty")
        self.reranker_url = reranker_url
        self.token = token or ""
        self.model = model
        self.timeout = timeout
        self.headers_extra = headers_extra or {}
        self.concat_source = rerank_source

    def rerank(
        self,
        query: str,
        graph_results: list[TextualMemoryItem],
        top_k: int,
        search_filter: dict | None = None,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        """
        Rank candidate memories by relevance to the query.

        Parameters
        ----------
        query : str
            The search query.
        graph_results : list[TextualMemoryItem]
            Candidate items to re-rank. Each item is expected to have a
            `.memory` str field; non-strings are ignored.
        top_k : int
            Return at most this many items.
        search_filter : dict | None
            Currently unused. Present to keep signature compatible.

        Returns
        -------
        list[tuple[TextualMemoryItem, float]]
            Re-ranked items with scores, sorted descending by score.
        """
        if not graph_results:
            return []

        # Build a mapping from "payload docs index" -> "original graph_results index"
        # Only include items that have a non-empty string memory. This ensures that
        # any index returned by the server can be mapped back correctly.
        documents = []
        if self.concat_source:
            documents = concat_original_source(graph_results, self.concat_source)
        else:
            documents = [
                (_TAG1.sub("", m) if isinstance((m := getattr(item, "memory", None)), str) else m)
                for item in graph_results
            ]
            documents = [d for d in documents if isinstance(d, str) and d]

        logger.info(f"[HTTPBGERerankerSample] query: {query} , documents: {documents[:5]}...")

        if not documents:
            return []

        headers = {"Content-Type": "application/json", **self.headers_extra}
        payload = {"model": self.model, "query": query, "documents": documents}

        try:
            # Make the HTTP request to the reranker service
            resp = requests.post(
                self.reranker_url, headers=headers, json=payload, timeout=self.timeout
            )
            resp.raise_for_status()
            data = resp.json()

            scored_items: list[tuple[TextualMemoryItem, float]] = []

            if "results" in data:
                # Format:
                # dict("results": [{"index": int, "relevance_score": float},
                # ...])
                rows = data.get("results", [])
                for r in rows:
                    idx = r.get("index")
                    # The returned index refers to 'documents' (i.e., our 'pairs' order),
                    # so we must map it back to the original graph_results index.
                    if isinstance(idx, int) and 0 <= idx < len(graph_results):
                        score = float(r.get("relevance_score", r.get("score", 0.0)))
                        scored_items.append((graph_results[idx], score))

                scored_items.sort(key=lambda x: x[1], reverse=True)
                return scored_items[: min(top_k, len(scored_items))]

            elif "data" in data:
                # Format: {"data": [{"score": float}, ...]} aligned by list order
                rows = data.get("data", [])
                # Build a list of scores aligned with our 'documents' (pairs)
                score_list = [float(r.get("score", 0.0)) for r in rows]

                if len(score_list) < len(graph_results):
                    score_list += [0.0] * (len(graph_results) - len(score_list))
                elif len(score_list) > len(graph_results):
                    score_list = score_list[: len(graph_results)]

                # Map back to original items using 'pairs'
                scored_items = list(zip(graph_results, score_list, strict=False))
                scored_items.sort(key=lambda x: x[1], reverse=True)
                return scored_items[: min(top_k, len(scored_items))]

            else:
                # Unexpected response schema: return a 0.0-scored fallback of the first top_k valid docs
                # Note: we use 'pairs' to keep alignment with valid (string) docs.
                return [(item, 0.0) for item in graph_results[:top_k]]

        except Exception as e:
            # Network error, timeout, JSON decode error, etc.
            # Degrade gracefully by returning first top_k valid docs with 0.0 score.
            logger.error(f"[HTTPBGEReranker] request failed: {e}")
            return [(item, 0.0) for item in graph_results[:top_k]]
