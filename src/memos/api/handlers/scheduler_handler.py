"""
Scheduler handler for scheduler management functionality.

This module handles all scheduler-related operations including status checking,
waiting for idle state, and streaming progress updates.
"""

import json
import time
import traceback

from collections import Counter
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

# Imports for new implementation
from memos.api.product_models import (
    AllStatusResponse,
    AllStatusResponseData,
    StatusResponse,
    StatusResponseItem,
    TaskQueueData,
    TaskQueueResponse,
    TaskSummary,
)
from memos.log import get_logger
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker


logger = get_logger(__name__)


def handle_scheduler_allstatus(
    mem_scheduler: BaseScheduler,
    status_tracker: TaskStatusTracker,
) -> AllStatusResponse:
    """
    Get aggregated scheduler status metrics (no per-task payload).

    Args:
        mem_scheduler: The BaseScheduler instance.
        status_tracker: The TaskStatusTracker instance.

    Returns:
        AllStatusResponse with aggregated status data.
    """

    def _summarize_tasks(task_details: list[dict[str, Any]]) -> TaskSummary:
        """Aggregate counts by status for the provided task details (tracker data)."""
        counter = Counter()
        for detail in task_details:
            status = detail.get("status")
            if status:
                counter[status] += 1

        total = sum(counter.values())
        return TaskSummary(
            waiting=counter.get("waiting", 0),
            in_progress=counter.get("in_progress", 0),
            completed=counter.get("completed", 0),
            pending=counter.get("pending", counter.get("waiting", 0)),
            failed=counter.get("failed", 0),
            cancelled=counter.get("cancelled", 0),
            total=total,
        )

    def _aggregate_counts_from_redis(
        tracker: TaskStatusTracker, max_age_seconds: float = 86400
    ) -> TaskSummary | None:
        """Stream status counts directly from Redis to avoid loading all task payloads."""
        redis_client = getattr(tracker, "redis", None)
        if not redis_client:
            return None

        counter = Counter()
        now = datetime.now(timezone.utc).timestamp()

        # Scan task_meta keys, then hscan each hash in batches
        cursor: int | str = 0
        while True:
            cursor, keys = redis_client.scan(cursor=cursor, match="memos:task_meta:*", count=200)
            for key in keys:
                h_cursor: int | str = 0
                while True:
                    h_cursor, fields = redis_client.hscan(key, cursor=h_cursor, count=500)
                    for value in fields.values():
                        try:
                            payload = json.loads(
                                value.decode("utf-8") if isinstance(value, bytes) else value
                            )
                            # Skip stale entries to reduce noise and load
                            ts = payload.get("submitted_at") or payload.get("started_at")
                            if ts:
                                try:
                                    ts_dt = datetime.fromisoformat(ts)
                                    ts_seconds = ts_dt.timestamp()
                                except Exception:
                                    ts_seconds = None
                                if ts_seconds and (now - ts_seconds) > max_age_seconds:
                                    continue
                            status = payload.get("status")
                            if status:
                                counter[status] += 1
                        except Exception:
                            continue
                    if h_cursor == 0 or h_cursor == "0":
                        break
            if cursor == 0 or cursor == "0":
                break

        if not counter:
            return TaskSummary()  # Empty summary if nothing found

        total = sum(counter.values())
        return TaskSummary(
            waiting=counter.get("waiting", 0),
            in_progress=counter.get("in_progress", 0),
            completed=counter.get("completed", 0),
            pending=counter.get("pending", counter.get("waiting", 0)),
            failed=counter.get("failed", 0),
            cancelled=counter.get("cancelled", 0),
            total=total,
        )

    try:
        # Prefer streaming aggregation to avoid pulling all task payloads
        all_tasks_summary = _aggregate_counts_from_redis(status_tracker)
        if all_tasks_summary is None:
            # Fallback: load all details then aggregate
            global_tasks = status_tracker.get_all_tasks_global()
            all_task_details: list[dict[str, Any]] = []
            for _, tasks in global_tasks.items():
                all_task_details.extend(tasks.values())
            all_tasks_summary = _summarize_tasks(all_task_details)

        # Scheduler view: assume tracker contains scheduler tasks; overlay queue monitor for live queue depth
        sched_waiting = all_tasks_summary.waiting
        sched_in_progress = all_tasks_summary.in_progress
        sched_pending = all_tasks_summary.pending
        sched_completed = all_tasks_summary.completed
        sched_failed = all_tasks_summary.failed
        sched_cancelled = all_tasks_summary.cancelled

        # If queue monitor is available, prefer its live waiting/in_progress counts
        if mem_scheduler.task_schedule_monitor:
            queue_status_data = mem_scheduler.task_schedule_monitor.get_tasks_status() or {}
            scheduler_waiting = 0
            scheduler_in_progress = 0
            scheduler_pending = 0
            for key, value in queue_status_data.items():
                if not key.startswith("scheduler:"):
                    continue
                scheduler_in_progress += int(value.get("running", 0) or 0)
                scheduler_pending += int(value.get("pending", value.get("remaining", 0)) or 0)
                scheduler_waiting += int(value.get("remaining", 0) or 0)
            sched_waiting = scheduler_waiting
            sched_in_progress = scheduler_in_progress
            sched_pending = scheduler_pending

        scheduler_summary = TaskSummary(
            waiting=sched_waiting,
            in_progress=sched_in_progress,
            pending=sched_pending,
            completed=sched_completed,
            failed=sched_failed,
            cancelled=sched_cancelled,
            total=sched_waiting
            + sched_in_progress
            + sched_completed
            + sched_failed
            + sched_cancelled,
        )

        return AllStatusResponse(
            data=AllStatusResponseData(
                scheduler_summary=scheduler_summary,
                all_tasks_summary=all_tasks_summary,
            )
        )
    except Exception as err:
        logger.error(f"Failed to get full scheduler status: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Failed to get full scheduler status") from err


def handle_scheduler_status(
    user_id: str, status_tracker: TaskStatusTracker, task_id: str | None = None
) -> StatusResponse:
    """
    Get scheduler running status for one or all tasks of a user.

    Retrieves task statuses from the persistent TaskStatusTracker.

    Args:
        user_id: User ID to query for.
        status_tracker: The TaskStatusTracker instance.
        task_id: Optional Task ID to query. Can be either:
                 - business_task_id (will aggregate all related item statuses)
                 - item_id (will return single item status)

    Returns:
        StatusResponse with a list of task statuses.

    Raises:
        HTTPException: If a specific task is not found.
    """
    response_data: list[StatusResponseItem] = []

    try:
        if task_id:
            # First try as business_task_id (aggregated query)
            business_task_data = status_tracker.get_task_status_by_business_id(task_id, user_id)
            if business_task_data:
                response_data.append(
                    StatusResponseItem(task_id=task_id, status=business_task_data["status"])
                )
            else:
                # Fallback: try as item_id (single item query)
                item_task_data = status_tracker.get_task_status(task_id, user_id)
                if not item_task_data:
                    raise HTTPException(
                        status_code=404, detail=f"Task {task_id} not found for user {user_id}"
                    )
                response_data.append(
                    StatusResponseItem(task_id=task_id, status=item_task_data["status"])
                )
        else:
            all_tasks = status_tracker.get_all_tasks_for_user(user_id)
            # The plan returns an empty list, which is good.
            # No need to check "if not all_tasks" explicitly before the list comprehension
            response_data = [
                StatusResponseItem(task_id=tid, status=t_data["status"])
                for tid, t_data in all_tasks.items()
            ]

        return StatusResponse(data=response_data)
    except HTTPException:
        # Re-raise HTTPException directly to preserve its status code (e.g., 404)
        raise
    except Exception as err:
        logger.error(f"Failed to get scheduler status for user {user_id}: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Failed to get scheduler status") from err


def handle_task_queue_status(
    user_id: str, mem_scheduler: OptimizedScheduler, task_id: str | None = None
) -> TaskQueueResponse:
    try:
        queue_wrapper = getattr(mem_scheduler, "memos_message_queue", None)
        if queue_wrapper is None:
            raise HTTPException(status_code=503, detail="Scheduler queue is not available")

        # Unwrap to the underlying queue if wrapped by ScheduleTaskQueue
        queue = getattr(queue_wrapper, "memos_message_queue", queue_wrapper)

        # Only support Redis-backed queue for now; try lazy init if not connected
        redis_conn = getattr(queue, "_redis_conn", None)
        if redis_conn is None:
            try:
                if hasattr(queue, "auto_initialize_redis"):
                    queue.auto_initialize_redis()
                    redis_conn = getattr(queue, "_redis_conn", None)
                if redis_conn and hasattr(queue, "connect"):
                    queue.connect()
            except Exception:
                redis_conn = None

        if redis_conn is None:
            raise HTTPException(status_code=503, detail="Scheduler queue not connected to Redis")

        # Use wrapper to list stream keys so it can adapt to local/redis queue
        stream_keys = queue_wrapper.get_stream_keys()
        # Filter by user_id; stream key format: {prefix}:{user_id}:{mem_cube_id}:{task_label}
        user_stream_keys = [sk for sk in stream_keys if f":{user_id}:" in sk]

        if not user_stream_keys:
            raise HTTPException(
                status_code=404, detail=f"No scheduler streams found for user {user_id}"
            )

        def _parse_user_id_from_stream(stream_key: str) -> str | None:
            try:
                parts = stream_key.split(":")
                if len(parts) < 3:
                    return None
                # prefix may contain multiple segments; user_id is the 2nd segment from the end - 1
                return parts[-3]
            except Exception:
                return None

        user_ids_present = {
            uid for uid in (_parse_user_id_from_stream(sk) for sk in stream_keys) if uid
        }

        pending_total = 0
        pending_detail: list[str] = []
        remaining_total = 0
        remaining_detail: list[str] = []

        consumer_group = getattr(queue, "consumer_group", None) or "scheduler_group"
        for sk in user_stream_keys:
            try:
                pending_info = redis_conn.xpending(sk, consumer_group)
                pending_count = pending_info[0] if pending_info else 0
            except Exception:
                pending_count = 0
            pending_total += pending_count
            pending_detail.append(f"{sk}:{pending_count}")

            try:
                remaining_count = redis_conn.xlen(sk)
            except Exception:
                remaining_count = 0
            remaining_total += remaining_count
            remaining_detail.append(f"{sk}:{remaining_count}")

        data = TaskQueueData(
            user_id=user_id,
            user_name=None,
            mem_cube_id=None,
            stream_keys=user_stream_keys,
            users_count=len(user_ids_present),
            pending_tasks_count=pending_total,
            remaining_tasks_count=remaining_total,
            pending_tasks_detail=pending_detail,
            remaining_tasks_detail=remaining_detail,
        )
        return TaskQueueResponse(data=data)
    except HTTPException:
        # Re-raise HTTPException directly to preserve its status code (e.g., 404)
        raise
    except Exception as err:
        logger.error(
            f"Failed to get task queue status for user {user_id}: {traceback.format_exc()}"
        )
        raise HTTPException(status_code=500, detail="Failed to get scheduler status") from err


def handle_scheduler_wait(
    user_name: str,
    status_tracker: TaskStatusTracker,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.5,
) -> dict[str, Any]:
    """
    Wait until the scheduler is idle for a specific user.

    Blocks and polls the new /scheduler/status endpoint until no tasks are in
    'waiting' or 'in_progress' state, or until a timeout is reached.

    Args:
        user_name: User name to wait for.
        status_tracker: The TaskStatusTracker instance.
        timeout_seconds: Maximum wait time in seconds.
        poll_interval: Polling interval in seconds.

    Returns:
        Dictionary with wait result and statistics.

    Raises:
        HTTPException: If wait operation fails.
    """
    start_time = time.time()
    try:
        while time.time() - start_time < timeout_seconds:
            # Directly call the new, reliable status logic
            status_response = handle_scheduler_status(
                user_id=user_name, status_tracker=status_tracker
            )

            # System is idle if the data list is empty or no tasks are active
            is_idle = not status_response.data or all(
                task.status in ["completed", "failed", "cancelled"] for task in status_response.data
            )

            if is_idle:
                return {
                    "message": "idle",
                    "data": {
                        "running_tasks": 0,  # Kept for compatibility
                        "waited_seconds": round(time.time() - start_time, 3),
                        "timed_out": False,
                        "user_name": user_name,
                    },
                }

            time.sleep(poll_interval)

        # Timeout occurred
        final_status = handle_scheduler_status(user_id=user_name, status_tracker=status_tracker)
        active_tasks = [t for t in final_status.data if t.status in ["waiting", "in_progress"]]

        return {
            "message": "timeout",
            "data": {
                "running_tasks": len(active_tasks),  # A more accurate count of active tasks
                "waited_seconds": round(time.time() - start_time, 3),
                "timed_out": True,
                "user_name": user_name,
            },
        }
    except HTTPException:
        # Re-raise HTTPException directly to preserve its status code
        raise
    except Exception as err:
        logger.error(
            f"Failed while waiting for scheduler for user {user_name}: {traceback.format_exc()}"
        )
        raise HTTPException(status_code=500, detail="Failed while waiting for scheduler") from err


def handle_scheduler_wait_stream(
    user_name: str,
    status_tracker: TaskStatusTracker,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.5,
    instance_id: str = "",
) -> StreamingResponse:
    """
    Stream scheduler progress via Server-Sent Events (SSE) using the new status endpoint.

    Emits periodic heartbeat frames while tasks are active, then a final
    status frame indicating idle or timeout.

    Args:
        user_name: User name to monitor.
        status_tracker: The TaskStatusTracker instance.
        timeout_seconds: Maximum stream duration in seconds.
        poll_interval: Polling interval between updates.
        instance_id: Instance ID for response.

    Returns:
        StreamingResponse with SSE formatted progress updates.
    """

    def event_generator():
        start_time = time.time()
        try:
            while True:
                elapsed = time.time() - start_time
                if elapsed > timeout_seconds:
                    # Send timeout message and break
                    final_status = handle_scheduler_status(
                        user_id=user_name, status_tracker=status_tracker
                    )
                    active_tasks = [
                        t for t in final_status.data if t.status in ["waiting", "in_progress"]
                    ]
                    payload = {
                        "user_name": user_name,
                        "active_tasks": len(active_tasks),
                        "elapsed_seconds": round(elapsed, 3),
                        "status": "timeout",
                        "timed_out": True,
                        "instance_id": instance_id,
                    }
                    yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                    break

                # Get status
                status_response = handle_scheduler_status(
                    user_id=user_name, status_tracker=status_tracker
                )
                active_tasks = [
                    t for t in status_response.data if t.status in ["waiting", "in_progress"]
                ]
                num_active = len(active_tasks)

                payload = {
                    "user_name": user_name,
                    "active_tasks": num_active,
                    "elapsed_seconds": round(elapsed, 3),
                    "status": "running" if num_active > 0 else "idle",
                    "instance_id": instance_id,
                }
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

                if num_active == 0:
                    break  # Exit loop if idle

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
