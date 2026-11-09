"""Consumer loop shutdown keeps context, dispatch and metrics behavior intact."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.context.context import get_current_context
from memos.mem_scheduler.base_mixins.queue_ops import BaseSchedulerQueueMixin


def consumer(messages):
    owner = SimpleNamespace(
        _running=True,
        _consume_interval=0.1,
        consume_batch=1,
        use_redis_queue=False,
        enable_parallel_dispatch=True,
        dispatcher=Mock(max_workers=2),
        metrics=Mock(),
        memos_message_queue=Mock(get_messages=Mock(return_value=messages)),
    )
    owner.dispatcher.get_running_task_count.return_value = 0
    owner._stop_event = Mock(
        is_set=Mock(return_value=False),
        wait=Mock(side_effect=lambda _: setattr(owner, "_running", False)),
    )
    return owner


@pytest.mark.parametrize(
    "timestamp", [None, 0, datetime(2026, 1, 1), datetime(2026, 1, 1, tzinfo=timezone.utc)]
)
@pytest.mark.parametrize("redis_queue", [False, True])
def test_consumer_dispatch_preserves_context_and_observes_stop(monkeypatch, timestamp, redis_queue):
    message = SimpleNamespace(
        timestamp=timestamp,
        user_id="u",
        user_name="u",
        label="test",
        trace_id="trace",
        api_path="/test",
    )
    owner = consumer([message])
    owner.use_redis_queue = redis_queue
    previous = get_current_context()
    emit = Mock()
    monkeypatch.setattr("memos.mem_scheduler.base_mixins.queue_ops.emit_monitor_event", emit)
    BaseSchedulerQueueMixin._message_consumer(owner)
    owner.dispatcher.dispatch.assert_called_once_with([message])
    owner._stop_event.wait.assert_called_once_with(0.1)
    current = get_current_context()
    assert (current.to_dict() if current else None) == (previous.to_dict() if previous else None)
    assert (
        emit.call_args.args[2]["queue_wait_ms"] is None
        if timestamp is None
        else emit.call_args.args[2]["queue_wait_ms"] >= 0
    )


@pytest.mark.parametrize(
    "case",
    [
        "empty",
        "serial",
        "full",
        "short",
        "dispatch_error",
        "metrics_error",
        "queue_error",
        "empty_redis",
    ],
)
def test_consumer_failure_and_idle_paths_are_stoppable(monkeypatch, case):
    message = SimpleNamespace(
        timestamp=None, user_id="u", user_name="u", label="test", trace_id="trace", api_path="/test"
    )
    owner = consumer([message])
    monkeypatch.setattr("memos.mem_scheduler.base_mixins.queue_ops.emit_monitor_event", Mock())
    if case == "empty":
        owner.memos_message_queue.get_messages.return_value = []
    elif case == "serial":
        owner.enable_parallel_dispatch = False
    elif case == "full":
        owner.dispatcher.get_running_task_count.return_value = 2
    elif case == "short":
        owner.consume_batch = 2
    elif case == "dispatch_error":
        owner.dispatcher.dispatch.side_effect = ValueError("dispatch")
    elif case == "metrics_error":
        owner.metrics.task_dequeued.side_effect = ValueError("metrics")
    else:
        owner.memos_message_queue.get_messages.side_effect = ValueError(
            "No messages available in Redis queue" if case == "empty_redis" else "queue failure"
        )
    BaseSchedulerQueueMixin._message_consumer(owner)
    assert not owner._running
    owner._stop_event.wait.assert_called_once_with(0.1)


@pytest.mark.parametrize("error", [False, True])
def test_metrics_monitor_handles_queue_shapes_and_stops(error):
    owner = consumer([])
    owner.memos_message_queue.qsize.side_effect = [
        5,
        ValueError("queue")
        if error
        else {"total_size": 7, "p:u:c:t": 3, "local": 4, "short:key": 0},
    ]
    BaseSchedulerQueueMixin._monitor_loop(owner)
    owner._stop_event.wait.assert_called_once_with(15)
    if not error:
        assert owner.metrics.update_queue_length.call_args_list[0].args == (3, "u")
        assert owner.metrics.update_queue_length.call_args_list[1].args == (4, "local")
