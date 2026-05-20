from __future__ import annotations

import json
import logging
import os

from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from memos.dream.enrichment import DREAM_INTERNAL_INFO_KEY
from memos.dream.prompts import CONTEXT_BINDING_PROMPT, CONTEXT_SUMMARY_PROMPT


logger = logging.getLogger(__name__)

CONTEXT_MEMORY_TYPE = "Context"
_CONTEXT_ID_PREFIX = "ctx_"
_DREAM_OUTPUT_MEMORY_TYPES = {CONTEXT_MEMORY_TYPE, "InsightMemory", "DreamDiary"}
_DEFAULT_BINDING_MIN_GROUP_SIZE = 2
_DEFAULT_BINDING_MAX_GROUP_SIZE = 30
_DEFAULT_BINDING_CONFIDENCE_THRESHOLD = 0.65


def _env_enabled(name: str, default: str = "on") -> bool:
    return os.getenv(name, default).strip().lower() not in {"0", "false", "no", "off"}


def _env_int(name: str, default: int) -> int:
    with suppress(TypeError, ValueError):
        return int(os.getenv(name, str(default)))
    return default


def _env_float(name: str, default: float) -> float:
    with suppress(TypeError, ValueError):
        return float(os.getenv(name, str(default)))
    return default


@dataclass
class DreamContextSource:
    id: str
    memory: str
    metadata: dict[str, Any]
    dream: dict[str, Any]
    created_at: str | None = None


@dataclass
class DreamContextGroup:
    group_key: str
    memories: list[DreamContextSource]
    strategy: str = "heuristic"
    confidence: float = 0.7
    proposed_key: str | None = None
    should_persist: bool = True

    @property
    def memory_ids(self) -> list[str]:
        return [memory.id for memory in self.memories]


@dataclass
class DreamBindingUnit:
    short_id: str
    memories: list[DreamContextSource]

    @property
    def real_ids(self) -> list[str]:
        return [memory.id for memory in self.memories]


@dataclass
class DreamContextReport:
    processed_memory_count: int = 0
    created_context_count: int = 0
    updated_context_count: int = 0
    bound_memory_count: int = 0
    skipped_memory_count: int = 0
    contexts: list[dict[str, Any]] = field(default_factory=list)

    def model_dump(self) -> dict[str, Any]:
        return {
            "processed_memory_count": self.processed_memory_count,
            "created_context_count": self.created_context_count,
            "updated_context_count": self.updated_context_count,
            "bound_memory_count": self.bound_memory_count,
            "skipped_memory_count": self.skipped_memory_count,
            "contexts": self.contexts,
        }


class DreamContextualizer:
    """Create or update `Context` memory nodes from Dream pending memories.

    The v1 implementation is deliberately conservative:
    - weak context IDs build the initial candidate pools;
    - LLM binding can split broad pools into tighter context groups;
    - existing LLM-bound contexts are matched by source memory overlap.
    """

    def __init__(
        self,
        *,
        enabled: bool | None = None,
        summary_llm_enabled: bool | None = None,
        binding_llm_enabled: bool | None = None,
        binding_min_group_size: int | None = None,
        binding_max_group_size: int | None = None,
        binding_confidence_threshold: float | None = None,
    ):
        self.enabled = (
            _env_enabled("MEMOS_DREAM_CONTEXT_ENABLED", "on") if enabled is None else enabled
        )
        self.summary_llm_enabled = (
            _env_enabled("MEMOS_DREAM_CONTEXT_SUMMARY_LLM", "on")
            if summary_llm_enabled is None
            else summary_llm_enabled
        )
        self.binding_llm_enabled = (
            _env_enabled("MEMOS_DREAM_CONTEXT_BINDING_LLM", "on")
            if binding_llm_enabled is None
            else binding_llm_enabled
        )
        self.binding_min_group_size = (
            _env_int("MEMOS_DREAM_CONTEXT_BINDING_MIN_GROUP_SIZE", _DEFAULT_BINDING_MIN_GROUP_SIZE)
            if binding_min_group_size is None
            else binding_min_group_size
        )
        self.binding_max_group_size = (
            _env_int("MEMOS_DREAM_CONTEXT_BINDING_MAX_GROUP_SIZE", _DEFAULT_BINDING_MAX_GROUP_SIZE)
            if binding_max_group_size is None
            else binding_max_group_size
        )
        self.binding_confidence_threshold = (
            _env_float(
                "MEMOS_DREAM_CONTEXT_BINDING_CONFIDENCE_THRESHOLD",
                _DEFAULT_BINDING_CONFIDENCE_THRESHOLD,
            )
            if binding_confidence_threshold is None
            else binding_confidence_threshold
        )
        self.context: dict[str, Any] = {}

    def bind_context(self, context: dict[str, Any]) -> None:
        self.context = context

    def run(self, *, signal_snapshot, text_mem, cube_id: str) -> DreamContextReport:
        report = DreamContextReport()
        if not self.enabled:
            return report

        memory_ids = list(dict.fromkeys(getattr(signal_snapshot, "pending_memory_ids", []) or []))
        if not memory_ids:
            return report

        graph_db = self.context.get("shared", {}).get("graph_db")
        if graph_db is None:
            logger.info("[Dream Context] graph_db unavailable; skip context stage.")
            return report

        memories = self._load_memories(graph_db=graph_db, memory_ids=memory_ids, cube_id=cube_id)
        report.processed_memory_count = len(memories)
        report.skipped_memory_count = max(0, len(memory_ids) - len(memories))
        if not memories:
            return report

        existing_contexts = self._load_existing_contexts(graph_db=graph_db, cube_id=cube_id)
        for group in self._build_groups(memories):
            if not group.should_persist:
                report.skipped_memory_count += len(group.memory_ids)
                continue
            context_node = self._match_existing_context(group, existing_contexts)
            context_event = self._persist_group(
                graph_db=graph_db,
                group=group,
                context_node=context_node,
                cube_id=cube_id,
            )
            action = context_event["action"]
            if action == "created":
                report.created_context_count += 1
            else:
                report.updated_context_count += 1
            report.bound_memory_count += len(group.memory_ids)
            report.contexts.append(context_event)
        return report

    def _load_memories(
        self, *, graph_db, memory_ids: list[str], cube_id: str
    ) -> list[DreamContextSource]:
        try:
            nodes = graph_db.get_nodes(memory_ids, include_embedding=True, user_name=cube_id)
        except Exception:
            logger.warning("[Dream Context] failed to load pending memories.", exc_info=True)
            return []

        loaded: list[DreamContextSource] = []
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
            memory_type = metadata.get("memory_type")
            if memory_type in _DREAM_OUTPUT_MEMORY_TYPES:
                continue
            if metadata.get("status") not in (None, "activated"):
                continue
            if metadata.get("source") == "dream":
                continue

            internal_info = _coerce_json_dict(metadata.get("internal_info"))
            dream = internal_info.get(DREAM_INTERNAL_INFO_KEY)
            if not isinstance(dream, dict):
                dream = {}
            loaded.append(
                DreamContextSource(
                    id=str(node.get("id", "")),
                    memory=node.get("memory", "") or node.get("content", ""),
                    metadata=metadata,
                    dream=dream,
                    created_at=metadata.get("created_at"),
                )
            )
        return [memory for memory in loaded if memory.id and memory.memory]

    def _load_existing_contexts(self, *, graph_db, cube_id: str) -> list[dict[str, Any]]:
        filters = [{"field": "memory_type", "op": "=", "value": CONTEXT_MEMORY_TYPE}]
        try:
            ids = graph_db.get_by_metadata(filters, user_name=cube_id, status="activated")
            if not ids:
                return []
            nodes = graph_db.get_nodes(ids, include_embedding=True, user_name=cube_id)
        except Exception:
            logger.info(
                "[Dream Context] existing Context lookup unavailable; will create new contexts."
            )
            return []
        return [node for node in nodes or [] if isinstance(node, dict)]

    def _build_groups(self, memories: list[DreamContextSource]) -> list[DreamContextGroup]:
        candidate_pools = self._build_candidate_pools(memories)
        groups: list[DreamContextGroup] = []
        for pool_key, pool_memories in candidate_pools:
            groups.extend(self._bind_candidate_pool(pool_key=pool_key, memories=pool_memories))
        return groups

    def _build_candidate_pools(
        self, memories: list[DreamContextSource]
    ) -> list[tuple[str, list[DreamContextSource]]]:
        grouped: dict[str, list[DreamContextSource]] = {}
        unbound: list[DreamContextSource] = []
        for memory in memories:
            weak_context_id = memory.dream.get("weak_context_id")
            if weak_context_id:
                grouped.setdefault(str(weak_context_id), []).append(memory)
            else:
                unbound.append(memory)

        pools = list(grouped.items())
        if unbound:
            pools.append(("unbound", unbound))
        return pools

    def _bind_candidate_pool(
        self, *, pool_key: str, memories: list[DreamContextSource]
    ) -> list[DreamContextGroup]:
        if len(memories) == 1:
            return [
                DreamContextGroup(
                    group_key=f"{pool_key}:singleton",
                    memories=memories,
                    strategy="singleton_skipped",
                    confidence=0.0,
                    should_persist=False,
                )
            ]

        llm = self.context.get("shared", {}).get("llm")
        if (
            not self.binding_llm_enabled
            or llm is None
            or len(memories) < self.binding_min_group_size
            or len(memories) > self.binding_max_group_size
        ):
            return [self._fallback_group(pool_key=pool_key, memories=memories)]

        try:
            return self._llm_bind_candidate_pool(llm=llm, pool_key=pool_key, memories=memories)
        except Exception:
            logger.warning(
                "[Dream Context] binding LLM failed; using heuristic groups.", exc_info=True
            )
            return [self._fallback_group(pool_key=pool_key, memories=memories)]

    def _llm_bind_candidate_pool(
        self, *, llm, pool_key: str, memories: list[DreamContextSource]
    ) -> list[DreamContextGroup]:
        units = _build_binding_units(memories)
        prompt = CONTEXT_BINDING_PROMPT.format(memories_block=_format_binding_units_block(units))
        response = llm.generate([{"role": "user", "content": prompt}])
        raw = _parse_json_object(response)
        groups = _parse_binding_groups(
            raw=raw,
            pool_key=pool_key,
            units=units,
            confidence_threshold=self.binding_confidence_threshold,
        )
        if groups:
            return groups
        return [self._fallback_group(pool_key=pool_key, memories=memories)]

    @staticmethod
    def _fallback_group(*, pool_key: str, memories: list[DreamContextSource]) -> DreamContextGroup:
        if _is_batch_pool(pool_key) and len(memories) > 1:
            return DreamContextGroup(
                group_key=pool_key,
                memories=memories,
                strategy="batch",
                confidence=0.85,
                should_persist=True,
            )
        return DreamContextGroup(
            group_key=pool_key,
            memories=memories,
            strategy="weak_skipped",
            confidence=0.0,
            should_persist=False,
        )

    @staticmethod
    def _match_existing_context(
        group: DreamContextGroup, existing_contexts: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        if group.strategy.startswith("llm"):
            return _match_context_by_memory_overlap(group, existing_contexts)

        group_weak_ids = _group_weak_context_ids(group)
        if not group_weak_ids:
            return None

        best_context = None
        best_overlap = 0
        for context_node in existing_contexts:
            dream = _node_dream_info(context_node)
            weak_ids = set(dream.get("weak_context_ids") or [])
            overlap = len(group_weak_ids & weak_ids)
            if overlap > best_overlap:
                best_context = context_node
                best_overlap = overlap
        return best_context

    def _persist_group(self, *, graph_db, group: DreamContextGroup, context_node, cube_id: str):
        existing_metadata = (
            context_node.get("metadata", {}) if isinstance(context_node, dict) else {}
        )
        existing_dream = _node_dream_info(context_node) if context_node else {}
        existing_memory_ids = existing_dream.get("memory_ids") or []
        memory_ids = _unique([*existing_memory_ids, *group.memory_ids])

        key, summary, summary_confidence, summary_strategy = self._summarize_group(
            group=group,
            existing_key=(
                existing_metadata.get("key", "") if existing_metadata else group.proposed_key or ""
            ),
            existing_memory=context_node.get("memory", "") if context_node else "",
        )
        now = datetime.now(timezone.utc).isoformat()
        context_id = (
            context_node.get("id") if context_node else f"{_CONTEXT_ID_PREFIX}{uuid4().hex}"
        )
        created_at = existing_metadata.get("created_at") or now
        confidence = max(group.confidence, summary_confidence)

        metadata = {
            "memory_type": CONTEXT_MEMORY_TYPE,
            "status": "activated",
            "key": key,
            "embedding": self._embed_key(key),
            "source": "system",
            "visibility": "private",
            "tags": ["dream", "context"],
            "confidence": confidence,
            "created_at": created_at,
            "updated_at": now,
            "sources": _source_refs(group.memories),
            "internal_info": {
                DREAM_INTERNAL_INFO_KEY: {
                    "kind": "context",
                    "memory_ids": memory_ids,
                    "weak_context_ids": sorted(_group_weak_context_ids(group)),
                    "salience": _group_salience(group.memories),
                    "time_range": _group_time_range(group.memories),
                    "binding": {
                        "strategy": group.strategy,
                        "confidence": group.confidence,
                    },
                    "summary": {
                        "strategy": summary_strategy,
                        "updated_from_memory_ids": group.memory_ids,
                    },
                }
            },
        }

        if context_node:
            graph_db.add_node(context_id, summary, metadata, user_name=cube_id)
            return _build_context_event(
                context_id=context_id,
                action="updated",
                key=key,
                summary=summary,
                metadata=metadata,
                group=group,
                summary_strategy=summary_strategy,
            )

        graph_db.add_node(context_id, summary, metadata, user_name=cube_id)
        return _build_context_event(
            context_id=context_id,
            action="created",
            key=key,
            summary=summary,
            metadata=metadata,
            group=group,
            summary_strategy=summary_strategy,
        )

    def _summarize_group(
        self, *, group: DreamContextGroup, existing_key: str = "", existing_memory: str = ""
    ) -> tuple[str, str, float, str]:
        llm = self.context.get("shared", {}).get("llm")
        if self.summary_llm_enabled and llm is not None:
            prompt = CONTEXT_SUMMARY_PROMPT.format(
                existing_key=existing_key or "(none)",
                existing_memory=existing_memory or "(none)",
                memories_block=_format_memories_block(group.memories),
            )
            try:
                response = llm.generate([{"role": "user", "content": prompt}])
                raw = _parse_json_object(response)
                key = str(raw.get("key") or "").strip()
                memory = str(raw.get("memory") or "").strip()
                confidence = float(raw.get("confidence") or 0.0)
                if key and memory:
                    return key, memory, max(0.0, min(1.0, confidence)), "llm"
            except Exception:
                logger.warning("[Dream Context] summary LLM failed; using fallback.", exc_info=True)

        key = existing_key or _fallback_key(group)
        summary = _fallback_summary(group, existing_memory=existing_memory)
        return key, summary, 0.5, "fallback"

    def _embed_key(self, key: str) -> list[float] | None:
        embedder = self.context.get("shared", {}).get("embedder")
        if embedder is None:
            embedder = getattr(self.context.get("shared", {}).get("text_mem"), "embedder", None)
        if embedder is None:
            return None
        try:
            return embedder.embed([key])[0]
        except Exception:
            logger.info("[Dream Context] key embedding unavailable; continue without embedding.")
            return None


def _node_dream_info(node: dict[str, Any] | None) -> dict[str, Any]:
    metadata = node.get("metadata", {}) if isinstance(node, dict) else {}
    internal_info = _coerce_json_dict(
        metadata.get("internal_info") if isinstance(metadata, dict) else {}
    )
    dream = internal_info.get(DREAM_INTERNAL_INFO_KEY)
    return dream if isinstance(dream, dict) else {}


def _build_context_event(
    *,
    context_id: str,
    action: str,
    key: str,
    summary: str,
    metadata: dict[str, Any],
    group: DreamContextGroup,
    summary_strategy: str,
) -> dict[str, Any]:
    dream = (metadata.get("internal_info") or {}).get(DREAM_INTERNAL_INFO_KEY) or {}
    binding = dream.get("binding") if isinstance(dream, dict) else {}
    weak_context_ids = dream.get("weak_context_ids") if isinstance(dream, dict) else []
    return {
        "context_id": context_id,
        "action": action,
        "key": key,
        "label": key,
        "summary": summary,
        "memory_ids": list(group.memory_ids),
        "source_memory_ids": list(group.memory_ids),
        "weak_context_ids": list(weak_context_ids or []),
        "binding": binding if isinstance(binding, dict) else {},
        "binding_strategy": group.strategy,
        "binding_confidence": group.confidence,
        "summary_strategy": summary_strategy,
        "confidence": metadata.get("confidence"),
    }


def _match_context_by_memory_overlap(
    group: DreamContextGroup, existing_contexts: list[dict[str, Any]]
) -> dict[str, Any] | None:
    group_ids = set(group.memory_ids)
    best_context = None
    best_overlap = 0
    for context_node in existing_contexts:
        dream = _node_dream_info(context_node)
        existing_ids = set(dream.get("memory_ids") or [])
        overlap = len(group_ids & existing_ids)
        if overlap > best_overlap:
            best_context = context_node
            best_overlap = overlap
    return best_context


def _group_weak_context_ids(group: DreamContextGroup) -> set[str]:
    return {
        str(memory.dream["weak_context_id"])
        for memory in group.memories
        if memory.dream.get("weak_context_id")
    }


def _is_batch_pool(pool_key: str) -> bool:
    return pool_key.startswith("batch:")


def _group_salience(memories: list[DreamContextSource]) -> float:
    score = len(memories) * 0.2
    for memory in memories:
        salience = memory.dream.get("salience") if isinstance(memory.dream, dict) else {}
        if not isinstance(salience, dict):
            continue
        score += 2.0 if salience.get("has_feedback") else 0.0
        score += 1.5 if salience.get("unresolved") else 0.0
        with suppress(TypeError, ValueError):
            score += float(salience.get("emotional") or 0)
    return round(min(10.0, score), 3)


def _group_time_range(memories: list[DreamContextSource]) -> dict[str, str | None]:
    times = sorted(t for t in (memory.created_at for memory in memories) if t)
    return {
        "start": times[0] if times else None,
        "end": times[-1] if times else None,
    }


def _source_refs(memories: list[DreamContextSource]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for memory in memories[:20]:
        refs.append(
            {
                "type": "memory",
                "message_id": memory.id,
                "content": memory.memory[:300],
            }
        )
    return refs


def _build_binding_units(memories: list[DreamContextSource]) -> list[DreamBindingUnit]:
    batch_groups: dict[str, list[DreamContextSource]] = {}
    free_memories: list[DreamContextSource] = []
    for memory in memories:
        weak_id = memory.dream.get("weak_context_id") if isinstance(memory.dream, dict) else None
        if isinstance(weak_id, str) and weak_id.startswith("batch:"):
            batch_groups.setdefault(weak_id, []).append(memory)
        else:
            free_memories.append(memory)

    raw_units = [*batch_groups.values(), *[[memory] for memory in free_memories]]
    return [
        DreamBindingUnit(short_id=f"m{idx}", memories=unit_memories)
        for idx, unit_memories in enumerate(raw_units, start=1)
    ]


def _format_binding_units_block(units: list[DreamBindingUnit]) -> str:
    lines: list[str] = []
    for unit in units:
        unit_label = "batch" if len(unit.memories) > 1 else "memory"
        lines.append(f"ID: {unit.short_id} ({unit_label}; real_ids={unit.real_ids})")
        for memory in unit.memories:
            metadata = memory.metadata or {}
            dream = memory.dream or {}
            key = metadata.get("key")
            created_at = memory.created_at or metadata.get("created_at")
            weak_id = dream.get("weak_context_id")
            details = []
            if key:
                details.append(f"key={key}")
            if created_at:
                details.append(f"created_at={created_at}")
            if weak_id:
                details.append(f"weak_context_id={weak_id}")
            for hint_field in ("context_hint", "goal_hint"):
                if dream.get(hint_field):
                    details.append(f"{hint_field}={dream[hint_field]}")
            if dream.get("entity_hints"):
                details.append(f"entity_hints={dream['entity_hints']}")
            prefix = f"- real_id={memory.id}"
            if details:
                prefix += f" ({'; '.join(details)})"
            lines.append(f"{prefix}: {memory.memory[:1000]}")
        lines.append("")
    return "\n".join(lines).strip()


def _parse_binding_groups(
    *,
    raw: dict[str, Any],
    pool_key: str,
    units: list[DreamBindingUnit],
    confidence_threshold: float,
) -> list[DreamContextGroup]:
    unit_by_short_id = {unit.short_id: unit for unit in units}
    assigned: set[str] = set()
    groups: list[DreamContextGroup] = []

    contexts = raw.get("contexts")
    if not isinstance(contexts, list):
        contexts = []

    for idx, context in enumerate(contexts, start=1):
        if not isinstance(context, dict):
            continue
        confidence = _safe_confidence(context.get("confidence"))
        if confidence < confidence_threshold:
            continue
        short_ids = context.get("ids")
        if not isinstance(short_ids, list):
            short_ids = context.get("memory_ids")
        if not isinstance(short_ids, list):
            continue

        selected_units: list[DreamBindingUnit] = []
        valid = True
        for raw_short_id in short_ids:
            short_id = str(raw_short_id)
            unit = unit_by_short_id.get(short_id)
            if unit is None or short_id in assigned:
                valid = False
                break
            selected_units.append(unit)
        if not valid or not selected_units:
            continue

        for unit in selected_units:
            assigned.add(unit.short_id)
        group_memories = [memory for unit in selected_units for memory in unit.memories]
        should_persist = len(selected_units) > 1 or any(
            len(unit.memories) > 1 for unit in selected_units
        )
        groups.append(
            DreamContextGroup(
                group_key=f"{pool_key}:llm:{idx}",
                memories=group_memories,
                strategy="llm",
                confidence=confidence,
                proposed_key=str(context.get("key") or "").strip() or None,
                should_persist=should_persist,
            )
        )

    for unit in units:
        if unit.short_id in assigned:
            continue
        groups.append(
            DreamContextGroup(
                group_key=f"{pool_key}:unassigned:{unit.short_id}",
                memories=unit.memories,
                strategy="llm_unassigned",
                confidence=0.0,
                should_persist=False,
            )
        )
    return groups


def _safe_confidence(value: Any) -> float:
    with suppress(TypeError, ValueError):
        return max(0.0, min(1.0, float(value)))
    return 0.0


def _format_memories_block(memories: list[DreamContextSource]) -> str:
    lines: list[str] = []
    for memory in memories:
        dream = memory.dream or {}
        hints = []
        for hint_field in ("context_hint", "goal_hint"):
            if dream.get(hint_field):
                hints.append(f"{hint_field}={dream[hint_field]}")
        if dream.get("entity_hints"):
            hints.append(f"entity_hints={dream['entity_hints']}")
        hint_text = f" ({'; '.join(hints)})" if hints else ""
        created_at = f" created_at={memory.created_at}" if memory.created_at else ""
        lines.append(f"- [{memory.id}]{created_at}{hint_text} {memory.memory[:1200]}")
    return "\n".join(lines)


def _fallback_key(group: DreamContextGroup) -> str:
    for memory in group.memories:
        context_hint = memory.dream.get("context_hint") if isinstance(memory.dream, dict) else None
        if context_hint:
            return str(context_hint)[:80]
    if group.group_key.startswith(("project:", "session:", "batch:")):
        return group.group_key
    first = group.memories[0].memory.strip().replace("\n", " ") if group.memories else "Context"
    return first[:40] or "Context"


def _fallback_summary(group: DreamContextGroup, *, existing_memory: str = "") -> str:
    parts = []
    if existing_memory:
        parts.append(existing_memory.strip())
    parts.extend(memory.memory.strip() for memory in group.memories[:8] if memory.memory.strip())
    return "\n".join(_unique(parts))[:2000]


def _unique(values: list[Any]) -> list[Any]:
    seen = set()
    result = []
    for value in values:
        marker = (
            json.dumps(value, sort_keys=True, ensure_ascii=False)
            if isinstance(value, dict)
            else value
        )
        if marker in seen:
            continue
        seen.add(marker)
        result.append(value)
    return result


def _parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    raw = json.loads(cleaned)
    if not isinstance(raw, dict):
        raise ValueError("Expected JSON object")
    return raw


def _coerce_json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}
