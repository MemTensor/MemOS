"""Observe final returned memories and explicitly committed feedback operations."""

from __future__ import annotations

import threading

from collections import defaultdict
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from memos.dream.lifecycle.contracts import EventKind, LifecycleError, LifecycleEvent


if TYPE_CHECKING:
    from datetime import datetime

    from memos.dream.lifecycle.service import DreamLifecycleService, ObservationReport


@dataclass(frozen=True)
class ObservationDelivery:
    """Cumulative bounded delivery counters for this process; no user content retained."""

    accepted: int = 0
    duplicates: int = 0
    skipped: int = 0
    missing: int = 0
    failed: int = 0
    last_event_id: str | None = None
    last_error_type: str | None = None


class DreamLifecycleObserver:
    """Bridge native notifications to explicit stable lifecycle event identities.

    Native notifications are best effort and represent individual server executions,
    not HTTP-request idempotency. SDK callers can invoke observe_returned/observe
    with a retained event ID and original timestamp for bounded replay safety.
    Only committed observations affect retention; delivery is not atomic with the
    search response or the preceding feedback write.
    """

    def __init__(self, service: DreamLifecycleService) -> None:
        self.service = service
        self._delivery = ObservationDelivery()
        self._lock = threading.Lock()

    def delivery_snapshot(self) -> ObservationDelivery:
        """Read counters and the last delivery error without exposing memory content."""
        with self._lock:
            return self._delivery

    def _record(self, event_id: str, report: ObservationReport) -> None:
        with self._lock:
            old = self._delivery
            self._delivery = ObservationDelivery(
                accepted=old.accepted + report.accepted,
                duplicates=old.duplicates + report.duplicates,
                skipped=old.skipped + report.skipped,
                missing=old.missing + report.missing,
                failed=old.failed,
                last_event_id=event_id,
            )

    def _commit(self, events: list[LifecycleEvent], *, event_id: str, at: datetime) -> None:
        try:
            report = self.service.observe(events, now=at)
        except Exception as exc:
            with self._lock:
                self._delivery = replace(
                    self._delivery,
                    failed=self._delivery.failed + 1,
                    last_event_id=event_id,
                    last_error_type=type(exc).__name__,
                )
            raise
        self._record(event_id, report)

    def observe_returned(
        self, *, request: Any, results: dict[str, Any], event_id: str, at: datetime
    ) -> None:
        """Count each final memory ID once per cube; intermediate/source IDs do not count."""
        if not event_id or not isinstance(results, dict):
            raise LifecycleError("Observation requires an event ID and final result dictionary")
        allowed = set(
            getattr(request, "readable_cube_ids", None) or [getattr(request, "user_id", "")]
        )
        grouped = defaultdict(set)
        buckets = results.get("text_mem", [])
        if not isinstance(buckets, list):
            raise LifecycleError("Final text memory results must be a list")
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            cube_id = bucket.get("cube_id") or bucket.get("mem_cube_id")
            if cube_id not in allowed:
                continue
            memories = bucket.get("memories", [])
            if not isinstance(memories, list):
                raise LifecycleError("Final memory bucket must contain a list")
            for memory in memories:
                if isinstance(memory, dict):
                    memory_id = memory.get("id")
                    if isinstance(memory_id, str) and memory_id:
                        grouped[cube_id].add(memory_id)
        if sum(map(len, grouped.values())) > 1000:
            raise LifecycleError("Final observation exceeds the 1000-memory delivery limit")
        for cube_id in sorted(grouped):
            events = [
                LifecycleEvent(
                    memory_id=memory_id,
                    cube_id=cube_id,
                    event_id=event_id,
                    at=at,
                    kind=EventKind.RETRIEVED,
                )
                for memory_id in sorted(grouped[cube_id])
            ]
            self._commit(events, event_id=event_id, at=at)

    def on_search_completed(
        self, *, request: Any, result: Any, event_id: str, at: datetime
    ) -> None:
        """Consume the detached snapshot produced after all search.after pipes."""
        if getattr(result, "code", None) != 200:
            return
        self.observe_returned(
            request=request, results=getattr(result, "data", None), event_id=event_id, at=at
        )

    def on_feedback_committed(
        self,
        *,
        cube_id: str,
        memory_ids: list[str],
        action: str,
        event_id: str,
        at: datetime,
    ) -> None:
        """Attribute evidence only to the exact IDs in a completed native update.

        A superseded source is invalidated. An in-place correction contributes a
        negative outcome without invalidating its newly corrected current content.
        Generic answer sentiment and all retrieved IDs are deliberately ignored.
        """
        kinds = {"superseded": EventKind.INVALIDATED, "corrected": EventKind.NEGATIVE}
        if action not in kinds:
            raise LifecycleError("Unknown committed feedback action")
        events = [
            LifecycleEvent(
                memory_id=item,
                cube_id=cube_id,
                event_id=event_id,
                at=at,
                kind=kinds[action],
                reason="Committed feedback " + action,
            )
            for item in dict.fromkeys(memory_ids)
        ]
        self._commit(events, event_id=event_id, at=at)
