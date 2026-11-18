"""Textual Memory Hook behavior at the SingleCubeView write boundary."""

from __future__ import annotations

import logging

from importlib import import_module
from unittest.mock import MagicMock

import pytest

from memos.plugins.hook_defs import H
from memos.plugins.hooks import register_hook


pytestmark = pytest.mark.usefixtures("clean_hooks")


def _make_add_request(**overrides):
    from memos.api.product_models import APIADDRequest

    values = {
        "user_id": "test_user",
        "messages": [
            {"role": "user", "content": "remember this"},
            {"role": "assistant", "content": "ok"},
        ],
        **overrides,
    }
    return APIADDRequest(**values)


@pytest.fixture
def single_cube_view():
    # Initialize handlers before importing SingleCubeView to avoid the existing
    # handlers/single_cube import cycle when this file runs in isolation.
    import_module("memos.api.handlers")
    from memos.memories.textual.item import (
        TextualMemoryItem,
        TreeNodeTextualMemoryMetadata,
    )
    from memos.multi_mem_cube.single_cube import SingleCubeView

    memory = TextualMemoryItem(
        id="00000000-0000-0000-0000-000000000001",
        memory="hello world",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="u1",
            session_id="s1",
            memory_type="WorkingMemory",
            sources=[],
            info={},
        ),
    )
    mem_reader = MagicMock()
    mem_reader.get_memory.return_value = [[memory]]
    mem_reader.save_rawfile = False
    text_memory = MagicMock()
    text_memory.add.return_value = [memory.id]
    text_memory.mode = "async"
    mem_cube = MagicMock()
    mem_cube.text_mem = text_memory

    view = SingleCubeView(
        cube_id="cube_test",
        naive_mem_cube=mem_cube,
        mem_reader=mem_reader,
        mem_scheduler=MagicMock(),
        logger=logging.getLogger("test.single_cube.hooks"),
        searcher=None,
        feedback_server=None,
    )
    return view, memory


def test_text_memory_after_hook_observes_write_and_replaces_memory_ids(single_cube_view):
    view, memory = single_cube_view
    captured = {}

    def replace_memory_ids(**kwargs):
        captured.update(kwargs)
        return ["plugin-memory-id"]

    register_hook(H.TEXT_MEMORY_ADD_AFTER, replace_memory_ids)

    results = view.add_memories(
        _make_add_request(
            async_mode="async",
            session_id="session-1",
            task_id="task-1",
        )
    )

    assert results[0]["memory_id"] == "plugin-memory-id"
    context = captured.pop("hook_context")
    assert context.user_id == "test_user"
    assert context.session_id == "session-1"
    assert context.task_id == "task-1"
    assert context.cube_ids == ("cube_test",)
    assert context.source == "cube_view.text_mem.add"
    assert captured == {
        "text_memory": view.naive_mem_cube.text_mem,
        "memories": [memory],
        "kwargs": {"user_name": "cube_test"},
        "result": [memory.id],
    }
    submitted_message = view.mem_scheduler.submit_messages.call_args.kwargs["messages"][0]
    assert submitted_message.content == '["plugin-memory-id"]'


def test_text_memory_failure_hook_preserves_original_error_and_skips_after(
    single_cube_view,
    monkeypatch,
):
    view, memory = single_cube_view
    error = ValueError("text memory add failed")
    events = []
    view.naive_mem_cube.text_mem.add.side_effect = error
    monkeypatch.setattr(
        "memos.multi_mem_cube.single_cube.get_current_trace_id",
        lambda: "trace-1",
    )

    def record(stage):
        def callback(**kwargs):
            events.append((stage, kwargs))

        return callback

    register_hook(H.TEXT_MEMORY_ADD_FAILED, record("failed"))
    register_hook(H.TEXT_MEMORY_ADD_AFTER, record("after"))

    with pytest.raises(ValueError, match="text memory add failed") as exc_info:
        view.add_memories(
            _make_add_request(
                async_mode="async",
                session_id="session-1",
                task_id="task-1",
            )
        )

    assert exc_info.value is error
    assert [stage for stage, _kwargs in events] == ["failed"]
    call = events[0][1]
    context = call["hook_context"]
    assert context.trace_id == "trace-1"
    assert context.user_id == "test_user"
    assert context.cube_ids == ("cube_test",)
    assert context.source == "cube_view.text_mem.add"
    assert call["text_memory"] is view.naive_mem_cube.text_mem
    assert call["memories"] == [memory]
    assert call["kwargs"] == {"user_name": "cube_test"}
    assert call["error"] is error
    view.mem_scheduler.submit_messages.assert_not_called()
