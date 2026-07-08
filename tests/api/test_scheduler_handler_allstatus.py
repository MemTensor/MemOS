"""Regression tests for handle_scheduler_allstatus when running with the local
in-memory message queue (no Redis).

Reproduces the symptom from issue #1395: under Docker + uvicorn with
``DEFAULT_USE_REDIS_QUEUE=false`` the consumer thread is alive and dispatches
messages, but ``GET /product/scheduler/allstatus`` always returns
``{waiting:0, in_progress:0, pending:0, …}``. Root cause is that
``handle_scheduler_allstatus`` only aggregates per-stream entries whose key
starts with ``"scheduler:"`` — local queue monitors only emit flat top-level
totals, so the override loop zeros everything out.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest

from memos.api.handlers import scheduler_handler
from memos.api.handlers.scheduler_handler import handle_scheduler_allstatus
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker


if TYPE_CHECKING:
    from memos.api.product_models import AllStatusResponse


def _make_status_tracker_without_redis() -> TaskStatusTracker:
    """Return a TaskStatusTracker whose ``redis`` attribute is ``None``.

    The real constructor is gated by ``require_python_package`` and is fine to
    call with ``redis_client=None``; this matches the production wiring in
    ``server_router.py`` when ``MEMSCHEDULER_USE_REDIS_QUEUE=false``.
    """

    return TaskStatusTracker(redis_client=None)


def _make_local_mem_scheduler(monitor_status: dict) -> MagicMock:
    """Build a minimal ``mem_scheduler`` stub for the local-queue code path."""

    scheduler = MagicMock()
    scheduler.use_redis_queue = False
    scheduler.task_schedule_monitor = MagicMock()
    scheduler.task_schedule_monitor.get_tasks_status.return_value = monitor_status
    return scheduler


def _make_redis_mem_scheduler(monitor_status: dict) -> MagicMock:
    scheduler = MagicMock()
    scheduler.use_redis_queue = True
    scheduler.task_schedule_monitor = MagicMock()
    scheduler.task_schedule_monitor.get_tasks_status.return_value = monitor_status
    return scheduler


class TestSchedulerAllStatusLocalQueue:
    """When use_redis_queue=False, scheduler_summary must mirror the local
    queue's live depth (remaining/pending) and the dispatcher's running count
    instead of being clamped to zero."""

    def test_running_and_remaining_surface_in_scheduler_summary(self):
        # Arrange — local queue with 2 in-flight tasks and 5 queued tasks
        local_monitor_status = {
            "running": 2,
            "remaining": 5,
            "pending": 5,
        }
        mem_scheduler = _make_local_mem_scheduler(local_monitor_status)
        status_tracker = _make_status_tracker_without_redis()

        # Act
        response: AllStatusResponse = handle_scheduler_allstatus(
            mem_scheduler=mem_scheduler,
            status_tracker=status_tracker,
        )

        # Assert — scheduler_summary should reflect live local-queue counts.
        summary = response.data.scheduler_summary
        assert summary.in_progress == 2, (
            "Expected dispatcher-running count to surface as in_progress for local queue;"
            f" got {summary.in_progress}"
        )
        assert summary.waiting == 5, (
            f"Expected local queue 'remaining' to surface as waiting; got {summary.waiting}"
        )
        assert summary.pending == 5, (
            f"Expected local queue 'pending' to surface as pending; got {summary.pending}"
        )
        # total is summed across waiting + in_progress + completed + failed + cancelled
        assert summary.total == 7, (
            "Expected scheduler total to match running+waiting for local queue;"
            f" got {summary.total}"
        )

    def test_empty_local_queue_still_returns_zero(self):
        # Arrange — idle local queue
        mem_scheduler = _make_local_mem_scheduler({"running": 0, "remaining": 0, "pending": 0})
        status_tracker = _make_status_tracker_without_redis()

        # Act
        response = handle_scheduler_allstatus(
            mem_scheduler=mem_scheduler,
            status_tracker=status_tracker,
        )

        # Assert
        summary = response.data.scheduler_summary
        assert summary.waiting == 0
        assert summary.in_progress == 0
        assert summary.pending == 0
        assert summary.total == 0

    def test_redis_per_stream_aggregation_still_works(self):
        """The Redis-queue path must keep aggregating per-stream entries."""
        # Two streams under the canonical prefix
        redis_monitor_status = {
            "running": 0,  # the legacy top-level totals are not used in redis path
            "remaining": 0,
            "pending": 0,
            "scheduler:messages:stream:v2.0:userA:cubeA:mem_read": {
                "running": 1,
                "remaining": 2,
                "pending": 2,
            },
            "scheduler:messages:stream:v2.0:userB:cubeB:add": {
                "running": 3,
                "remaining": 4,
                "pending": 4,
            },
        }
        mem_scheduler = _make_redis_mem_scheduler(redis_monitor_status)
        status_tracker = _make_status_tracker_without_redis()

        response = handle_scheduler_allstatus(
            mem_scheduler=mem_scheduler,
            status_tracker=status_tracker,
        )
        summary = response.data.scheduler_summary
        assert summary.in_progress == 4
        assert summary.waiting == 6
        assert summary.pending == 6
        assert summary.total == 10


@pytest.fixture(autouse=True)
def _silence_logger(monkeypatch):
    """Quiet the noisy logger in scheduler_handler during the test run."""
    monkeypatch.setattr(scheduler_handler, "logger", MagicMock())
    yield
