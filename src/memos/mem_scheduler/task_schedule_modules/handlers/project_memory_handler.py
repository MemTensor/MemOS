from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks, trigger_single_hook


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


logger = get_logger(__name__)

# Scheduler label for project-memory tasks.  Declared here (not in
# task_schemas.py) so that task_schemas.py stays at the open-source baseline
# and merges cleanly into the enterprise version.
PROJECT_MEMORY_TASK_LABEL = "project_memory"


class ProjectMemoryMessageHandler(BaseSchedulerHandler):
    """Thin scheduler entrypoint for project memory (memory view `project`).

    Same shape as `MemDreamMessageHandler`: no business logic here. The plugin submits one
    stream per conversation (`user_id = <space>.<conversation hash>`, `mem_cube_id = space_id`),
    so the dispatcher runs different conversations of the same space in parallel. Locking
    (per conversation, per topic, ...) lives in the plugin; this handler only delegates to
    the active project-memory plugin via `H.PROJECT_MEMORY_EXECUTE`.
    """

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
        trigger_single_hook(
            H.PROJECT_MEMORY_EXECUTE,
            space_id=mem_cube_id,
            batch=batch,
            scheduler_context=self.scheduler_context,
        )
