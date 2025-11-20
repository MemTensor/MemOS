"""
Scheduler handler for scheduler management functionality.

This module handles all scheduler-related operations including status checking,
waiting for idle state, and streaming progress updates.
"""

import json
import time
import traceback

from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from memos.api.handlers.formatters_handler import to_iter
from memos.log import get_logger


logger = get_logger(__name__)


def handle_scheduler_status(
    user_name: str | None = None,
    mem_scheduler: Any | None = None,
    instance_id: str = "",
) -> dict[str, Any]:
    """
    Get scheduler running status.

    Retrieves the number of running tasks for a specific user or globally.

    Args:
        user_name: Optional specific user name to filter tasks
        mem_scheduler: Scheduler instance
        instance_id: Instance ID for response

    Returns:
        Dictionary with status information

    Raises:
        HTTPException: If status retrieval fails
    """
    try:
        if user_name:
            running = mem_scheduler.dispatcher.get_running_tasks(
                lambda task: getattr(task, "mem_cube_id", None) == user_name
            )
            tasks_iter = to_iter(running)
            running_count = len(tasks_iter)
            return {
                "message": "ok",
                "data": {
                    "scope": "user",
                    "user_name": user_name,
                    "running_tasks": running_count,
                    "timestamp": time.time(),
                    "instance_id": instance_id,
                },
            }
        else:
            running_all = mem_scheduler.dispatcher.get_running_tasks(lambda _t: True)
            tasks_iter = to_iter(running_all)
            running_count = len(tasks_iter)

            task_count_per_user: dict[str, int] = {}
            for task in tasks_iter:
                cube = getattr(task, "mem_cube_id", "unknown")
                task_count_per_user[cube] = task_count_per_user.get(cube, 0) + 1

            try:
                metrics_snapshot = mem_scheduler.dispatcher.metrics.snapshot()
            except Exception:
                metrics_snapshot = {}

            return {
                "message": "ok",
                "data": {
                    "scope": "global",
                    "running_tasks": running_count,
                    "task_count_per_user": task_count_per_user,
                    "timestamp": time.time(),
                    "instance_id": instance_id,
                    "metrics": metrics_snapshot,
                },
            }
    except Exception as err:
        logger.error("Failed to get scheduler status: %s", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Failed to get scheduler status") from err


def handle_scheduler_wait(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.2,
    mem_scheduler: Any | None = None,
) -> dict[str, Any]:
    """
    Wait until scheduler is idle for a specific user.

    Blocks until scheduler has no running tasks for the given user, or timeout.

    Args:
        user_name: User name to wait for
        timeout_seconds: Maximum wait time in seconds
        poll_interval: Polling interval in seconds
        mem_scheduler: Scheduler instance

    Returns:
        Dictionary with wait result and statistics

    Raises:
        HTTPException: If wait operation fails
    """
    start = time.time()
    try:
        while True:
            running = mem_scheduler.dispatcher.get_running_tasks(
                lambda task: task.mem_cube_id == user_name
            )
            running_count = len(running)
            elapsed = time.time() - start

            # success -> scheduler is idle
            if running_count == 0:
                return {
                    "message": "idle",
                    "data": {
                        "running_tasks": 0,
                        "waited_seconds": round(elapsed, 3),
                        "timed_out": False,
                        "user_name": user_name,
                    },
                }

            # timeout check
            if elapsed > timeout_seconds:
                return {
                    "message": "timeout",
                    "data": {
                        "running_tasks": running_count,
                        "waited_seconds": round(elapsed, 3),
                        "timed_out": True,
                        "user_name": user_name,
                    },
                }

            time.sleep(poll_interval)

    except Exception as err:
        logger.error("Failed while waiting for scheduler: %s", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Failed while waiting for scheduler") from err


def handle_scheduler_wait_stream(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.2,
    mem_scheduler: Any | None = None,
    instance_id: str = "",
) -> StreamingResponse:
    """
    Stream scheduler progress via Server-Sent Events (SSE).

    Emits periodic heartbeat frames while tasks are running, then final
    status frame indicating idle or timeout.

    Args:
        user_name: User name to monitor
        timeout_seconds: Maximum stream duration in seconds
        poll_interval: Polling interval between updates
        mem_scheduler: Scheduler instance
        instance_id: Instance ID for response

    Returns:
        StreamingResponse with SSE formatted progress updates

    Example:
        curl -N "http://localhost:8000/product/scheduler/wait/stream?timeout_seconds=10"
    """

    def event_generator():
        start = time.time()
        try:
            while True:
                running = mem_scheduler.dispatcher.get_running_tasks(
                    lambda task: task.mem_cube_id == user_name
                )
                running_count = len(running)
                elapsed = time.time() - start

                payload = {
                    "user_name": user_name,
                    "running_tasks": running_count,
                    "elapsed_seconds": round(elapsed, 3),
                    "status": "running" if running_count > 0 else "idle",
                    "instance_id": instance_id,
                }
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

                if running_count == 0 or elapsed > timeout_seconds:
                    payload["status"] = "idle" if running_count == 0 else "timeout"
                    payload["timed_out"] = running_count > 0
                    yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                    break

                time.sleep(poll_interval)

        except Exception as e:
            err_payload = {
                "status": "error",
                "detail": "stream_failed",
                "exception": str(e),
                "user_name": user_name,
            }
            logger.error(f"Scheduler stream error for {user_name}: {traceback.format_exc()}")
            yield "data: " + json.dumps(err_payload, ensure_ascii=False) + "\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
