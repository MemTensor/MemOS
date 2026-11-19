import json

from unittest.mock import Mock

import pytest

from fastapi import HTTPException

from memos.api.handlers.scheduler_handler import handle_scheduler_status
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker


def tracker_with(*items: tuple[str, str, str]) -> TaskStatusTracker:
    rows = {
        item_id: json.dumps({"task_type": label, "status": status})
        for item_id, label, status in items
    }
    redis = Mock()
    redis.smembers.return_value = set(rows)
    redis.hget.side_effect = lambda key, item_id: rows.get(item_id)
    redis.hgetall.return_value = rows
    return TaskStatusTracker(redis)


def test_project_transport_is_not_a_public_task_status() -> None:
    tracker = tracker_with(("stage", "project_add_merge", "failed"))
    for task_id in ("business-task", "stage"):
        with pytest.raises(HTTPException) as error:
            handle_scheduler_status("member", tracker, task_id)
        assert error.value.status_code == 404
    assert not handle_scheduler_status("member", tracker).data


def test_project_delivery_failure_does_not_fail_personal_work() -> None:
    tracker = tracker_with(
        ("stage", "project_add_merge", "failed"),
        ("personal", "mem_read", "completed"),
    )
    assert handle_scheduler_status("member", tracker, "mixed").data[0].status == "completed"


def test_mixed_task_can_report_running_personal_siblings_of_failure() -> None:
    tracker = tracker_with(
        ("first", "mem_read", "failed"),
        ("second", "mem_read", "waiting"),
    )
    assert handle_scheduler_status("member", tracker, "task").data[0].status == "failed"
    status = handle_scheduler_status("member", tracker, "task", prefer_running=True)
    assert status.data[0].status == "in_progress"
