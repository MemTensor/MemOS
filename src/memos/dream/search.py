from __future__ import annotations

import logging

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from memos.dream.contextualization import CONTEXT_MEMORY_TYPE


if TYPE_CHECKING:
    from memos.api.product_models import APISearchRequest


logger = logging.getLogger(__name__)

_DEFAULT_CONTEXT_RECALL_TOP_K = 2
_CONTEXT_RETURN_FIELDS = [
    "memory",
    "key",
    "created_at",
    "updated_at",
    "source",
    "internal_info",
]


@dataclass
class DreamContextSearchExtension:
    """Dream-owned search extension for recalling Context nodes.

    The core SearchHandler only exposes a generic plugin hook. This extension
    owns Dream-specific retrieval details such as the Context memory type,
    graph scope, metadata formatting, and fallback behavior.
    """

    top_k: int = _DEFAULT_CONTEXT_RECALL_TOP_K

    def merge_context_recall(
        self,
        *,
        handler,
        search_req: APISearchRequest,
        results: dict[str, Any],
    ) -> dict[str, Any]:
        top_k = max(0, int(self.top_k or 0))
        if top_k <= 0:
            return results

        context_buckets = self._recall_context_buckets(
            handler=handler,
            search_req=search_req,
            top_k=top_k,
        )
        if context_buckets:
            results.setdefault("text_mem", []).extend(context_buckets)
        return results

    def _recall_context_buckets(
        self, *, handler, search_req: APISearchRequest, top_k: int
    ) -> list[dict[str, Any]]:
        graph_db = getattr(handler, "graph_db", None) or getattr(
            handler.searcher, "graph_store", None
        )
        embedder = getattr(handler, "embedder", None) or getattr(handler.searcher, "embedder", None)
        if graph_db is None or embedder is None:
            logger.info("[Dream Search] Context recall skipped: graph_db or embedder unavailable.")
            return []

        try:
            query_embedding = embedder.embed([search_req.query])[0]
        except Exception:
            logger.warning("[Dream Search] Context recall embedding failed.", exc_info=True)
            return []

        buckets: list[dict[str, Any]] = []
        for cube_id in _resolve_cube_ids(search_req):
            try:
                hits = graph_db.search_by_embedding(
                    query_embedding,
                    top_k=top_k,
                    scope=CONTEXT_MEMORY_TYPE,
                    status="activated",
                    user_name=cube_id,
                    return_fields=_CONTEXT_RETURN_FIELDS,
                )
            except Exception:
                logger.warning(
                    "[Dream Search] Context recall search failed for cube=%s.",
                    cube_id,
                    exc_info=True,
                )
                continue

            memories = [_format_context_hit(hit) for hit in hits or [] if hit.get("memory")]
            if not memories:
                continue
            buckets.append(
                {
                    "cube_id": cube_id,
                    "memories": memories,
                    "total_nodes": len(memories),
                }
            )
        return buckets


def _resolve_cube_ids(search_req: APISearchRequest) -> list[str]:
    if search_req.readable_cube_ids:
        return list(dict.fromkeys(search_req.readable_cube_ids))
    return [search_req.user_id]


def _format_context_hit(hit: dict[str, Any]) -> dict[str, Any]:
    context_id = str(hit.get("id", ""))
    score = float(hit.get("score", 0.0) or 0.0)
    metadata = {
        "id": context_id,
        "memory": hit.get("memory", ""),
        "memory_type": CONTEXT_MEMORY_TYPE,
        "source": hit.get("source") or "dream",
        "key": hit.get("key", ""),
        "relativity": score,
        "score": score,
        "embedding": [],
        "sources": [],
        "usage": [],
        "ref_id": f"[{context_id.split('-')[0]}]" if context_id else "[context]",
    }
    for field in ("created_at", "updated_at", "internal_info"):
        if hit.get(field) is not None:
            metadata[field] = hit[field]

    return {
        "id": context_id,
        "memory": hit.get("memory", ""),
        "metadata": metadata,
        "ref_id": metadata["ref_id"],
    }
