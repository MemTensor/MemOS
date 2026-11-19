"""Real child processes must exit before their owner releases graph resources."""

import multiprocessing

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.exceptions import MemOSError
from memos.mem_scheduler.base_mixins.queue_ops import BaseSchedulerQueueMixin
from memos.mem_scheduler.base_scheduler import BaseScheduler


@pytest.mark.skipif(
    "fork" not in multiprocessing.get_all_start_methods(),
    reason="existing process scheduler requires fork",
)
@pytest.mark.parametrize("blocked", [False, True])
def test_process_consumer_close_exits_and_then_closes_graph(monkeypatch, blocked):
    ctx = multiprocessing.get_context("fork")
    ready = ctx.Event()
    task_done = ctx.Event()
    scheduler = BaseScheduler(
        {
            "use_redis_queue": False,
            "thread_pool_max_workers": 1,
            "scheduler_startup_mode": "process",
            "consume_interval_seconds": 0.01,
        }
    )
    graph = Mock()
    scheduler.components = {"graph_db": graph}
    monkeypatch.setattr(
        "memos.mem_scheduler.base_mixins.queue_ops.multiprocessing.Process", ctx.Process
    )
    original = scheduler._message_consumer

    def consume():
        # An accepted task must finish before a normal child exit.
        scheduler.dispatcher.dispatcher_executor.submit(
            lambda: (scheduler._stop_event.wait(10), task_done.set())
        )
        ready.set()
        if blocked:
            ctx.Event().wait(30)
        else:
            original()

    scheduler._message_consumer = consume
    child = None
    try:
        scheduler.start_consumer()
        child = scheduler._consumer_process
        assert ready.wait(5)
        scheduler.close()
        assert not child.is_alive()
        assert child.exitcode == (-15 if blocked else 0)
        if not blocked:
            assert task_done.is_set()
        assert scheduler.dispatcher.dispatcher_executor._shutdown
        graph.close.assert_called_once()
    finally:
        if child is not None:
            if child.is_alive():
                child.terminate()
            child.join(5)
            assert not child.is_alive()
            scheduler._consumer_process = None
            child.close()
        scheduler.close()


@pytest.mark.parametrize("failure", ["survives", "terminate_error"])
def test_unterminated_process_keeps_resources_and_allows_retry(failure):
    scheduler = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 1})
    graph = Mock()
    scheduler.components = {"graph_db": graph}
    process = Mock(is_alive=Mock(return_value=True))
    if failure == "terminate_error":
        process.terminate.side_effect = OSError("cannot terminate")
    scheduler._consumer_process = process
    try:
        with pytest.raises(MemOSError):
            scheduler.close()
        process.terminate.assert_called_once()
        graph.close.assert_not_called()
        assert not scheduler.dispatcher.dispatcher_executor._shutdown
    finally:
        process.is_alive.return_value = False
        scheduler.close()
    graph.close.assert_called_once()


@pytest.mark.parametrize("failure", [None, ValueError("consumer failed")])
def test_child_drains_accepted_tasks_even_when_consumer_fails(failure):
    owner = SimpleNamespace(_message_consumer=Mock(side_effect=failure), dispatcher=Mock())
    if failure is None:
        BaseSchedulerQueueMixin._process_consumer(owner)
    else:
        with pytest.raises(ValueError) as caught:
            BaseSchedulerQueueMixin._process_consumer(owner)
        assert caught.value is failure
    owner.dispatcher.close.assert_called_once()


def test_starting_running_consumer_does_not_replace_stop_signal():
    owner = SimpleNamespace(_running=True)
    BaseSchedulerQueueMixin.start_consumer(owner)
    assert vars(owner) == {"_running": True}
