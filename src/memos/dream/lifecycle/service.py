"""Transactional observation and reversible lifecycle operations for Dream memories."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from memos.dream.lifecycle.contracts import (
    LIFECYCLE_METADATA_KEY,
    LifecycleConfig,
    LifecycleError,
    LifecycleEvent,
    LifecycleMetadataError,
    LifecycleState,
    checked_state,
    utc_time,
)
from memos.dream.lifecycle.policy import (
    apply_event,
    decide_maintenance,
    initialize_state,
    restore_state,
)
from memos.graph_dbs.base import BaseGraphDB, NodeMetadataUpdate


if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime


@dataclass(frozen=True)
class ObservationReport:
    """Counts describe committed observations, never attempted or queued delivery."""

    accepted: int = 0
    duplicates: int = 0
    skipped: int = 0
    missing: int = 0


@dataclass(frozen=True)
class MemoryLifecycleOutcome:
    """Small maintenance result, excluding content and bounded deduplication receipts."""

    memory_id: str
    action: str
    reason: str
    changed: bool = False
    strength: float | None = None
    usefulness: float | None = None
    eligible: bool = False
    evidence_revision: int | None = None


@dataclass(frozen=True)
class MemoryLifecycleInspection:
    """Read-only retention explanation; excludes content and deduplication hashes."""

    memory_id: str
    cube_id: str
    found: bool = True
    eligible: bool = False
    managed: bool = False
    quarantined: bool = False
    graph_status: str | None = None
    next_action: str = "skip"
    reason: str = "not_dream"
    policy_fingerprint: str | None = None
    revision: int | None = None
    created_at: datetime | None = None
    last_hit_at: datetime | None = None
    hit_count: int | None = None
    outcome_count: int | None = None
    pinned: bool | None = None
    invalidated_by_feedback: bool | None = None
    strength: float | None = None
    usefulness: float | None = None
    receipt_count: int | None = None
    receipt_capacity: int | None = None


class DreamLifecycleService:
    """Own lifecycle mutations through one backend's atomic metadata capability.

    Policy parameters are immutable for an existing envelope. Changing them
    requires a separately reviewed migration, rather than silently reinterpreting
    evidence on the next read. Each public batch is scoped and atomic; distinct
    calls/cubes and external notification delivery are not a distributed transaction.
    """

    def __init__(self, graph: BaseGraphDB, config: LifecycleConfig) -> None:
        if not graph.supports_atomic_lifecycle:
            raise LifecycleError("Dream lifecycle requires an atomic metadata backend")
        self.graph = graph
        self.config = LifecycleConfig.model_validate(config.model_dump())

    @staticmethod
    def is_dream(metadata: dict[str, Any]) -> bool:
        """Recognize native Dream writes/Contexts without treating all system data as Dream."""
        internal = metadata.get("internal_info")
        return (
            LIFECYCLE_METADATA_KEY in metadata
            or metadata.get("source") == "dream"
            or (isinstance(internal, dict) and isinstance(internal.get("dream"), dict))
        )

    def metadata_for_new(
        self, memory_id: str, cube_id: str, metadata: dict[str, Any], *, now: datetime
    ) -> dict[str, Any]:
        """Attach fresh evidence before a new Dream node is committed.

        Generated confidence remains provenance, not a probability of correctness
        or the initial retention strength. Caller-supplied reserved state is replaced
        for this new identifier; existing identifiers use atomic initialization.
        """
        now = utc_time(now)
        state = initialize_state(
            memory_id=memory_id,
            cube_id=cube_id,
            created_at=metadata.get("created_at", now),
            config=self.config,
            source_dream_id=str(metadata.get("source_dream_id", "")),
        )
        if (state.created_at - now).total_seconds() > self.config.future_tolerance_seconds:
            raise LifecycleError("Memory creation is in the future")
        return {**metadata, LIFECYCLE_METADATA_KEY: state.model_dump(mode="json")}

    def _state(
        self, memory_id: str, cube_id: str, metadata: dict[str, Any], now: datetime
    ) -> LifecycleState | None:
        if not self.is_dream(metadata):
            return None
        try:
            if LIFECYCLE_METADATA_KEY in metadata:
                state = checked_state(
                    LifecycleState.model_validate(metadata[LIFECYCLE_METADATA_KEY]), self.config
                )
            else:
                if "created_at" not in metadata:
                    raise LifecycleError("Dream memory lacks a creation timestamp")
                state = initialize_state(
                    memory_id=memory_id,
                    cube_id=cube_id,
                    created_at=metadata["created_at"],
                    config=self.config,
                    source_dream_id=str(metadata.get("source_dream_id", "")),
                )
            if (state.memory_id, state.cube_id) != (memory_id, cube_id):
                raise LifecycleError("Stored lifecycle scope mismatch")
            if (state.created_at - now).total_seconds() > self.config.future_tolerance_seconds:
                raise LifecycleError("Stored creation timestamp is in the future")
            for timestamp in (
                state.last_hit_at,
                state.mass_anchor_at,
                state.archived_at,
                state.restored_at,
            ):
                if timestamp is not None:
                    if (timestamp - now).total_seconds() > self.config.future_tolerance_seconds:
                        raise LifecycleError("Stored lifecycle evidence is in the future")
                    if (
                        state.created_at - timestamp
                    ).total_seconds() > self.config.future_tolerance_seconds:
                        raise LifecycleError("Stored lifecycle evidence predates creation")
            if state.protect_archived_status and metadata.get("status") != "archived":
                raise LifecycleError("Protected lifecycle and graph status disagree")
            return state
        except (LifecycleError, ValueError, TypeError, AttributeError) as exc:
            raise LifecycleMetadataError(
                "Malformed Dream lifecycle metadata; no mutation applied"
            ) from exc

    @staticmethod
    def _fields(state: LifecycleState) -> dict[str, Any]:
        fields = {LIFECYCLE_METADATA_KEY: state.model_dump(mode="json")}
        if state.protect_archived_status:
            fields.update(
                status="archived",
                archived_at=state.archived_at.isoformat() if state.archived_at else None,
                archive_reason=state.archive_reason,
            )
        return fields

    def observe(self, events: list[LifecycleEvent], *, now: datetime) -> ObservationReport:
        """Commit an explicit same-cube batch; duplicate identity never adds evidence.

        Stable event IDs and original producer timestamps must survive retries.
        Old events and live-receipt capacity exhaustion fail conservatively. An
        invalid row rolls back the entire batch, so a caller can safely retry.
        """
        now = utc_time(now)
        if len(events) > 1000:
            raise LifecycleError("Observation batches are bounded at 1000 events")
        if not events:
            return ObservationReport()
        events = [LifecycleEvent.model_validate(event.model_dump()) for event in events]
        cube_id = events[0].cube_id
        if any(event.cube_id != cube_id for event in events):
            raise LifecycleError("Observation batches must have one cube scope")
        grouped = defaultdict(list)
        for event in events:
            grouped[event.memory_id].append(event)

        def reduce(memory_id, metadata):
            state = self._state(memory_id, cube_id, metadata, now)
            if state is None:
                return NodeMetadataUpdate(None, (0, 0, len(grouped[memory_id])))
            accepted = duplicates = 0
            original = state
            for event in grouped[memory_id]:
                updated = apply_event(state, event, self.config, now=now)
                if updated == state:
                    duplicates += 1
                else:
                    accepted += 1
                state = updated
            return NodeMetadataUpdate(
                self._fields(state) if state != original else None, (accepted, duplicates, 0)
            )

        rows = self.graph.mutate_nodes_metadata(list(grouped), reduce, user_name=cube_id)
        accepted = duplicates = skipped = missing = 0
        for row in rows:
            if not row.found:
                missing += len(grouped[row.memory_id])
            else:
                added, repeated, ignored = row.result
                accepted += added
                duplicates += repeated
                skipped += ignored
        return ObservationReport(accepted, duplicates, skipped, missing)

    def inspect(
        self, ids: list[str], *, cube_id: str, now: datetime
    ) -> list[MemoryLifecycleInspection]:
        """Explain retention/quarantine without initializing metadata or pruning receipts.

        Each snapshot uses the same scoped current-read capability as a transition.
        Malformed stored state becomes a quarantine explanation, allowing operators
        to locate affected identifiers without treating corruption as low usefulness.
        Inspection does not authorize a recovery or silently reinterpret a policy.
        """
        now = utc_time(now)

        def reduce(memory_id, metadata):
            common = {
                "memory_id": memory_id,
                "cube_id": cube_id,
                "eligible": self.is_dream(metadata),
                "managed": LIFECYCLE_METADATA_KEY in metadata,
                "graph_status": metadata.get("status"),
            }
            try:
                state = self._state(memory_id, cube_id, metadata, now)
                if state is None:
                    return NodeMetadataUpdate(None, MemoryLifecycleInspection(**common))
                decision = decide_maintenance(
                    state, self.config, now=now, graph_status=metadata.get("status", "")
                )
            except LifecycleError:
                return NodeMetadataUpdate(
                    None,
                    MemoryLifecycleInspection(
                        **common, quarantined=True, reason="invalid_lifecycle"
                    ),
                )
            report = MemoryLifecycleInspection(
                **common,
                next_action=decision.action,
                reason=decision.reason,
                policy_fingerprint=state.policy_fingerprint,
                revision=state.revision,
                created_at=state.created_at,
                last_hit_at=state.last_hit_at,
                hit_count=state.hit_count,
                outcome_count=state.outcome_count,
                pinned=state.pinned,
                invalidated_by_feedback=state.invalidated_by_feedback,
                strength=decision.strength,
                usefulness=decision.usefulness,
                receipt_count=len(state.receipts),
                receipt_capacity=self.config.receipt_capacity,
            )
            return NodeMetadataUpdate(None, report)

        rows = self.graph.mutate_nodes_metadata(ids, reduce, user_name=cube_id)
        return [
            row.result
            if row.found
            else MemoryLifecycleInspection(
                memory_id=row.memory_id, cube_id=cube_id, found=False, reason="not_found"
            )
            for row in rows
        ]

    def maintain(
        self, ids: list[str], *, cube_id: str, now: datetime, dry_run: bool = False
    ) -> list[MemoryLifecycleOutcome]:
        """Revalidate current evidence under locks before any maintenance transition."""
        now = utc_time(now)

        def reduce(memory_id, metadata):
            state = self._state(memory_id, cube_id, metadata, now)
            if state is None:
                return NodeMetadataUpdate(
                    None, MemoryLifecycleOutcome(memory_id, "skip", "not_dream")
                )
            decision = decide_maintenance(
                state, self.config, now=now, graph_status=metadata.get("status", "")
            )
            fields = None
            if decision.action == "archive" and not state.protect_archived_status:
                archived = LifecycleState.model_validate(
                    {
                        **state.model_dump(),
                        "status": "archived",
                        "protect_archived_status": True,
                        "archived_at": now,
                        "archive_reason": decision.reason,
                        "revision": state.revision + 1,
                    }
                )
                fields = self._fields(archived)
            # A retained legacy node can acquire its initial envelope, but a dry
            # run never initializes state or prunes/deduplicates receipts.
            elif decision.action == "keep" and LIFECYCLE_METADATA_KEY not in metadata:
                fields = self._fields(state)
            outcome = MemoryLifecycleOutcome(
                memory_id,
                decision.action,
                decision.reason,
                bool(fields) and not dry_run,
                decision.strength,
                decision.usefulness,
                eligible=True,
                evidence_revision=state.revision,
            )
            return NodeMetadataUpdate(None if dry_run else fields, outcome)

        rows = self.graph.mutate_nodes_metadata(ids, reduce, user_name=cube_id)
        return [
            row.result
            if row.found
            else MemoryLifecycleOutcome(row.memory_id, "missing", "not_found")
            for row in rows
        ]

    def _transition(
        self,
        memory_id: str,
        cube_id: str,
        now: datetime,
        transition: Callable[
            [LifecycleState, dict[str, Any]], tuple[LifecycleState, dict[str, Any], str]
        ],
    ) -> MemoryLifecycleOutcome:
        now = utc_time(now)

        def reduce(item, metadata):
            state = self._state(item, cube_id, metadata, now)
            if state is None:
                return NodeMetadataUpdate(None, MemoryLifecycleOutcome(item, "skip", "not_dream"))
            updated, extra, action = transition(state, metadata)
            fields = {**self._fields(updated), **extra}
            return NodeMetadataUpdate(
                fields, MemoryLifecycleOutcome(item, action, action, updated != state)
            )

        row = self.graph.mutate_nodes_metadata([memory_id], reduce, user_name=cube_id)[0]
        return (
            row.result if row.found else MemoryLifecycleOutcome(memory_id, "missing", "not_found")
        )

    def archive(
        self, memory_id: str, *, cube_id: str, reason: str, now: datetime
    ) -> MemoryLifecycleOutcome:
        """Explicitly archive a Dream memory without pretending this is causal attribution."""
        now = utc_time(now)
        if not reason.strip():
            raise LifecycleError("Explicit archive requires a reason")

        def transition(state, metadata):
            if metadata.get("status") not in ("activated", "archived"):
                raise LifecycleError("Cannot archive a memory with an unrelated external status")
            if state.protect_archived_status:
                return state, {}, "archive"
            updated = LifecycleState.model_validate(
                {
                    **state.model_dump(),
                    "status": "archived",
                    "protect_archived_status": True,
                    "archived_at": now,
                    "archive_reason": reason,
                    "revision": state.revision + 1,
                }
            )
            return updated, {}, "archive"

        return self._transition(memory_id, cube_id, now, transition)

    def restore(
        self,
        memory_id: str,
        *,
        cube_id: str,
        reason: str,
        now: datetime,
        override_invalidation: bool = False,
    ) -> MemoryLifecycleOutcome:
        """Restore only lifecycle-owned archives with an explicit revalidation reason."""
        now = utc_time(now)

        def transition(state, metadata):
            if not state.protect_archived_status or metadata.get("status") != "archived":
                raise LifecycleError("Only lifecycle-owned archives can be restored")
            updated = restore_state(
                state,
                self.config,
                now=now,
                reason=reason,
                override_invalidation=override_invalidation,
            )
            return (
                updated,
                {"status": "activated", "restored_at": now.isoformat(), "restore_reason": reason},
                "restore",
            )

        return self._transition(memory_id, cube_id, now, transition)

    def set_pinned(
        self, memory_id: str, *, cube_id: str, pinned: bool, now: datetime
    ) -> MemoryLifecycleOutcome:
        """Exempt a memory from passive retention decisions; invalidation still wins."""
        if not isinstance(pinned, bool):
            raise LifecycleError("Pinned must be a boolean")

        def transition(state, metadata):
            updated = (
                state
                if state.pinned == pinned
                else LifecycleState.model_validate(
                    {**state.model_dump(), "pinned": pinned, "revision": state.revision + 1}
                )
            )
            return updated, {}, "pin" if pinned else "unpin"

        return self._transition(memory_id, cube_id, now, transition)
