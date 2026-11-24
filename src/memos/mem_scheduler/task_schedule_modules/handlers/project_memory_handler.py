from __future__ import annotations

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
    PROJECT_ADD_MERGE_TASK_LABEL,
    PROJECT_ADD_PROCESS_TASK_LABEL,
    PROJECT_ADD_SPACE_TASK_LABEL,
    SCHEDULER_DEFERRED_INFO_KEY,
    SCHEDULER_SKIP_ACK_INFO_KEY,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks, trigger_single_hook


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.mem_scheduler.task_schedule_modules.context import SchedulerHandlerContext


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


PROJECT_ADD_STAGE_HOOKS = {
    PROJECT_ADD_PROCESS_TASK_LABEL: H.PROJECT_MEMORY_PROCESS,
    PROJECT_ADD_SPACE_TASK_LABEL: H.PROJECT_MEMORY_SPACE,
    PROJECT_ADD_MERGE_TASK_LABEL: H.PROJECT_MEMORY_MERGE,
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL: H.PROJECT_MEMORY_MERGE_RESULT,
}


class ProjectAddStageHandler(BaseSchedulerHandler):
    """Delegate one durable Add stage without logging the payload."""

    def __init__(self, scheduler_context: SchedulerHandlerContext, label: str) -> None:
        super().__init__(scheduler_context)
        self.label = label
        self.hook = PROJECT_ADD_STAGE_HOOKS[label]

    @property
    def expected_task_label(self) -> str:
        return self.label

    def validate_and_log_messages(self, messages: list[ScheduleMessageItem], label: str) -> None:
        logger.debug("Dispatching %d project Add messages to %s", len(messages), label)
        self.scheduler_context.services.validate_messages(messages=messages, label=label)

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        if not _hooks.get(self.hook):
            logger.warning("No provider ready for project Add stage %s", self.label)
            self._retain(batch)
            return
        try:
            trigger_single_hook(
                self.hook,
                space_id=mem_cube_id,
                batch=batch,
                scheduler_context=self.scheduler_context,
            )
        except Exception:
            self._retain(batch)
            raise

    @staticmethod
    def _retain(batch: list[ScheduleMessageItem]) -> None:
        for message in batch:
            message.info = {
                **(message.info or {}),
                SCHEDULER_DEFERRED_INFO_KEY: True,
                SCHEDULER_SKIP_ACK_INFO_KEY: True,
            }
