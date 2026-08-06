from __future__ import annotations

import json
import logging

from typing import TYPE_CHECKING, Any

from memos.dream.prompts.reasoning_prompt import CONSOLIDATION_REASONING_PROMPT
from memos.dream.types import (
    DreamAction,
    DreamActionType,
    DreamResult,
    TargetMemoryType,
)


if TYPE_CHECKING:
    from memos.dream.types import DreamCluster


logger = logging.getLogger(__name__)

_LLM_DREAM_CONFIDENCE = 0.9


class ConsolidationReasoning:
    """Dream reasoning stage — LLM-powered deep dreaming.

    For each cluster the reasoning stage produces at most ONE dream:
    1. Fetches the **source memories** (that triggered the motive) from graph_db
       so the LLM can see the original experiences, not just the motive summary.
    2. Combines them with **related memories** (from semantic recall) to build
       a prompt that asks the LLM to dream deeply: reframe problems, connect
       dots across conversations, and produce one concrete insight.
    3. Parses the LLM response into a single ``DreamAction`` (CREATE /
       InsightMemory) for downstream persistence; if the LLM judges the
       material too thin, no action is produced.

    Falls back to a placeholder CREATE action when the LLM is unavailable
    or returns an unparseable response.
    """

    def __init__(self) -> None:
        self.context: dict[str, Any] = {}

    def bind_context(self, context: dict) -> None:
        self.context = context

    def reason(self, *, clusters: list[DreamCluster], text_mem, cube_id: str) -> list[DreamResult]:
        llm = self.context.get("shared", {}).get("llm")

        results: list[DreamResult] = []
        for cluster in clusters:
            if llm is not None:
                action = self._llm_reason(llm, cluster, cube_id)
            else:
                action = self._fallback_action(cluster)

            actions = [action] if action is not None else []
            results.append(DreamResult(cluster_id=cluster.cluster_id, actions=actions))
        return results

    # ------------------------------------------------------------------
    # LLM reasoning
    # ------------------------------------------------------------------

    def _llm_reason(self, llm, cluster: DreamCluster, cube_id: str) -> DreamAction | None:
        source_block = self._fetch_source_memories(cluster.motive.memory_ids, cube_id)

        if cluster.recalled_items:
            chronological = sorted(
                cluster.recalled_items,
                key=lambda x: x.get("created_at", ""),
            )
            related_block = self._format_memory_block(chronological)
        else:
            related_block = "(none)"

        prompt = CONSOLIDATION_REASONING_PROMPT.format(
            motive_description=cluster.motive.description,
            source_memories_block=source_block,
            related_memories_block=related_block,
        )

        try:
            response = llm.generate([{"role": "user", "content": prompt}])
            raw = json.loads(response.strip().removeprefix("```json").removesuffix("```"))
        except Exception:
            logger.exception(
                "[Dream Reasoning] LLM call or JSON parse failed for cluster=%s; using fallback.",
                cluster.cluster_id,
            )
            return self._fallback_action(cluster)

        if not isinstance(raw, dict):
            return self._fallback_action(cluster)

        return self._parse_dream(raw, cluster)

    def _parse_dream(self, raw_dream: dict[str, Any], cluster: DreamCluster) -> DreamAction | None:
        content = raw_dream.get("dream_content", "").strip()
        question = raw_dream.get("hypothetical_question", "").strip()
        if not content:
            logger.info(
                "[Dream Reasoning] LLM produced no usable dream for cluster=%s",
                cluster.cluster_id,
            )
            return None

        return DreamAction(
            action_type=DreamActionType.CREATE,
            target_memory_type=TargetMemoryType.INSIGHT,
            source_memory_ids=list(cluster.motive.memory_ids),
            new_content=content,
            rationale=question,
            confidence=_LLM_DREAM_CONFIDENCE,
        )

    # ------------------------------------------------------------------
    # Source memory fetching
    # ------------------------------------------------------------------

    def _fetch_source_memories(self, memory_ids: list[str], cube_id: str) -> str:
        """Retrieve source memory content from graph_db.

        The recall stage intentionally excludes source memories from its
        embedding search results (to avoid trivial self-matches), so we
        fetch them here directly so the LLM can see the full picture.
        """
        if not memory_ids:
            return "(none)"

        graph_db = self.context.get("shared", {}).get("graph_db")
        if graph_db is None:
            return "(none)"

        try:
            nodes = graph_db.get_nodes(memory_ids, user_name=cube_id)
        except Exception:
            logger.warning("[Dream Reasoning] failed to fetch source memories from graph_db.")
            return "(none)"

        items: list[dict[str, Any]] = []
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
            items.append(
                {
                    "id": node.get("id", "unknown"),
                    "memory": node.get("memory", "") or node.get("content", ""),
                    "created_at": metadata.get("created_at", "") if metadata else "",
                }
            )

        items.sort(key=lambda x: x.get("created_at", ""))
        return self._format_memory_block(items) if items else "(none)"

    # ------------------------------------------------------------------
    # Formatting
    # ------------------------------------------------------------------

    @staticmethod
    def _format_memory_block(items: list[dict[str, Any]]) -> str:
        lines: list[str] = []
        for item in items:
            mid = item.get("id", "unknown")
            content = item.get("memory", "") or item.get("content", "")
            score = item.get("score")
            suffix = f" (relevance: {score:.3f})" if score is not None else ""
            lines.append(f"- [{mid}]{suffix} {content[:1200]}")
        return "\n".join(lines) if lines else "(none)"

    # ------------------------------------------------------------------
    # Fallback
    # ------------------------------------------------------------------

    @staticmethod
    def _fallback_action(cluster: DreamCluster) -> DreamAction | None:
        if not cluster.motive.memory_ids:
            return None
        return DreamAction(
            action_type=DreamActionType.CREATE,
            target_memory_type=TargetMemoryType.INSIGHT,
            source_memory_ids=list(cluster.motive.memory_ids),
            new_content="",
            rationale="Fallback: LLM unavailable, placeholder for manual review.",
            confidence=0.0,
        )
