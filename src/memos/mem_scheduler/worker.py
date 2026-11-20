"""Process entry point: build every runtime dependency in the worker process."""

from __future__ import annotations

from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from collections.abc import Callable
    from multiprocessing.synchronize import Event

    from memos.mem_scheduler.base_scheduler import BaseScheduler


def run_scheduler_worker(factory: Callable[[], BaseScheduler], stop_event: Event) -> None:
    """Run an independently assembled scheduler until a cooperative stop signal.

    Pass this function as a process target, not an existing Scheduler instance.
    The caller chooses the multiprocessing context (spawn is recommended) and
    supplies a picklable factory that creates/configures resources in the child.
    The factory must clean up its own partial initialization if it raises.

    Use thread startup mode inside the worker and Redis for cross-process tasks.
    A local scheduler queue remains local to its worker. The caller owns process
    supervision; setting stop_event drains accepted work through close(), whereas
    forcibly terminating a worker cannot guarantee application-level cleanup.
    """
    scheduler = factory()
    try:
        scheduler.start()
        stop_event.wait()
    finally:
        scheduler.close()
