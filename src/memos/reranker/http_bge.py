# memos/reranker/http_bge.py
from __future__ import annotations

import re

from typing import TYPE_CHECKING

import requests

from .base import BaseReranker


if TYPE_CHECKING:
    from memos.memories.textual.item import TextualMemoryItem

_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


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
    ):
        if not reranker_url:
            raise ValueError("reranker_url must not be empty")
        self.reranker_url = reranker_url
        self.token = token or ""
        self.model = model
        self.timeout = timeout
        self.headers_extra = headers_extra or {}

    def rerank(
        self,
        query: str,
        graph_results: list,
        top_k: int,
        **kwargs,
    ) -> list[tuple[TextualMemoryItem, float]]:
        if not graph_results:
            return []

        documents = [
            (_TAG1.sub("", m) if isinstance((m := getattr(item, "memory", None)), str) else m)
            for item in graph_results
        ]
        documents = [d for d in documents if isinstance(d, str) and d]
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
            print(f"[HTTPBGEReranker] request failed: {e}")
            return [(item, 0.0) for item in graph_results[:top_k]]
