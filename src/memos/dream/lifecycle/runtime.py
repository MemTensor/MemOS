"""Opt-in plugin wiring and explicitly scoped quiet-cube maintenance scheduling."""

from __future__ import annotations

import hashlib
import threading
import time

from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, field_validator

from memos.dream.lifecycle.contracts import LifecycleConfig, LifecycleError
from memos.dream.lifecycle.observation import DreamLifecycleObserver
from memos.dream.lifecycle.runner import DreamMaintenanceRunner, MaintenanceLimits
from memos.dream.lifecycle.service import DreamLifecycleService
from memos.log import get_logger


if TYPE_CHECKING:
    from memos.dream.lifecycle.runner import MaintenanceReport
    from memos.graph_dbs.base import BaseGraphDB


logger = get_logger(__name__)


class LifecycleRuntimeConfig(BaseModel):
    """Explicit lifecycle options supplied through plugin component configuration.

    Zero interval keeps maintenance manual. A worker visits only registered cubes;
    it never enumerates tenants from storage or depends on new Dream signals.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    enabled: bool = Field(default=False, strict=True)
    policy: LifecycleConfig = Field(default_factory=LifecycleConfig)
    limits: MaintenanceLimits = Field(default_factory=MaintenanceLimits)
    cube_ids: tuple[str, ...] = ()
    max_registered_cubes: int = Field(default=1000, ge=1, le=10000, strict=True)
    interval_seconds: float = Field(default=0, ge=0, strict=True)
    checkpoint_directory: str | None = None

    @field_validator("cube_ids")
    @classmethod
    def scoped_ids(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not isinstance(item, str) or not item.strip() for item in value):
            raise ValueError("Maintenance cube IDs must be nonempty strings")
        return tuple(dict.fromkeys(value))


class DreamLifecycleRuntime:
    """One service shared by persistence, observations and bounded maintenance.

    Default plugin configuration does not construct this object. The optional
    worker has cooperative stop semantics between pages/cubes. Backend calls can
    outlive a shutdown timeout; callers receive False instead of a false claim
    that an in-flight operation was stopped or rolled back.
    """

    def __init__(self, graph: BaseGraphDB, config: LifecycleRuntimeConfig) -> None:
        self.config = LifecycleRuntimeConfig.model_validate(config.model_dump())
        if not self.config.enabled:
            raise LifecycleError("Construct lifecycle runtime only when explicitly enabled")
        self.service = DreamLifecycleService(graph, self.config.policy)
        self.observer = DreamLifecycleObserver(self.service)
        self._stop = threading.Event()
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._runners: dict[str, DreamMaintenanceRunner] = {}
        self._reports: dict[str, MaintenanceReport] = {}
        self._closed = False
        self._active = 0
        self._idle = threading.Event()
        self._idle.set()
        for cube_id in self.config.cube_ids:
            self.register_cube(cube_id)

    def register_cube(self, cube_id: str) -> None:
        """Register an explicit authorized scope, including one with no recent writes."""
        if not isinstance(cube_id, str) or not cube_id.strip():
            raise LifecycleError("Maintenance requires a nonempty cube ID")
        with self._lock:
            if self._closed:
                raise LifecycleError("Lifecycle runtime is closed")
            if cube_id in self._runners:
                return
            if len(self._runners) >= self.config.max_registered_cubes:
                raise LifecycleError("Registered maintenance cube capacity exhausted")
            checkpoint = None
            if self.config.checkpoint_directory is not None:
                filename = hashlib.sha256(cube_id.encode()).hexdigest() + ".json"
                checkpoint = Path(self.config.checkpoint_directory) / filename
            self._runners[cube_id] = DreamMaintenanceRunner(self.service, checkpoint=checkpoint)

    @property
    def registered_cubes(self) -> tuple[str, ...]:
        """Expose an immutable snapshot of explicitly configured maintenance scopes."""
        with self._lock:
            return tuple(self._runners)

    @property
    def worker_alive(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def run_maintenance(
        self,
        cube_id: str,
        *,
        now: datetime | None = None,
        dry_run: bool = False,
        limits: MaintenanceLimits | None = None,
    ) -> MaintenanceReport:
        """Run a registered cube manually; an active worker cannot own it concurrently."""
        with self._lock:
            if self._closed:
                raise LifecycleError("Lifecycle runtime is closed")
            runner = self._runners.get(cube_id)
            if runner is None:
                raise LifecycleError("Register a maintenance scope before running it")
            self._active += 1
            self._idle.clear()
        try:
            report = runner.run(
                cube_id=cube_id,
                now=now or datetime.now(timezone.utc),
                limits=limits or self.config.limits,
                dry_run=dry_run,
                cancelled=self._stop.is_set,
            )
            with self._lock:
                self._reports[cube_id] = report
            return report
        finally:
            with self._lock:
                self._active -= 1
                if self._active == 0:
                    self._idle.set()

    def latest_reports(self) -> dict[str, MaintenanceReport]:
        """Return detached report models with bounded cardinality and no memory content."""
        with self._lock:
            return {cube: report.model_copy(deep=True) for cube, report in self._reports.items()}

    def start(self) -> None:
        """Start at most one worker; a zero interval is deliberately manual-only."""
        with self._lock:
            if self._closed:
                raise LifecycleError("Cannot start a closed lifecycle runtime")
            if self.config.interval_seconds == 0 or self.worker_alive:
                return
            self._thread = threading.Thread(
                target=self._work, name="memos-dream-maintenance", daemon=True
            )
            self._thread.start()

    def _work(self) -> None:
        while not self._stop.wait(self.config.interval_seconds):
            for cube_id in self.registered_cubes:
                if self._stop.is_set():
                    return
                try:
                    self.run_maintenance(cube_id)
                except Exception:
                    # Retain the cursor and continue other explicitly registered
                    # cubes. Operational failure is not a retention decision.
                    logger.exception("Dream lifecycle periodic maintenance failed")

    def shutdown(self, *, timeout: float = 5) -> bool:
        """Signal cooperative cancellation and acknowledge whether the worker stopped."""
        if not isinstance(timeout, int | float) or not 0 <= timeout <= 300:
            raise LifecycleError("Shutdown timeout must be between zero and 300 seconds")
        with self._lock:
            self._closed = True
            self._stop.set()
            worker = self._thread
        deadline = time.monotonic() + timeout
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=timeout)
        self._idle.wait(timeout=max(0, deadline - time.monotonic()))
        return (worker is None or not worker.is_alive()) and self._idle.is_set()
