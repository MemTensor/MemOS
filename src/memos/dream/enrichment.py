from __future__ import annotations

import os
import re

from typing import Any


DREAM_INTERNAL_INFO_KEY = "dream"
DREAM_HEURISTIC_ENRICHER_VERSION = "0.1.0"

_DEFAULT_SESSION_ID = "default_session"
_ENV_HEURISTIC_ENRICHER = "MEMOS_DREAM_HEURISTIC_ENRICHER"
_ENV_ENRICH_OVERWRITE = "MEMOS_DREAM_ENRICH_OVERWRITE"

_QUESTION_RE = re.compile(
    r"[?？]|(?:\b(?:what|why|how|when|where|who|which|can|could|should)\b)", re.I
)
_CORRECTION_RE = re.compile(
    "|".join(
        [
            r"不对",
            r"不是",
            r"错了",
            r"说错",
            r"其实是",
            r"应该是",
            r"更正",
            r"纠正",
            r"\bactually\b",
            r"\bnot quite\b",
            r"\bthat's wrong\b",
            r"\byou(?:'re| are)? wrong\b",
            r"\bno,\s*i mean\b",
            r"\bi mean\b",
        ]
    ),
    re.I,
)


def is_dream_heuristic_enricher_enabled() -> bool:
    """Return whether the built-in rule-based Dream enricher should run."""
    return os.getenv(_ENV_HEURISTIC_ENRICHER, "on").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def should_overwrite_dream_enrichment() -> bool:
    """Return whether heuristic enrichment may overwrite existing Dream fields."""
    return os.getenv(_ENV_ENRICH_OVERWRITE, "off").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


class DreamHeuristicEnricher:
    """Rule-based enrichment for Dream context binding.

    This stage deliberately avoids LLM calls. It only writes deterministic,
    cheap signals that help a later semantic enricher or Dream binding stage
    reason about context membership.
    """

    def __init__(self, *, enabled: bool | None = None, overwrite: bool | None = None) -> None:
        self.enabled = is_dream_heuristic_enricher_enabled() if enabled is None else enabled
        self.overwrite = should_overwrite_dream_enrichment() if overwrite is None else overwrite

    def enrich_items(self, *, items, user_context=None, extract_mode: str = "fine", **_: Any):
        if not self.enabled or extract_mode != "fine" or not items:
            return items

        batch_context_id = self._batch_context_id(items)
        for item in items:
            self._enrich_item(
                item=item,
                user_context=user_context,
                batch_context_id=batch_context_id,
            )
        return items

    def _enrich_item(self, *, item, user_context, batch_context_id: str | None) -> None:
        metadata = getattr(item, "metadata", None)
        if metadata is None:
            return

        internal_info = getattr(metadata, "internal_info", None)
        if not isinstance(internal_info, dict):
            internal_info = {}

        dream_info = internal_info.get(DREAM_INTERNAL_INFO_KEY)
        if not isinstance(dream_info, dict):
            dream_info = {}

        sources = list(_iter_sources(getattr(metadata, "sources", None)))
        source_roles = _source_roles(sources)
        user_text = _joined_source_text(sources, roles={"user"})
        all_text = _joined_source_text(sources) or getattr(item, "memory", "") or ""
        chunk_index = _first_present(
            internal_info.get("chunk_index"),
            _first_source_value(sources, "chunk_index"),
        )
        chunk_total = _first_present(
            internal_info.get("chunk_total"),
            _first_source_value(sources, "chunk_total"),
        )
        ingest_batch_id = _first_present(
            internal_info.get("ingest_batch_id"),
            _first_source_value(sources, "ingest_batch_id"),
        )
        is_chunk = chunk_index is not None or (isinstance(chunk_total, int) and chunk_total > 1)

        weak_context_id = self._weak_context_id(
            metadata=metadata,
            user_context=user_context,
            batch_context_id=batch_context_id,
            ingest_batch_id=ingest_batch_id,
            is_chunk=is_chunk,
        )
        correction_text = user_text or all_text
        has_correction = bool(_CORRECTION_RE.search(correction_text))

        self._set_if_missing(dream_info, "weak_context_id", weak_context_id)
        if batch_context_id:
            self._set_if_missing(dream_info, "batch_context_id", batch_context_id)

        signals = dream_info.get("signals")
        if not isinstance(signals, dict):
            signals = {}
            dream_info["signals"] = signals
        self._set_if_missing(signals, "source_roles", source_roles)
        self._set_if_missing(signals, "is_chunk", bool(is_chunk))
        self._set_if_missing(signals, "chunk_index", chunk_index)
        self._set_if_missing(signals, "chunk_total", chunk_total)
        self._set_if_missing(
            signals,
            "has_question",
            bool(_QUESTION_RE.search(user_text or all_text)),
        )
        self._set_if_missing(signals, "has_correction", has_correction)

        salience = dream_info.get("salience")
        if not isinstance(salience, dict):
            salience = {}
            dream_info["salience"] = salience
        self._set_if_missing(salience, "has_feedback", has_correction)

        enriched_by = dream_info.get("enriched_by")
        if not isinstance(enriched_by, dict):
            enriched_by = {}
            dream_info["enriched_by"] = enriched_by
        self._set_if_missing(enriched_by, "heuristic", DREAM_HEURISTIC_ENRICHER_VERSION)

        internal_info[DREAM_INTERNAL_INFO_KEY] = dream_info
        metadata.internal_info = internal_info

    def _set_if_missing(self, target: dict[str, Any], key: str, value: Any) -> None:
        if self.overwrite or key not in target:
            target[key] = value

    @staticmethod
    def _batch_context_id(items) -> str | None:
        batch_ids: set[str] = set()
        for item in items:
            metadata = getattr(item, "metadata", None)
            internal_info = getattr(metadata, "internal_info", None)
            if isinstance(internal_info, dict) and internal_info.get("ingest_batch_id"):
                batch_ids.add(str(internal_info["ingest_batch_id"]))
        if len(batch_ids) == 1:
            return f"batch:{next(iter(batch_ids))}"
        return None

    @staticmethod
    def _weak_context_id(
        *,
        metadata,
        user_context,
        batch_context_id: str | None,
        ingest_batch_id: Any,
        is_chunk: bool,
    ) -> str | None:
        if is_chunk:
            if batch_context_id:
                return batch_context_id
            if ingest_batch_id:
                return f"batch:{ingest_batch_id}"

        project_id = _first_present(
            getattr(metadata, "project_id", None),
            getattr(user_context, "project_id", None),
        )
        if project_id:
            return f"project:{project_id}"

        session_id = _first_present(
            getattr(metadata, "session_id", None),
            getattr(user_context, "session_id", None),
        )
        if session_id and session_id != _DEFAULT_SESSION_ID:
            return f"session:{session_id}"

        return None


def on_memory_items_after_fine_extract(
    plugin, *, items, user_context, mem_reader, extract_mode, **kw
):
    enricher = getattr(plugin, "heuristic_enricher", None)
    if enricher is None:
        return items
    return enricher.enrich_items(
        items=items,
        user_context=user_context,
        mem_reader=mem_reader,
        extract_mode=extract_mode,
        **kw,
    )


def _iter_sources(sources: Any) -> list[Any]:
    if not sources:
        return []
    if isinstance(sources, list):
        return sources
    return [sources]


def _source_roles(sources: list[Any]) -> list[str]:
    roles: list[str] = []
    for source in sources:
        role = _source_value(source, "role")
        if role and role not in roles:
            roles.append(str(role))
    return roles


def _joined_source_text(sources: list[Any], roles: set[str] | None = None) -> str:
    parts: list[str] = []
    for source in sources:
        role = _source_value(source, "role")
        if roles is not None and role not in roles:
            continue
        content = _source_value(source, "content")
        if content:
            parts.append(str(content))
    return "\n".join(parts)


def _first_source_value(sources: list[Any], key: str) -> Any:
    for source in sources:
        value = _source_value(source, key)
        if value is not None:
            return value
        file_info = _source_value(source, "file_info")
        if isinstance(file_info, dict) and file_info.get(key) is not None:
            return file_info[key]
    return None


def _source_value(source: Any, key: str) -> Any:
    if isinstance(source, dict):
        return source.get(key)
    return getattr(source, key, None)


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None
