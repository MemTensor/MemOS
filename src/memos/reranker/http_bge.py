# memos/reranker/http_bge.py
from __future__ import annotations

from typing import TYPE_CHECKING

import requests

from .base import BaseReranker
from .concat import concat_original_source
from memos.log import get_logger

logger = get_logger(__name__)


if TYPE_CHECKING:
    from memos.memories.textual.item import TextualMemoryItem


class HTTPBGEReranker(BaseReranker):
    """
    HTTP-based BGE reranker. Mirrors your old MemoryReranker, but configurable.
    """

    def __init__(
        self,
        reranker_url: str,
        token: str = "",
        model: str = "bge-reranker-v2-m3",
        timeout: int = 10,
        headers_extra: dict | None = None,
        concat_source: List[str]=["sources"],
    ):
        if not reranker_url:
            raise ValueError("reranker_url must not be empty")
        self.reranker_url = reranker_url
        self.token = token or ""
        self.model = model
        self.timeout = timeout
        self.headers_extra = headers_extra or {}
        self.concat_source = concat_source

    def rerank(
        self,
        query: str,
        graph_results: list,
        top_k: int,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        if not graph_results:
            return []

        documents = []
        if self.concat_source:
            documents = concat_original_source(graph_results)
        else:
            documents = [getattr(item, "memory", None) for item in graph_results]
            documents = [d for d in documents if isinstance(d, str) and d]

        logger.info(f"[HTTPBGERerankerSample] query: {query} , documents: {documents[:5]}...")
        if not documents:
            return []

        headers = {"Content-Type": "application/json", **self.headers_extra}
        payload = {"model": self.model, "query": query, "documents": documents}

        try:
            resp = requests.post(
                self.reranker_url, headers=headers, json=payload, timeout=self.timeout
            )
            resp.raise_for_status()
            data = resp.json()

            scored_items: list[tuple[TextualMemoryItem, float]] = []

            if "results" in data:
                rows = data.get("results", [])
                for r in rows:
                    idx = r.get("index")
                    if isinstance(idx, int) and 0 <= idx < len(graph_results):
                        score = float(r.get("relevance_score", r.get("score", 0.0)))
                        scored_items.append((graph_results[idx], score))

                scored_items.sort(key=lambda x: x[1], reverse=True)
                return scored_items[: min(top_k, len(scored_items))]

            elif "data" in data:
                rows = data.get("data", [])
                score_list = [float(r.get("score", 0.0)) for r in rows]

                if len(score_list) < len(graph_results):
                    score_list += [0.0] * (len(graph_results) - len(score_list))
                elif len(score_list) > len(graph_results):
                    score_list = score_list[: len(graph_results)]

                scored_items = list(zip(graph_results, score_list, strict=False))
                scored_items.sort(key=lambda x: x[1], reverse=True)
                return scored_items[: min(top_k, len(scored_items))]

            else:
                return [(item, 0.0) for item in graph_results[:top_k]]

        except Exception as e:
            logger.error(f"[HTTPBGEReranker] request failed: {e}")
            return [(item, 0.0) for item in graph_results[:top_k]]
