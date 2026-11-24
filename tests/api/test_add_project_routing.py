from unittest.mock import Mock

import pytest

from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.product_models import APIADDRequest
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks


@pytest.mark.parametrize(
    ("views", "duplicate", "runs_personal"),
    [
        (["project"], False, False),
        (["text_mem", "project"], False, True),
        (["text_mem", "project"], True, True),
    ],
)
def test_project_add_routes_in_handler(monkeypatch, views, duplicate, runs_personal):
    project = {
        "success": True,
        "status": "running",
        "task_id": "shared-task",
        "memory_view": "project",
    }
    provider = Mock(return_value={**project, "_duplicate": duplicate})
    monkeypatch.setitem(_hooks, H.PROJECT_MEMORY_ACCEPT, [provider])
    monkeypatch.delitem(_hooks, "add.intercept", raising=False)
    monkeypatch.delitem(_hooks, "add.after", raising=False)
    component = Mock()
    handler = AddHandler(
        HandlerDependencies(
            naive_mem_cube=component,
            mem_reader=component,
            mem_scheduler=component,
            feedback_server=component,
        )
    )
    cube = Mock()
    personal = {"event": "ADD"}
    cube.add_memories.return_value = [personal]
    monkeypatch.setattr(handler, "_build_cube_view", Mock(return_value=cube))
    request = APIADDRequest.model_validate(
        {
            "user_id": "user",
            "space_ids": ["space"],
            "allow_memory_view": views,
            "messages": [{"role": "user", "content": "Save this work decision."}],
        }
    )

    response = handler.handle_add_memories(request)

    provider.assert_called_once_with(request=request)
    assert response.data == ([personal, project] if runs_personal else [project])
    if runs_personal:
        assert cube.add_memories.call_args.args[0].task_id == "shared-task"
    else:
        cube.add_memories.assert_not_called()
