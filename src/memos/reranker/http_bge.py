# memos/reranker/http_bge.py
from __future__ import annotations

import re

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

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
DEFAULT_BOOST_WEIGHTS = {"user_id": 0.5, "tags": 0.2, "session_id": 0.3}


def _value_matches(item_value: Any, wanted: Any) -> bool:
    """
    Generic matching:
    - if item_value is list/tuple/set: check membership (any match if wanted is iterable)
    - else: equality (any match if wanted is iterable)
    """

    def _iterable(x):
        # exclude strings from "iterable"
        return isinstance(x, Iterable) and not isinstance(x, str | bytes)

    if _iterable(item_value):
        if _iterable(wanted):
            return any(w in item_value for w in wanted)
        return wanted in item_value
    else:
        if _iterable(wanted):
            return any(item_value == w for w in wanted)
        return item_value == wanted


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
        boost_weights: dict[str, float] | None = None,
        boost_default: float = 0.0,
        warn_unknown_filter_keys: bool = True,
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

        self.boost_weights = (
            DEFAULT_BOOST_WEIGHTS.copy()
            if boost_weights is None
            else {k: float(v) for k, v in boost_weights.items()}
        )
        self.boost_default = float(boost_default)
        self.warn_unknown_filter_keys = bool(warn_unknown_filter_keys)
        self._warned_missing_keys: set[str] = set()

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
                        raw_score = float(r.get("relevance_score", r.get("score", 0.0)))
                        item = graph_results[idx]
                        # generic boost
                        score = self._apply_boost_generic(item, raw_score, search_filter)
                        scored_items.append((item, score))

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

                scored_items = []
                for item, raw_score in zip(graph_results, score_list, strict=False):
                    score = self._apply_boost_generic(item, raw_score, search_filter)
                    scored_items.append((item, score))

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

    def _get_attr_or_key(self, obj: Any, key: str) -> Any:
        """
        Resolve `key` on `obj` with one-level fallback into `obj.metadata`.

        Priority:
          1) obj.<key>
          2) obj[key]
          3) obj.metadata.<key>
          4) obj.metadata[key]
        """
        if obj is None:
            return None

        # support input like "metadata.user_id"
        if "." in key:
            head, tail = key.split(".", 1)
            base = self._get_attr_or_key(obj, head)
            return self._get_attr_or_key(base, tail)

        def _resolve(o: Any, k: str):
            if o is None:
                return None
            v = getattr(o, k, None)
            if v is not None:
                return v
            if hasattr(o, "get"):
                try:
                    return o.get(k)
                except Exception:
                    return None
            return None

        # 1) find in obj
        v = _resolve(obj, key)
        if v is not None:
            return v

        # 2) find in obj.metadata
        meta = _resolve(obj, "metadata")
        if meta is not None:
            return _resolve(meta, key)

        return None

    def _apply_boost_generic(
        self,
        item: TextualMemoryItem,
        base_score: float,
        search_filter: dict | None,
    ) -> float:
        """
        Multiply base_score by (1 + weight) for each matching key in search_filter.
        - key resolution: self._get_attr_or_key(item, key)
        - weight = boost_weights.get(key, self.boost_default)
        - unknown key -> one-time warning
        """
        if not search_filter:
            return base_score

        score = float(base_score)

        for key, wanted in search_filter.items():
            # _get_attr_or_key automatically find key in item and
            # item.metadata ("metadata.user_id" supported)
            resolved = self._get_attr_or_key(item, key)

            if resolved is None:
                if self.warn_unknown_filter_keys and key not in self._warned_missing_keys:
                    logger.warning(
                        "[HTTPBGEReranker] search_filter key '%s' not found on TextualMemoryItem or metadata",
                        key,
                    )
                    self._warned_missing_keys.add(key)
                continue

            if _value_matches(resolved, wanted):
                w = float(self.boost_weights.get(key, self.boost_default))
                if w != 0.0:
                    score *= 1.0 + w
                    score = min(max(0.0, score), 1.0)

        return score
