from __future__ import annotations

import logging

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from memos.dream.types import DreamCluster


logger = logging.getLogger(__name__)

_RECALL_TOP_K = 10
_RECALL_SCOPES = ("UserMemory", "LongTermMemory")


class DirectRecall:
    """Dream recall stage — use source memory embeddings to recall related memories.

    For each memory_id in the cluster, retrieves its embedding and runs
    ``search_by_embedding`` against the graph DB once per allowed scope
    (``UserMemory`` and ``LongTermMemory``). Results across all source
    memories and scopes are deduplicated and sorted by score, then the top-k
    are kept as ``cluster.recalled_items``.

    Scope is restricted on purpose: Dream-produced nodes (DreamDiary,
    InsightMemory, …) and short-lived WorkingMemory are excluded so that
    each Dream run reflects on the user's real daytime experiences rather
    than its own previous outputs.
    """

    def __init__(self, *, recall_top_k: int = _RECALL_TOP_K) -> None:
        self.recall_top_k = recall_top_k

    def bind_context(self, context: dict) -> None:
        self.context = context

    def gather(self, *, clusters: list[DreamCluster], text_mem, cube_id: str) -> list[DreamCluster]:
        if not clusters:
            return clusters

        graph_db = self.context.get("shared", {}).get("graph_db")

        for cluster in clusters:
            cluster.recalled_items = self._recall_by_embeddings(
                cluster.motive.memory_ids, graph_db, cube_id
            )
            logger.info(
                "[Dream Recall] cluster=%s recalled=%d",
                cluster.cluster_id,
                len(cluster.recalled_items),
            )

        return clusters

    def _recall_by_embeddings(
        self, memory_ids: list[str], graph_db, cube_id: str
    ) -> list[dict[str, Any]]:
        if not memory_ids or graph_db is None:
            return []

        try:
            nodes = graph_db.get_nodes(memory_ids, include_embedding=True, user_name=cube_id)
        except Exception:
            logger.warning("[Dream Recall] failed to fetch source memory embeddings.")
            return []

        source_id_set = set(memory_ids)
        seen: dict[str, dict[str, Any]] = {}

        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
            embedding = metadata.get("embedding") if metadata else None
            if not embedding:
                continue

            for scope in _RECALL_SCOPES:
                try:
                    hits = graph_db.search_by_embedding(
                        embedding,
                        top_k=self.recall_top_k,
                        scope=scope,
                        status="activated",
                        return_fields=["memory", "created_at"],
                        user_name=cube_id,
                    )
                except Exception:
                    logger.warning(
                        "[Dream Recall] embedding search failed for node=%s scope=%s",
                        node.get("id"),
                        scope,
                    )
                    continue

                for hit in hits:
                    hit_id = hit.get("id", "")
                    if not hit_id or hit_id in source_id_set:
                        continue
                    score = float(hit.get("score", 0.0))
                    if hit_id not in seen or score > seen[hit_id]["score"]:
                        seen[hit_id] = {
                            "id": hit_id,
                            "memory": hit.get("memory", ""),
                            "score": score,
                            "created_at": hit.get("created_at", ""),
                        }

        ranked = sorted(seen.values(), key=lambda x: x["score"], reverse=True)
        return ranked[: self.recall_top_k]
