"""Native scheduler cleanup only; no models, broker or business data."""

import threading
import time

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.api import lifecycle
from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
from memos.mem_scheduler.webservice_modules.rabbitmq_service import RabbitMQSchedulerModule


def test_close_without_rabbitmq_initialization_is_safe_and_repeatable():
    scheduler = RabbitMQSchedulerModule()
    scheduler.rabbitmq_close()
    scheduler.rabbitmq_close()
    assert scheduler._io_loop_thread is None
    assert scheduler._rabbitmq_stop_flag is True


def test_early_initialization_skip_still_closes(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.delenv("MEMOS_ENABLE_RABBITMQ", raising=False)
    scheduler = RabbitMQSchedulerModule()
    scheduler.initialize_rabbitmq()
    assert scheduler._rabbitmq_initializing is False
    scheduler.rabbitmq_close()
    assert scheduler._io_loop_thread is None


def test_real_io_thread_and_connection_cleanup_still_execute():
    scheduler = RabbitMQSchedulerModule()
    stopped = threading.Event()
    calls = []
    scheduler.rabbitmq_channel = SimpleNamespace(
        is_open=True, close=lambda: calls.append("channel")
    )
    scheduler.rabbitmq_connection = SimpleNamespace(
        is_open=True,
        close=lambda: calls.append("connection"),
        ioloop=SimpleNamespace(stop=lambda: (calls.append("ioloop"), stopped.set())),
    )
    worker = threading.Thread(target=stopped.wait, daemon=True)
    scheduler._io_loop_thread = worker
    worker.start()
    try:
        scheduler.rabbitmq_close()
        assert not worker.is_alive()
        assert calls == ["channel", "connection", "ioloop"]
        assert scheduler._rabbitmq_stop_flag is True
    finally:
        stopped.set()
        worker.join(timeout=1)


def test_actual_optimized_scheduler_lifecycle_joins_threads_and_shuts_executor(monkeypatch):
    scheduler = OptimizedScheduler(GeneralSchedulerConfig(use_redis_queue=False))
    scheduler._running = True

    def native_running_loop():
        while scheduler._running:
            time.sleep(0.005)

    consumer = threading.Thread(target=native_running_loop, daemon=True)
    monitor = threading.Thread(target=native_running_loop, daemon=True)
    scheduler._consumer_thread = consumer
    scheduler._monitor_thread = monitor
    consumer.start()
    monitor.start()
    task = scheduler.dispatcher.dispatcher_executor.submit(lambda: 42)
    assert task.result(timeout=2) == 42
    shutdown = Mock(wraps=scheduler.dispatcher.shutdown)
    monkeypatch.setattr(scheduler.dispatcher, "shutdown", shutdown)
    error = Mock()
    monkeypatch.setattr(lifecycle.logger, "exception", error)
    try:
        lifecycle.shutdown_components({"mem_scheduler": scheduler})
        assert not consumer.is_alive() and not monitor.is_alive()
        assert scheduler._running is False
        assert task.done() and scheduler.dispatcher.dispatcher_executor._shutdown is True
        deadline = time.monotonic() + 2
        while (
            any(t.is_alive() for t in scheduler.dispatcher.dispatcher_executor._threads)
            and time.monotonic() < deadline
        ):
            time.sleep(0.005)
        assert not any(t.is_alive() for t in scheduler.dispatcher.dispatcher_executor._threads)
        shutdown.assert_called_once()
        assert scheduler._rabbitmq_stop_flag is True
        error.assert_not_called()
    finally:
        scheduler._running = False
        consumer.join(timeout=1)
        monitor.join(timeout=1)
        scheduler.dispatcher.shutdown()


def test_unexpected_join_error_is_not_hidden():
    scheduler = RabbitMQSchedulerModule()

    def fail_join(**kwargs):
        raise RuntimeError("fixture join failed")

    scheduler._io_loop_thread = SimpleNamespace(is_alive=lambda: True, join=fail_join)
    with pytest.raises(RuntimeError, match="fixture join failed"):
        scheduler.rabbitmq_close()
