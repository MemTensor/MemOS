"""R09-04/05: event barriers make close/initialization/recovery races deterministic."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.exceptions import GraphDBError, MemOSError
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.monitors.dispatcher_monitor import SchedulerDispatcherMonitor


@pytest.fixture
def scheduler():
    instance = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 2})
    yield instance
    # Also usable during Red, without assuming the new close API exists.
    instance._running = False
    instance.dispatcher.dispatcher_executor.shutdown(wait=True, cancel_futures=True)


def owned_components():
    return {"graph_db": Mock(), "naive_mem_cube": Mock(), "feedback_server": Mock()}


def wait_for_close(component):
    with component._close_guard.condition:
        assert component._close_guard.condition.wait_for(lambda: component._close_guard.started, 3)


def test_lazy_properties_share_one_creation(monkeypatch, scheduler):
    components = owned_components()
    factory = Mock(return_value=components)
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", factory)
    with ThreadPoolExecutor(4) as pool:
        cubes = list(pool.map(lambda _: scheduler.mem_cube, range(8)))
        feedback = list(pool.map(lambda _: scheduler.feedback_server, range(8)))
    assert all(cube is components["naive_mem_cube"] for cube in cubes)
    assert all(server is components["feedback_server"] for server in feedback)
    factory.assert_called_once_with()
    scheduler.close()
    scheduler.close()
    components["graph_db"].close.assert_called_once_with()


@pytest.mark.parametrize("property_name", ["mem_cube", "feedback_server"])
def test_lazy_failure_is_visible_and_can_retry_before_close(monkeypatch, scheduler, property_name):
    error = GraphDBError("construction")
    components = owned_components()
    factory = Mock(side_effect=[error, components])
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", factory)
    with pytest.raises(GraphDBError) as raised:
        getattr(scheduler, property_name)
    assert raised.value is error
    getattr(scheduler, property_name)
    scheduler.close()
    components["graph_db"].close.assert_called_once_with()


def test_borrowed_components_never_lazy_initialize_or_close(monkeypatch, scheduler):
    components = owned_components()
    factory = Mock(side_effect=AssertionError("must not initialize"))
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", factory)
    scheduler.mem_cube = components["naive_mem_cube"]
    scheduler.feedback_server = components["feedback_server"]
    assert scheduler.mem_cube is components["naive_mem_cube"]
    assert scheduler.feedback_server is components["feedback_server"]
    scheduler.close()
    components["graph_db"].close.assert_not_called()
    components["naive_mem_cube"].close.assert_not_called()


@pytest.mark.parametrize(
    "entry",
    [
        "mem_cube",
        "feedback_server",
        "start",
        "start_consumer",
        "start_background_monitor",
        "submit_messages",
    ],
)
def test_closed_scheduler_rejects_work_without_creating_resources(monkeypatch, scheduler, entry):
    factory = Mock(side_effect=AssertionError("must not initialize"))
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", factory)
    scheduler.close()
    with pytest.raises(MemOSError, match="clos"):
        if entry == "submit_messages":
            scheduler.submit_messages([])
        elif entry in ("mem_cube", "feedback_server"):
            getattr(scheduler, entry)
        else:
            getattr(scheduler, entry)()
    factory.assert_not_called()


def test_close_waits_for_unpublished_initialization(monkeypatch, scheduler):
    entered, release, closing = Event(), Event(), Event()
    components = owned_components()

    def initialize():
        entered.set()
        assert release.wait(3)
        return components

    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", initialize)
    scheduler.rabbitmq_close = Mock(side_effect=closing.set)
    with ThreadPoolExecutor(2) as pool:
        initialization = pool.submit(lambda: scheduler.mem_cube)
        assert entered.wait(3)
        close = pool.submit(scheduler.close)
        wait_for_close(scheduler)
        assert not close.done()
        release.set()
        with pytest.raises(MemOSError):
            initialization.result(3)
        close.result(3)
    assert scheduler.current_mem_cube is None
    components["graph_db"].close.assert_called_once_with()


def test_final_close_waits_for_task_even_when_stop_wait_false(monkeypatch, scheduler):
    entered, release, closing = Event(), Event(), Event()
    components = owned_components()
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", lambda: components)
    assert scheduler.mem_cube is components["naive_mem_cube"]
    scheduler.rabbitmq_close = Mock(side_effect=closing.set)

    def task():
        entered.set()
        assert release.wait(3)
        components["graph_db"].close.assert_not_called()

    scheduler.dispatcher.stop_wait = False
    task_future = scheduler.dispatcher.dispatcher_executor.submit(task)
    assert entered.wait(3)
    with ThreadPoolExecutor(1) as pool:
        close = pool.submit(scheduler.close)
        wait_for_close(scheduler)
        assert not close.done()
        release.set()
        task_future.result(3)
        close.result(3)
    components["graph_db"].close.assert_called_once_with()


def test_close_failure_retries_only_unreleased_resources(monkeypatch, scheduler):
    components = owned_components()
    components["graph_db"].close.side_effect = [GraphDBError("pool"), None]
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", lambda: components)
    assert scheduler.mem_cube is components["naive_mem_cube"]
    scheduler.rabbitmq_close = Mock()
    with pytest.raises(MemOSError):
        scheduler.close()
    with pytest.raises(MemOSError):
        scheduler.start()
    scheduler.close()
    scheduler.rabbitmq_close.assert_called_once_with()
    assert components["graph_db"].close.call_count == 2


def test_running_recovery_preserves_tasks_and_final_close_drains_retired_pool(scheduler):
    monitor = SchedulerDispatcherMonitor({})
    monitor.initialize(scheduler.dispatcher)
    scheduler.dispatcher_monitor = monitor
    old = scheduler.dispatcher.dispatcher_executor
    entered, release = Event(), Event()
    task = old.submit(lambda: (entered.set(), release.wait(3)))
    assert entered.wait(3)
    monitor._restart_pool("dispatcher", monitor._pools["dispatcher"])
    current = scheduler.dispatcher.dispatcher_executor
    assert current is not old
    assert current.submit(lambda: 7).result(3) == 7
    with ThreadPoolExecutor(1) as pool:
        close = pool.submit(scheduler.close)
        release.set()
        close.result(3)
    assert task.done()
    assert old._shutdown and current._shutdown
    monitor._restart_pool("dispatcher", monitor._pools["dispatcher"])
    assert scheduler.dispatcher.dispatcher_executor is current


def test_recovery_cannot_publish_new_executor_after_close(monkeypatch, scheduler):
    monitor = SchedulerDispatcherMonitor({})
    monitor.initialize(scheduler.dispatcher)
    scheduler.dispatcher_monitor = monitor
    old = scheduler.dispatcher.dispatcher_executor
    entered, release, closing = Event(), Event(), Event()
    candidate = ThreadPoolExecutor(1)

    def new_executor(**kwargs):
        entered.set()
        assert release.wait(3)
        return candidate

    monkeypatch.setattr(
        "memos.mem_scheduler.monitors.dispatcher_monitor.ContextThreadPoolExecutor", new_executor
    )
    scheduler.rabbitmq_close = Mock(side_effect=closing.set)
    with ThreadPoolExecutor(2) as pool:
        recovery = pool.submit(monitor._restart_pool, "dispatcher", monitor._pools["dispatcher"])
        assert entered.wait(3)
        close = pool.submit(scheduler.close)
        wait_for_close(monitor)
        assert not close.done()
        release.set()
        recovery.result(3)
        close.result(3)
    assert scheduler.dispatcher.dispatcher_executor is old
    assert candidate._shutdown


def test_stop_does_not_close_graph_but_final_close_does(monkeypatch, scheduler):
    components = owned_components()
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", lambda: components)
    assert scheduler.mem_cube is components["naive_mem_cube"]
    scheduler.stop()
    components["graph_db"].close.assert_not_called()
    scheduler.close()
    components["graph_db"].close.assert_called_once_with()


@pytest.mark.parametrize("part", ["channel", "connection", "loop"])
def test_rabbitmq_release_failures_are_visible_and_continue(scheduler, part):
    scheduler.rabbitmq_channel = Mock(is_open=True)
    scheduler.rabbitmq_connection = Mock(is_open=True)
    targets = {
        "channel": scheduler.rabbitmq_channel.close,
        "connection": scheduler.rabbitmq_connection.close,
        "loop": scheduler.rabbitmq_connection.ioloop.stop,
    }
    targets[part].side_effect = ValueError("release failed")
    with pytest.raises(MemOSError):
        scheduler.rabbitmq_close()
    for target in targets.values():
        target.assert_called_once_with()


def test_close_checks_rabbitmq_thread_exit_without_holding_callback_lock(scheduler):
    thread = Mock()
    thread.is_alive.side_effect = [True, True]
    scheduler._io_loop_thread = thread
    with pytest.raises(MemOSError):
        scheduler.rabbitmq_close()
    thread.join.assert_called_once_with(timeout=5)


def test_initialize_modules_cannot_publish_after_final_close(monkeypatch, scheduler):
    import memos.mem_scheduler.base_scheduler as module

    entered, release = Event(), Event()
    for name in ("MemoryPostProcessor", "SchedulerRetriever", "ActivationMemoryManager"):
        monkeypatch.setattr(module, name, Mock())
    monkeypatch.setattr(module.AuthConfig, "default_config_exists", lambda: False)
    monkeypatch.setattr(module.AuthConfig, "from_local_env", lambda: None)

    def general_monitor(**kwargs):
        entered.set()
        assert release.wait(3)
        return Mock()

    monkeypatch.setattr(module, "SchedulerGeneralMonitor", general_monitor)
    with ThreadPoolExecutor(2) as pool:
        initialization = pool.submit(scheduler.initialize_modules, Mock())
        assert entered.wait(3)
        close = pool.submit(scheduler.close)
        wait_for_close(scheduler)
        assert not close.done()
        release.set()
        with pytest.raises(MemOSError):
            initialization.result(3)
        close.result(3)
    assert not scheduler.dispatcher_monitor._running
    assert not scheduler.dispatcher_monitor._monitor_thread.is_alive()


def test_close_waits_for_start_already_in_progress(monkeypatch, scheduler):
    from memos.mem_scheduler.base_mixins.queue_ops import BaseSchedulerQueueMixin

    entered, release = Event(), Event()

    def start(self):
        entered.set()
        assert release.wait(3)
        self._running = True

    monkeypatch.setattr(BaseSchedulerQueueMixin, "start", start)
    with ThreadPoolExecutor(2) as pool:
        starting = pool.submit(scheduler.start)
        assert entered.wait(3)
        close = pool.submit(scheduler.close)
        wait_for_close(scheduler)
        release.set()
        starting.result(3)
        close.result(3)
    assert scheduler._running is False


@pytest.mark.parametrize("kind", ["thread", "process"])
def test_stop_retains_live_consumer_for_final_close(scheduler, kind):
    from memos.mem_scheduler.schemas.general_schemas import STARTUP_BY_PROCESS

    worker = Mock(is_alive=Mock(return_value=True))
    scheduler._running = True
    if kind == "process":
        scheduler.scheduler_startup_mode = STARTUP_BY_PROCESS
        scheduler._consumer_process = worker
    else:
        scheduler._consumer_thread = worker
    scheduler.stop_consumer()
    assert getattr(scheduler, "_consumer_" + kind) is worker


def test_async_memory_history_submission_rejects_closed_scheduler(scheduler):
    from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler

    request = SimpleNamespace(
        query="query", user_id="u", top_k=3, internet_search=False, chat_history=[]
    )
    context = SimpleNamespace(mem_cube_id="A")
    scheduler.memos_message_queue.submit_messages = Mock()
    submit = OptimizedScheduler.submit_memory_history_async_task
    task = submit(scheduler, request, context)
    assert task.startswith("mix_search_u_")
    scheduler.close()
    with pytest.raises(MemOSError):
        submit(scheduler, request, context)
    scheduler.memos_message_queue.submit_messages.assert_called_once()


@pytest.mark.parametrize("resource", ["monitor", "consumer", "dispatcher"])
def test_failed_drain_retains_owned_graph_until_retry(monkeypatch, scheduler, resource):
    components = owned_components()
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", lambda: components)
    assert scheduler.mem_cube is components["naive_mem_cube"]
    if resource == "monitor":
        scheduler.dispatcher_monitor = Mock()
        scheduler.dispatcher_monitor.close.side_effect = [ValueError("monitor"), None]
    elif resource == "consumer":
        scheduler._consumer_thread = Mock(join=Mock(side_effect=[ValueError("join"), None]))
    else:
        original = scheduler.dispatcher.close
        scheduler.dispatcher.close = Mock(side_effect=[ValueError("task"), None])
    with pytest.raises(MemOSError):
        scheduler.close()
    components["graph_db"].close.assert_not_called()
    scheduler.close()
    components["graph_db"].close.assert_called_once_with()
    if resource == "dispatcher":
        original()


def test_join_self_and_live_process_are_visible_errors(scheduler):
    import threading

    scheduler._consumer_thread = threading.current_thread()
    with pytest.raises(MemOSError):
        scheduler._join_consumers()
    scheduler._consumer_thread = None
    process = Mock(is_alive=Mock(side_effect=[True, False]))
    scheduler._consumer_process = process
    with pytest.raises(MemOSError):
        scheduler._join_consumers()
    scheduler._join_consumers()
    assert process.join.call_count == 2


def test_existing_components_are_reused_when_feedback_reference_is_reset(monkeypatch, scheduler):
    components = owned_components()
    factory = Mock(return_value=components)
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", factory)
    assert scheduler.mem_cube is components["naive_mem_cube"]
    scheduler._feedback_server = None
    assert scheduler.feedback_server is components["feedback_server"]
    factory.assert_called_once_with()
    scheduler.close()


def test_real_consumer_and_metrics_threads_exit_on_close(scheduler):
    scheduler.memos_message_queue.get_messages = Mock(return_value=[])
    scheduler.submit_messages([])
    scheduler.start()
    threads = scheduler._consumer_thread, scheduler._monitor_thread
    scheduler.close()
    assert all(not thread.is_alive() for thread in threads)


def test_dispatcher_cleanup_retries_only_failed_executor(scheduler):
    original = scheduler.dispatcher.dispatcher_executor
    failed = Mock(shutdown=Mock(side_effect=[ValueError("executor"), None]))
    retired = Mock()
    scheduler.dispatcher.dispatcher_executor = failed
    scheduler.dispatcher._retired_executors.extend([original, retired])
    with pytest.raises(MemOSError):
        scheduler.dispatcher.close()
    scheduler.dispatcher.close()
    retired.shutdown.assert_called_once_with(wait=True, cancel_futures=True)
    assert failed.shutdown.call_count == 2
    scheduler.dispatcher.dispatcher_executor = original


def test_monitor_recovery_failure_keeps_old_executor_for_final_cleanup(scheduler):
    monitor = SchedulerDispatcherMonitor({})
    monitor.initialize(scheduler.dispatcher)
    original = scheduler.dispatcher.dispatcher_executor
    failed = Mock(shutdown=Mock(side_effect=ValueError("shutdown")))
    scheduler.dispatcher._retired_executors.append(failed)
    info = {"executor": failed, "max_workers": 1}
    monitor._restart_pool("dispatcher", info)
    assert not monitor._restart_in_progress
    assert scheduler.dispatcher.dispatcher_executor is original
    failed.shutdown.side_effect = None
    monitor.close()
    scheduler.close()


def test_monitor_health_failure_and_stop_signal_are_observed():
    monitor = SchedulerDispatcherMonitor({})
    monitor._stop_event.wait = Mock(side_effect=[False, True])
    monitor._check_pools_health = Mock(side_effect=ValueError("health"))
    monitor._monitor_loop()
    monitor._check_pools_health.assert_called_once_with()


@pytest.mark.parametrize("shutdown", [False, True])
@pytest.mark.parametrize("failure", [False, True])
def test_nonfinal_monitor_stop_handles_executor_state(shutdown, failure):
    monitor = SchedulerDispatcherMonitor({})
    monitor._running = True
    executor = Mock(_shutdown=shutdown)
    if failure:
        executor.shutdown.side_effect = ValueError("shutdown")
    monitor.register_pool("one", executor, 1)
    monitor.stop()
    assert not monitor._running
    assert executor.shutdown.call_count == (0 if shutdown else 1)
    monitor.stop()


def test_monitor_start_duplicate_stop_and_self_join():
    import threading

    monitor = SchedulerDispatcherMonitor({})
    assert monitor.start()
    assert not monitor.start()
    monitor.stop()
    assert not monitor._monitor_thread.is_alive()
    monitor._monitor_thread = threading.current_thread()
    with pytest.raises(MemOSError):
        monitor.close()
    monitor._monitor_thread = None
    monitor.close()


def test_rabbitmq_closed_connection_and_exited_thread(scheduler):
    scheduler.rabbitmq_connection = Mock(is_open=False)
    thread = Mock(is_alive=Mock(side_effect=[True, False]))
    scheduler._io_loop_thread = thread
    scheduler.rabbitmq_close()
    scheduler.rabbitmq_connection.close.assert_not_called()
    thread.join.assert_called_once_with(timeout=5)


def test_rabbitmq_self_join_is_reported(scheduler):
    import threading

    scheduler._io_loop_thread = threading.current_thread()
    with pytest.raises(MemOSError):
        scheduler.rabbitmq_close()


@pytest.mark.parametrize("auth_source", ["path", "default", "env", "invalid", "missing"])
@pytest.mark.parametrize("has_dispatcher", [False, True])
def test_module_initialization_sources_and_partial_queue_configuration(
    monkeypatch, tmp_path, scheduler, auth_source, has_dispatcher
):
    import memos.mem_scheduler.base_scheduler as module

    original_dispatcher, original_queue = scheduler.dispatcher, scheduler.memos_message_queue
    scheduler.enable_parallel_dispatch = False
    scheduler.use_redis_queue = True
    if not has_dispatcher:
        scheduler.dispatcher = None
        scheduler.memos_message_queue = None
    for name in (
        "SchedulerGeneralMonitor",
        "SchedulerRetriever",
        "MemoryPostProcessor",
        "ActivationMemoryManager",
        "TaskStatusTracker",
    ):
        monkeypatch.setattr(module, name, Mock())
    monkeypatch.setattr(
        module.AuthConfig, "default_config_exists", lambda: auth_source == "default"
    )
    auth = None if auth_source == "missing" else SimpleNamespace(rabbitmq=None)
    monkeypatch.setattr(module.AuthConfig, "from_local_config", Mock(return_value=auth))
    getter = (
        Mock(side_effect=ValueError("auth"))
        if auth_source == "invalid"
        else Mock(return_value=auth)
    )
    monkeypatch.setattr(module.AuthConfig, "from_local_env", getter)
    if auth_source == "path":
        path = tmp_path / "auth.json"
        path.write_text("{}")
        scheduler.auth_config_path = path
    reader = Mock()
    try:
        scheduler.initialize_modules(Mock(), mem_reader=reader, redis_client=Mock())
        assert scheduler.mem_reader is reader
    finally:
        scheduler.dispatcher, scheduler.memos_message_queue = original_dispatcher, original_queue
        scheduler.close()


def test_failed_module_construction_preserves_cause(monkeypatch, scheduler):
    import memos.mem_scheduler.base_scheduler as module

    error = ValueError("monitor unavailable")
    monkeypatch.setattr(module, "SchedulerGeneralMonitor", Mock(side_effect=error))
    with pytest.raises(ValueError) as raised:
        scheduler.initialize_modules(Mock())
    assert raised.value is error
    scheduler.close()


@pytest.mark.parametrize(
    "kind,alive",
    [
        ("process", [False, False]),
        ("process", [True, False, False]),
        ("process", [True, True, False, False]),
        ("thread", [True, False]),
        ("thread", [False]),
    ],
)
def test_stop_consumer_exit_states(scheduler, kind, alive):
    from memos.mem_scheduler.schemas.general_schemas import STARTUP_BY_PROCESS

    worker = Mock(is_alive=Mock(side_effect=alive))
    scheduler._running = True
    if kind == "process":
        scheduler.scheduler_startup_mode = STARTUP_BY_PROCESS
        scheduler._consumer_process = worker
    else:
        scheduler._consumer_thread = worker
    scheduler.stop_consumer()
    assert not scheduler._running
    scheduler.stop_consumer()
