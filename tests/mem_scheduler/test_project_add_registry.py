from unittest.mock import Mock

import pytest

from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
    PROJECT_ADD_MERGE_TASK_LABEL,
    PROJECT_ADD_PROCESS_TASK_LABEL,
    PROJECT_ADD_SPACE_TASK_LABEL,
    SCHEDULER_DEFERRED_INFO_KEY,
    SCHEDULER_SKIP_ACK_INFO_KEY,
    TaskPriorityLevel,
)
from memos.mem_scheduler.task_schedule_modules.registry import SchedulerHandlerRegistry
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks


@pytest.mark.parametrize(
    ("label", "hook"),
    [
        (PROJECT_ADD_PROCESS_TASK_LABEL, H.PROJECT_MEMORY_PROCESS),
        (PROJECT_ADD_SPACE_TASK_LABEL, H.PROJECT_MEMORY_SPACE),
        (PROJECT_ADD_MERGE_TASK_LABEL, H.PROJECT_MEMORY_MERGE),
        (PROJECT_ADD_MERGE_RESULT_TASK_LABEL, H.PROJECT_MEMORY_MERGE_RESULT),
    ],
)
def test_project_add_transport_dispatches_to_registered_stage(monkeypatch, label, hook):
    context = Mock()
    provider = Mock()
    monkeypatch.setitem(_hooks, hook, [provider])
    handler, priority, min_idle_ms = SchedulerHandlerRegistry(context).build_dispatch_map()[label]
    assert priority == TaskPriorityLevel.LEVEL_2
    assert min_idle_ms == 600_000

    item = ScheduleMessageItem(user_id="user", mem_cube_id="space", label=label, content="{}")
    handler([item])
    provider.assert_called_once_with(space_id="space", batch=[item], scheduler_context=context)


def test_project_add_without_provider_leaves_redis_message_pending(monkeypatch):
    monkeypatch.delitem(_hooks, H.PROJECT_MEMORY_PROCESS, raising=False)
    handler, _, _ = SchedulerHandlerRegistry(Mock()).build_dispatch_map()[
        PROJECT_ADD_PROCESS_TASK_LABEL
    ]
    item = ScheduleMessageItem(
        user_id="user", mem_cube_id="space", label=PROJECT_ADD_PROCESS_TASK_LABEL, content="{}"
    )
    handler([item])
    assert item.info[SCHEDULER_DEFERRED_INFO_KEY]
    assert item.info[SCHEDULER_SKIP_ACK_INFO_KEY]
