from __future__ import annotations

import threading

from typing import TYPE_CHECKING, ClassVar

from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import PROJECT_MEMORY_TASK_LABEL
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks, trigger_single_hook


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


logger = get_logger(__name__)


class ProjectMemoryMessageHandler(BaseSchedulerHandler):
    """Thin scheduler entrypoint for project memory (memory view `project`).

    Same shape as `MemDreamMessageHandler`: no business logic here. It only
    1. groups the batch by space (the plugin submits `user_id = mem_cube_id = space_id`,
       so each space is one stream),
    2. serializes work within a space with a per-space lock — the dispatcher may run
       two batches of the same stream on different threads, and project-memory updates
       are read-modify-write on the same nodes,
    3. delegates to the active project-memory plugin via `H.PROJECT_MEMORY_EXECUTE`.

    The lock covers one process. With several scheduler workers on a Redis queue, the
    storage layer still needs a conditional (versioned) update.
    """

    _space_locks: ClassVar[dict[str, threading.Lock]] = {}
    _class_lock: ClassVar[threading.Lock] = threading.Lock()

    @property
    def expected_task_label(self) -> str:
        return PROJECT_MEMORY_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        if not _hooks.get(H.PROJECT_MEMORY_EXECUTE):
            logger.warning(
                "project_memory task received but no plugin implements %s; dropped %d messages",
                H.PROJECT_MEMORY_EXECUTE,
                len(batch),
            )
            return
        space_id = mem_cube_id
        with self._get_space_lock(space_id):
            trigger_single_hook(
                H.PROJECT_MEMORY_EXECUTE,
                space_id=space_id,
                batch=batch,
                scheduler_context=self.scheduler_context,
            )

    @classmethod
    def _get_space_lock(cls, space_id: str) -> threading.Lock:
        with cls._class_lock:
            lock = cls._space_locks.get(space_id)
            if lock is None:
                lock = threading.Lock()
                cls._space_locks[space_id] = lock
            return lock
