from __future__ import annotations

import logging

from typing import TYPE_CHECKING

from memos.dream.types import DreamDiaryEntry


if TYPE_CHECKING:
    from memos.dream.types import DreamAction, DreamCluster, DreamResult


logger = logging.getLogger(__name__)

_TITLE_MAX_LEN = 30
_TITLE_SENTENCE_TERMINATORS = ("。", "！", "？", ".", "!", "?", "\n")


class StructuredDiarySummary:
    """Dream diary generation stage.

    Builds the human-readable diary entry directly from the reasoning
    output, without an additional LLM call. The reasoning stage already
    produces the most carefully crafted artifact of the pipeline — the
    first-person dream itself; the diary's job is to package that content
    with motive context and lightweight metadata so it can be retrieved
    later as a coherent nightly reflection.

    The diary is a **user-facing explainability artifact**, not functional
    memory. It is excluded from AI recall paths (InsightMemory handles
    that). Think of it as the "dream journal" the user can browse.

    Per-cluster output:
      - ``title``       — short label derived from the motive description.
      - ``summary``     — the motive description (one or two sentences).
      - ``dream_entry`` — the dream content produced by reasoning, if any.
      - ``motive``      — type, why_now, and source/related memory counts.
      - ``themes``      — empty by default; community plugins can replace
                          this strategy to add keyword/topic extraction.
      - ``status``      — ``"completed"`` when a real dream was produced,
                          ``"skipped"`` when reasoning judged the material
                          too thin or only emitted a placeholder.

    Community Extension Ideas
    -------------------------
    Contributors looking to enhance the diary stage may consider (but are
    not limited to) the following directions:

    1. **Style separation** — The reasoning stage produces dense, precise
       InsightMemory for AI recall. The diary could add an LLM rewrite
       pass that converts the insight into a lighter, more conversational
       tone for human consumption (e.g. "your AI's nightly journal").
       On failure, fall back to the raw insight text (current behavior).

    2. **Proactive surfacing** — Instead of passively waiting for the user
       to query the diary API, the assistant can proactively bring up dream
       content at the start of the next conversation ("I had a dream last
       night..."). This turns the diary into an active dialogue trigger
       rather than a static artifact. Implementation considerations:

       - Add a ``surfaced`` status field to ``DreamDiaryEntry`` tracking
         whether the diary has been presented to the user.
       - Hook into the chat entry point: on new session, check for unsurfaced
         diary entries and inject dream context into the conversation opener.
       - Design a frequency/relevance policy so the assistant does not
         overwhelm the user (e.g. surface at most one dream per session,
         prefer higher-confidence dreams, respect user opt-out signals).
    """

    def bind_context(self, context: dict) -> None:
        self.context = context

    def generate(
        self,
        *,
        clusters: list[DreamCluster],
        results: list[DreamResult],
        mem_cube_id: str,
    ) -> list[DreamResult]:
        cluster_map = {c.cluster_id: c for c in clusters}
        for result in results:
            cluster = cluster_map.get(result.cluster_id)
            result.diary_entry = self._build_entry(cluster, result)
        return results

    def _build_entry(self, cluster: DreamCluster | None, result: DreamResult) -> DreamDiaryEntry:
        motive = cluster.motive if cluster else None
        motive_description = motive.description if motive else ""
        source_count = len(motive.memory_ids) if motive else 0
        related_count = len(cluster.recalled_items) if cluster else 0

        dream_action = self._first_real_dream(result.actions)
        if dream_action is not None:
            dream_entry = dream_action.new_content
            status = "completed"
        else:
            dream_entry = ""
            status = "skipped"

        return DreamDiaryEntry(
            title=self._make_title(motive_description),
            summary=motive_description or "(no motive description)",
            dream_entry=dream_entry,
            motive={
                "type": motive.motive_type.value if motive else "newness",
                "why_now": motive_description,
                "source_memory_count": source_count,
                "related_memory_count": related_count,
            },
            themes=[],
            status=status,
        )

    @staticmethod
    def _first_real_dream(actions: list[DreamAction]) -> DreamAction | None:
        """Return the first action that carries genuine dream content.

        Fallback actions (empty content, zero confidence) are skipped so
        that the diary correctly reflects them as ``skipped``.
        """
        for action in actions:
            if action.new_content and action.new_content.strip() and action.confidence > 0:
                return action
        return None

    @staticmethod
    def _make_title(motive_description: str) -> str:
        """Derive a short title from the motive description.

        Prefer the first sentence; if it exceeds ``_TITLE_MAX_LEN``,
        truncate with an ellipsis. Language-neutral — works for both
        Chinese and English motives.
        """
        text = motive_description.strip()
        if not text:
            return "Dream"

        first_break = len(text)
        for sep in _TITLE_SENTENCE_TERMINATORS:
            idx = text.find(sep)
            if 0 <= idx < first_break:
                first_break = idx + 1

        first_sentence = text[:first_break].rstrip()
        if len(first_sentence) <= _TITLE_MAX_LEN:
            return first_sentence
        return first_sentence[:_TITLE_MAX_LEN].rstrip() + "…"
