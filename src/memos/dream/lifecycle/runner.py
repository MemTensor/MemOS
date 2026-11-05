"""Bounded, resumable maintenance with scoped metadata-only keyset scans."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time

from contextlib import contextmanager, suppress
from datetime import datetime  # noqa: TC003 - Pydantic resolves report timestamps at runtime.
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from memos.dream.lifecycle.contracts import LifecycleError, utc_time


if TYPE_CHECKING:
    from collections.abc import Callable

    from memos.dream.lifecycle.service import DreamLifecycleService


class MaintenanceLimits(BaseModel):
    """Cooperative limits checked between bounded atomic pages, not SQL timeouts."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    page_size: int = Field(default=100, ge=1, le=1000, strict=True)
    max_nodes: int = Field(default=10000, ge=1, le=10000000, strict=True)
    max_seconds: float = Field(default=60, gt=0, strict=True)


class MaintenanceCursor(BaseModel):
    """A cursor is bound to the backend, cube and immutable retention policy."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    version: Literal[1] = 1
    binding: str = Field(pattern=r"^[0-9a-f]{64}$")
    cube_id: str = Field(min_length=1, strict=True)
    policy_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    sweep_id: str = Field(min_length=1, strict=True)
    after: str | None = Field(default=None, min_length=1, strict=True)
    complete: bool = Field(default=False, strict=True)


class MaintenanceReport(BaseModel):
    """Bounded operational summary; content, labels and receipt payloads are omitted."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    cube_id: str
    sweep_id: str
    at: datetime
    dry_run: bool
    scanned: int = 0
    archived: int = 0
    would_archive: int = 0
    retained: int = 0
    skipped: int = 0
    missing: int = 0
    failed: int = 0
    complete: bool = False
    next_after: str | None = None
    stop_reason: str = "complete"
    error_type: str | None = None
    elapsed_seconds: float = 0


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise LifecycleError("Duplicate checkpoint field")
        result[key] = value
    return result


class DreamMaintenanceRunner:
    """Scan one cube with a single owner and publish cursors after committed pages.

    A page reduction is atomic. Failures retain the previous page cursor; a crash
    after commit but before checkpoint publication can replay a page, and lifecycle
    transitions remain idempotent. This is not exactly-once external delivery.
    Completed cursors begin a new sweep on the next call so quiet cubes still age.
    """

    def __init__(
        self,
        service: DreamLifecycleService,
        *,
        checkpoint: str | Path | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.service = service
        self.checkpoint = Path(checkpoint) if checkpoint is not None else None
        self.monotonic = monotonic
        self._owner = threading.Lock()

    def _binding(self, cube_id: str) -> str:
        graph = self.service.graph
        config = getattr(graph, "config", None)
        location = {
            field: getattr(config, field, None)
            for field in (
                "host",
                "port",
                "db_name",
                "schema_name",
                "user",
                "user_name",
            )
        }
        payload = {
            "backend": f"{type(graph).__module__}.{type(graph).__qualname__}",
            "location": location,
            "cube_id": cube_id,
            "policy": self.service.config.fingerprint(),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    def _load_cursor(self, cube_id: str) -> MaintenanceCursor:
        binding = self._binding(cube_id)
        if self.checkpoint is not None and self.checkpoint.exists():
            try:
                with self.checkpoint.open("rb") as stream:
                    raw = stream.read(65537)
                if len(raw) > 65536:
                    raise LifecycleError("Maintenance checkpoint exceeds size limit")
                data = json.loads(
                    raw,
                    object_pairs_hook=_unique_object,
                    parse_constant=lambda _value: (_ for _ in ()).throw(
                        ValueError("Nonfinite JSON")
                    ),
                )
                cursor = MaintenanceCursor.model_validate(data)
            except (ValueError, OSError) as exc:
                raise LifecycleError("Invalid maintenance checkpoint") from exc
            if (
                cursor.binding != binding
                or cursor.cube_id != cube_id
                or cursor.policy_fingerprint != self.service.config.fingerprint()
            ):
                raise LifecycleError("Maintenance checkpoint scope/binding mismatch")
            if not cursor.complete:
                return cursor
        return MaintenanceCursor(
            binding=binding,
            cube_id=cube_id,
            policy_fingerprint=self.service.config.fingerprint(),
            sweep_id=uuid4().hex,
        )

    def _save_cursor(self, cursor: MaintenanceCursor) -> None:
        if self.checkpoint is None:
            return
        path = self.checkpoint
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            descriptor, temporary = tempfile.mkstemp(
                prefix=path.name + ".", suffix=".tmp", dir=path.parent
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(cursor.model_dump_json(indent=2))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            if os.name != "nt":
                descriptor = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            if temporary is not None:
                with suppress(OSError):
                    os.unlink(temporary)

    @contextmanager
    def _ownership(self, *, dry_run: bool):
        if not self._owner.acquire(blocking=False):
            raise LifecycleError("This maintenance runner already has an active owner")
        lock = None
        try:
            if self.checkpoint is not None and not dry_run:
                self.checkpoint.parent.mkdir(parents=True, exist_ok=True)
                lock = self.checkpoint.with_name(self.checkpoint.name + ".lock").open("a+b")
                try:
                    if os.name == "nt":
                        import msvcrt

                        if lock.tell() == 0:
                            lock.write(b"0")
                            lock.flush()
                        lock.seek(0)
                        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    raise LifecycleError(
                        "Maintenance checkpoint already has an active owner"
                    ) from exc
            yield
        finally:
            # Closing releases the OS lock after errors or process termination;
            # an empty lock file is not itself evidence of a live owner.
            if lock is not None:
                lock.close()
            self._owner.release()

    def run(
        self,
        *,
        cube_id: str,
        now: datetime,
        limits: MaintenanceLimits | None = None,
        dry_run: bool = False,
        cancelled: Callable[[], bool] | None = None,
    ) -> MaintenanceReport:
        """Run bounded pages; callers decide scheduling and explicitly register quiet cubes.

        New IDs inserted behind a cursor are eligible on a later full sweep.
        Wall time is cooperative between database pages; arbitrary backend calls
        cannot be forcibly cancelled or advertised as hard deadline enforcement.
        """
        if not isinstance(cube_id, str) or not cube_id.strip():
            raise LifecycleError("Maintenance requires an explicit cube scope")
        now = utc_time(now)
        limits = MaintenanceLimits.model_validate((limits or MaintenanceLimits()).model_dump())
        with self._ownership(dry_run=dry_run):
            cursor = self._load_cursor(cube_id)
            started = self.monotonic()
            values = {
                "cube_id": cube_id,
                "sweep_id": cursor.sweep_id,
                "at": now,
                "dry_run": dry_run,
                "scanned": 0,
                "archived": 0,
                "would_archive": 0,
                "retained": 0,
                "skipped": 0,
                "missing": 0,
                "failed": 0,
                "next_after": cursor.after,
            }
            stop_reason = "complete"
            complete = False
            error_type = None
            while True:
                if cancelled is not None and cancelled():
                    stop_reason = "cancelled"
                    break
                if self.monotonic() - started >= limits.max_seconds:
                    stop_reason = "time_budget"
                    break
                remaining = limits.max_nodes - values["scanned"]
                if remaining <= 0:
                    stop_reason = "node_budget"
                    break
                page = self.service.graph.list_lifecycle_nodes(
                    user_name=cube_id, after=cursor.after, limit=min(limits.page_size, remaining)
                )
                if not page:
                    proposed = cursor.model_copy(update={"complete": True})
                    complete = True
                else:
                    ids = [row["id"] for row in page]
                    if (
                        len(ids) != len(set(ids))
                        or any(item <= (cursor.after or "") for item in ids)
                        or ids != sorted(ids)
                    ):
                        raise LifecycleError("Backend violated lifecycle keyset ordering")
                    try:
                        outcomes = self.service.maintain(
                            ids, cube_id=cube_id, now=now, dry_run=dry_run
                        )
                    except Exception as exc:
                        values["failed"] += 1
                        error_type = type(exc).__name__
                        stop_reason = "page_failed"
                        break
                    values["scanned"] += len(ids)
                    for outcome in outcomes:
                        if outcome.action == "archive":
                            if dry_run:
                                values["would_archive"] += 1
                            elif outcome.changed:
                                values["archived"] += 1
                            else:
                                values["skipped"] += 1
                        elif outcome.action == "keep":
                            values["retained"] += 1
                        elif outcome.action == "missing":
                            values["missing"] += 1
                        else:
                            values["skipped"] += 1
                    proposed = cursor.model_copy(update={"after": ids[-1]})
                if not dry_run:
                    try:
                        self._save_cursor(proposed)
                    except OSError as exc:
                        complete = False
                        stop_reason = "checkpoint_failed"
                        error_type = type(exc).__name__
                        break
                cursor = proposed
                values["next_after"] = cursor.after
                if complete:
                    break
            elapsed = max(0.0, self.monotonic() - started)
            return MaintenanceReport(
                **values,
                complete=complete,
                stop_reason=stop_reason,
                error_type=error_type,
                elapsed_seconds=elapsed,
            )
