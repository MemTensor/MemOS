from unittest.mock import Mock

import pytest

from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    SCHEDULER_DEFERRED_INFO_KEY,
    SCHEDULER_SKIP_ACK_INFO_KEY,
    RunningTaskItem,
)
from memos.mem_scheduler.task_schedule_modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.task_schedule_modules.redis_queue import SchedulerRedisQueue


@pytest.mark.parametrize("handler_fails", [False, True])
def test_dispatcher_keeps_deferred_delivery_claimable(handler_fails: bool) -> None:
    queue = Mock(spec=SchedulerRedisQueue)
    tracker = Mock()
    dispatcher = SchedulerDispatcher(
        memos_message_queue=queue,
        enable_parallel_dispatch=False,
        metrics=Mock(),
        status_tracker=tracker,
    )
    messages = [
        ScheduleMessageItem(
            item_id=key,
            user_id="member",
            mem_cube_id="space",
            label="test_stage",
            content="{}",
            info={},
            redis_message_id=f"{i}-0",
        )
        for i, key in enumerate(("finished", "rescheduled", "pending"), 1)
    ]

    messages[0].info.update({SCHEDULER_DEFERRED_INFO_KEY: True, SCHEDULER_SKIP_ACK_INFO_KEY: True})

    def handler(batch: list[ScheduleMessageItem]) -> None:
        batch[1].info[SCHEDULER_DEFERRED_INFO_KEY] = True
        batch[2].info[SCHEDULER_DEFERRED_INFO_KEY] = True
        batch[2].info[SCHEDULER_SKIP_ACK_INFO_KEY] = True
        if handler_fails:
            raise ValueError("test failure")

    task = RunningTaskItem(
        user_id="member", mem_cube_id="space", task_info="test", task_name="test_stage"
    )
    run = dispatcher._create_task_wrapper(handler, task)
    if handler_fails:
        with pytest.raises(ValueError, match="test failure"):
            run(messages)
        tracker.task_failed.assert_called_once_with(
            task_id="finished", user_id="member", error_message="test failure"
        )
        tracker.task_completed.assert_not_called()
    else:
        run(messages)
        tracker.task_completed.assert_called_once_with(task_id="finished", user_id="member")
        tracker.task_failed.assert_not_called()

    assert [call.kwargs["redis_message_id"] for call in queue.ack_message.call_args_list] == [
        "1-0",
        "2-0",
    ]
