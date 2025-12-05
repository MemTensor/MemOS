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

# Imports for new implementation
from memos.api.product_models import (
    AllStatusResponse,
    AllStatusResponseData,
    StatusResponse,
    StatusResponseItem,
)
from memos.log import get_logger
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker


logger = get_logger(__name__)


def handle_scheduler_allstatus(
    mem_scheduler: BaseScheduler,
    status_tracker: TaskStatusTracker,
) -> AllStatusResponse:
    """
    Get detailed scheduler status including running tasks and queue metrics.

    This handler aggregates:
    1. Currently running tasks from Redis (via TaskStatusTracker) - PERSISTENT.
    2. Queue status (counts of running/remaining tasks) from the monitor - PERSISTENT.

    Args:
        mem_scheduler: The BaseScheduler instance.
        status_tracker: The TaskStatusTracker instance.

    Returns:
        AllStatusResponse with detailed status data.
    """
    try:
        # 1. Get running tasks from Redis (persistent status)
        # Flatten the user -> task structure into a single dict for the response
        # or keep it nested? The AllStatusResponseData expects a dict.
        # Let's flatten it to task_id -> task_data for now, or update model to support nesting.
        # Given AllStatusResponseData.running_tasks is dict[str, Any], we can put whatever.
        # Let's return {user_id: {task_id: ...}} which is structured.
        
        global_tasks = status_tracker.get_all_tasks_global()
        
        # Filter for 'running' tasks only? Or return all?
        # The name is "running_tasks", implying active ones.
        # But "status" endpoint returns all.
        # Let's return ALL tasks found in Redis, but maybe organized by user.
        
        # flatten to task_id -> detail if unique, but task_ids are UUIDs so unique.
        flattened_tasks = {}
        for user_id, tasks in global_tasks.items():
            for task_id, detail in tasks.items():
                # Inject user_id into detail for clarity
                detail["user_id"] = user_id
                flattened_tasks[task_id] = detail

        # 2. Get queue status from the monitor
        # The monitor has get_tasks_status() which returns queue metrics
        queue_status_data = {}
        if mem_scheduler.task_schedule_monitor:
            queue_status_data = mem_scheduler.task_schedule_monitor.get_tasks_status()

        return AllStatusResponse(
            data=AllStatusResponseData(
                running_tasks=flattened_tasks,
                queue_status=queue_status_data,
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
