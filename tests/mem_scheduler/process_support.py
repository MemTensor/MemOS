"""Bounded process probes with separate startup and behavior deadlines."""

import multiprocessing
import traceback

from contextlib import contextmanager
from multiprocessing.connection import wait

import pytest


# Cold imports load the framework and optional libraries on CI runners. This
# budget does not extend the shorter task/drain/deadlock checks after readiness.
STARTUP_TIMEOUT = 60


def _run_probe(connection, target, args):
    try:
        target(connection, *args)
    except BaseException:
        connection.send(("error", traceback.format_exc()))
        raise
    finally:
        connection.close()


@contextmanager
def spawned_probe(target, *args):
    context = multiprocessing.get_context("spawn")
    connection, child_connection = context.Pipe()
    process = context.Process(target=_run_probe, args=(child_connection, target, args))
    try:
        process.start()
        child_connection.close()
        yield process, connection
    finally:
        child_connection.close()
        connection.close()
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(5)
            if process.is_alive():
                process.kill()
                process.join(5)
            assert not process.is_alive(), f"Probe process {process.pid} could not be reaped"
            process.close()


def receive_probe_message(connection, process, *, phase, timeout):
    ready = wait([connection, process.sentinel], timeout=timeout)
    if connection in ready:
        try:
            message = connection.recv()
        except EOFError:
            pytest.fail(f"{phase}: child {process.pid} closed its pipe without a result")
        if message[0] == "error":
            pytest.fail(f"{phase}: child {process.pid} failed:\n{message[1]}", pytrace=False)
        return message
    if process.sentinel in ready:
        process.join()
        pytest.fail(f"{phase}: child {process.pid} exited with code {process.exitcode}")
    pytest.fail(f"{phase}: child {process.pid} did not respond within {timeout}s")
