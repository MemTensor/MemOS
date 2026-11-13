"""Run self-close probes in owned processes so a regression cannot hang pytest."""

import pytest

from tests.mem_scheduler.process_support import (
    STARTUP_TIMEOUT,
    receive_probe_message,
    spawned_probe,
)


def _close_probe(connection, mode):
    from threading import Event, Thread
    from unittest.mock import Mock

    import memos.mem_scheduler.base_scheduler as module

    from memos.exceptions import MemOSError
    from memos.mem_scheduler.base_scheduler import BaseScheduler

    s = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 2})
    pool = s.dispatcher.dispatcher_executor
    graph = Mock()
    s.components = {"graph_db": graph, "naive_mem_cube": Mock(), "feedback_server": Mock()}
    connection.send(("ready",))
    assert connection.recv() == ("run",)

    def rejected_close():
        try:
            (s.dispatcher.close if mode == "dispatcher" else s.close)()
        except MemOSError:
            return
        raise AssertionError("close from an owned worker must fail")

    if mode == "concurrent":
        entered, release, draining, done = (Event() for _ in range(4))
        original = pool.shutdown

        def shutdown(*args, **kwargs):
            draining.set()
            return original(*args, **kwargs)

        pool.shutdown = shutdown

        def worker():
            entered.set()
            assert release.wait(5)
            rejected_close()

        future = pool.submit(worker)
        assert entered.wait(5)
        errors = []

        def owner():
            try:
                s.close()
            except BaseException as exc:
                errors.append(exc)
            finally:
                done.set()

        thread = Thread(target=owner, daemon=True)
        thread.start()
        assert draining.wait(5)
        release.set()
        future.result(timeout=3)
        assert done.wait(3)
        assert not errors, errors
        thread.join()
    elif mode == "initializing":
        expected = s.components
        s.components = None

        def initialize():
            rejected_close()
            return expected

        module.init_components = initialize
        assert s.mem_cube is expected["naive_mem_cube"]
        s.close()
    else:
        pool.submit(rejected_close).result(timeout=3)
        # Rejected self-close must not terminally close the scheduler or dispatcher.
        assert pool.submit(lambda: 42).result(timeout=3) == 42
        assert s.mem_cube is s.components["naive_mem_cube"]
        s.close()
    graph.close.assert_called_once()
    connection.send(("owner closed safely",))


@pytest.mark.parametrize("mode", ["worker", "dispatcher", "concurrent", "initializing"])
def test_owned_worker_and_initialization_callbacks_cannot_close_owner(mode):
    with spawned_probe(_close_probe, mode) as (child, connection):
        assert receive_probe_message(
            connection, child, phase="scheduler initialization", timeout=STARTUP_TIMEOUT
        ) == ("ready",)
        # Only initialized processes enter the bounded deadlock probe. Import
        # time cannot consume its budget or hide an actual self-close deadlock.
        connection.send(("run",))
        assert receive_probe_message(
            connection, child, phase=f"self-close ({mode})", timeout=20
        ) == ("owner closed safely",)
        child.join(5)
        assert child.exitcode == 0
