"""Schedulers belong to one process; independent workers construct their own resources."""

import multiprocessing
import os
import queue

from dataclasses import dataclass
from functools import partial
from threading import Event
from unittest.mock import Mock

import pytest

from memos.exceptions import ConfigurationError
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


def test_legacy_process_start_fails_before_mutating_running_state(monkeypatch):
    process = Mock()
    monkeypatch.setattr(multiprocessing, "Process", process)
    scheduler = BaseScheduler({"use_redis_queue": False, "scheduler_startup_mode": "process"})
    try:
        with pytest.raises(ConfigurationError, match="worker"):
            scheduler.start_consumer()
        assert not scheduler._running
        assert scheduler._consumer_process is None
        process.assert_not_called()
    finally:
        scheduler.close()


def test_typed_config_does_not_silently_ignore_process_mode():
    from pydantic import ValidationError

    from memos.configs.mem_scheduler import GeneralSchedulerConfig

    with pytest.raises(ValidationError, match="scheduler_startup_mode"):
        GeneralSchedulerConfig(scheduler_startup_mode="process")


def test_failed_thread_start_remains_closable_and_retryable(monkeypatch):
    scheduler = BaseScheduler({"use_redis_queue": False})
    thread = Mock()
    thread.start.side_effect = OSError("cannot start thread")
    with monkeypatch.context() as patch:
        patch.setattr(
            "memos.mem_scheduler.base_mixins.queue_ops.ContextThread", Mock(return_value=thread)
        )
        with pytest.raises(OSError):
            scheduler.start_consumer()
    assert not scheduler._running and scheduler._consumer_thread is None
    try:
        scheduler.start_consumer()
        assert scheduler._consumer_thread.is_alive()
    finally:
        scheduler.close()


def test_owner_pid_validation_reports_configuration_error():
    scheduler = BaseScheduler({"use_redis_queue": False})
    original = scheduler._owner_pid
    try:
        scheduler._owner_pid = -1
        with pytest.raises(ConfigurationError, match="fork"):
            scheduler.close()
    finally:
        scheduler._owner_pid = original
        scheduler.close()


def _try_inherited_scheduler(scheduler, results):
    for operation in (
        scheduler.start_consumer,
        lambda: scheduler.submit_messages([]),
        lambda: scheduler.mem_cube,
        lambda: scheduler.feedback_server,
        scheduler.stop,
        scheduler.stop_consumer,
        scheduler.close,
    ):
        try:
            operation()
        except ConfigurationError:
            results.put("rejected")
        else:
            results.put("unsafe")


@pytest.mark.skipif("fork" not in multiprocessing.get_all_start_methods(), reason="requires fork")
def test_inherited_scheduler_is_rejected_before_acquiring_parent_locks():
    ctx = multiprocessing.get_context("fork")
    results = ctx.Queue()
    scheduler = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 1})
    graph = Mock()
    scheduler.components = {"graph_db": graph, "naive_mem_cube": Mock(), "feedback_server": Mock()}
    # The fork happens while a different parent thread holds the lifecycle lock.
    locked, release = Event(), Event()

    def hold_lock():
        with scheduler._initialization_lock:
            locked.set()
            release.wait(15)

    task = scheduler.dispatcher.dispatcher_executor.submit(hold_lock)
    child = ctx.Process(target=_try_inherited_scheduler, args=(scheduler, results))
    try:
        assert locked.wait(3)
        child.start()
        assert [results.get(timeout=5) for _ in range(7)] == ["rejected"] * 7
        child.join(5)
        assert child.exitcode == 0
        graph.close.assert_not_called()
    finally:
        release.set()
        task.result(timeout=3)
        if child.pid is not None:
            if child.is_alive():
                child.terminate()
            child.join(5)
            child.close()
        scheduler.close()
        results.close()
        results.join_thread()
    graph.close.assert_called_once()


@dataclass
class _ChildGraph:
    results: object

    def close(self):
        self.results.put(("closed", os.getpid()))


def _build_worker(incoming, results, release):
    scheduler = BaseScheduler(
        {"use_redis_queue": False, "thread_pool_max_workers": 1, "consume_interval_seconds": 0.01}
    )
    scheduler.components = {"graph_db": _ChildGraph(results)}

    def receive(batch_size):
        try:
            content = incoming.get_nowait()
        except queue.Empty:
            return []
        return [ScheduleMessageItem(user_id="u", mem_cube_id="cube", label="test", content=content)]

    def handle(messages):
        results.put(("started", os.getpid()))
        assert release.wait(15)
        results.put((messages[0].content, os.getpid()))

    # The adapter represents an external data transport; no parent runtime
    # objects (scheduler, executor, connection or ordinary Queue) cross the boundary.
    scheduler.memos_message_queue.get_messages = receive
    scheduler.register_handlers({"test": handle})
    results.put(("created", os.getpid()))
    return scheduler


@pytest.mark.parametrize("parent_busy", [False, True])
def test_spawn_worker_handles_late_task_drains_and_preserves_parent(parent_busy):
    from memos.mem_scheduler.worker import run_scheduler_worker

    ctx = multiprocessing.get_context("spawn")
    incoming, results = ctx.Queue(), ctx.Queue()
    stop, release = ctx.Event(), ctx.Event()
    parent_release, parent_started = Event(), Event()
    parent = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 1})
    graph = Mock()
    parent.components = {"graph_db": graph}

    def parent_work():
        parent_started.set()
        if parent_busy:
            assert parent_release.wait(20)
        return os.getpid()

    task = parent.dispatcher.dispatcher_executor.submit(parent_work)
    child = ctx.Process(
        target=run_scheduler_worker, args=(partial(_build_worker, incoming, results, release), stop)
    )
    try:
        assert parent_started.wait(3)
        if not parent_busy:
            assert task.result(timeout=3) == os.getpid()
        child.start()
        assert results.get(timeout=10) == ("created", child.pid)
        incoming.put("late-task-done")
        assert results.get(timeout=5) == ("started", child.pid)
        stop.set()
        assert child.is_alive()  # accepted task still owns the graph
        release.set()
        assert results.get(timeout=5) == ("late-task-done", child.pid)
        assert results.get(timeout=5) == ("closed", child.pid)
        child.join(10)
        assert child.exitcode == 0
        graph.close.assert_not_called()
        parent_release.set()
        assert task.result(timeout=3) == os.getpid()
        assert parent.dispatcher.dispatcher_executor.submit(lambda: 42).result(timeout=3) == 42
    finally:
        stop.set()
        release.set()
        parent_release.set()
        if child.pid is not None:
            child.join(10)
            if child.is_alive():
                child.terminate()
                child.join(5)
            child.close()
        parent.close()
        for ipc in (incoming, results):
            ipc.close()
            ipc.join_thread()
    graph.close.assert_called_once()


@pytest.mark.parametrize("stage", ["start", "wait", "success"])
def test_worker_always_closes_returned_scheduler(stage):
    from memos.mem_scheduler.worker import run_scheduler_worker

    scheduler, stop = Mock(), Mock()
    failure = OSError("worker failure")
    if stage == "start":
        scheduler.start.side_effect = failure
    elif stage == "wait":
        stop.wait.side_effect = failure
    if stage == "success":
        run_scheduler_worker(lambda: scheduler, stop)
    else:
        with pytest.raises(OSError) as caught:
            run_scheduler_worker(lambda: scheduler, stop)
        assert caught.value is failure
    scheduler.close.assert_called_once()
