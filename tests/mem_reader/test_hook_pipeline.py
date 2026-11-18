"""MemReader Hook contracts at the extraction boundary."""

from types import MethodType

import pytest

from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.plugins.hook_defs import H
from memos.plugins.hooks import register_hook


pytestmark = pytest.mark.usefixtures("clean_hooks")


def test_extract_after_hook_receives_operation_and_can_replace_result(monkeypatch):
    reader = object.__new__(SimpleStructMemReader)
    original_result = [["original"]]
    plugin_result = [["plugin"]]
    scene_data = [{"role": "user", "content": "remember this"}]
    info = {"user_id": "alice", "session_id": "session-1"}
    captured = {}

    def fake_read_memory(self, *_args, **_kwargs):
        return original_result

    def replace_result(**kwargs):
        captured.update(kwargs)
        return plugin_result

    reader._read_memory = MethodType(fake_read_memory, reader)
    monkeypatch.setattr("memos.mem_reader.simple_struct.get_current_trace_id", lambda: "trace-1")
    register_hook(H.MEM_READER_EXTRACT_AFTER, replace_result)

    result = reader.get_memory(
        scene_data,
        type="chat",
        info=info,
        mode="fine",
        user_name="cube-1",
        chat_history=[],
    )

    context = captured.pop("hook_context")
    assert result == plugin_result
    assert context.trace_id == "trace-1"
    assert context.user_id == "alice"
    assert context.session_id == "session-1"
    assert context.cube_ids == ("cube-1",)
    assert context.source == "mem_reader.extract"
    assert captured == {
        "mem_reader": reader,
        "scene_data": scene_data,
        "type": "chat",
        "info": info,
        "mode": "fine",
        "user_name": "cube-1",
        "kwargs": {"chat_history": []},
        "result": original_result,
    }


def test_extract_failure_hook_reports_and_preserves_original_error(monkeypatch):
    reader = object.__new__(SimpleStructMemReader)
    error = ValueError("reader failed")
    events = []

    def fake_read_memory(self, *_args, **_kwargs):
        raise error

    def record(stage):
        def callback(**kwargs):
            events.append((stage, kwargs))

        return callback

    reader._read_memory = MethodType(fake_read_memory, reader)
    monkeypatch.setattr("memos.mem_reader.simple_struct.get_current_trace_id", lambda: "trace-1")
    register_hook(H.MEM_READER_EXTRACT_FAILED, record("failed"))
    register_hook(H.MEM_READER_EXTRACT_AFTER, record("after"))

    with pytest.raises(ValueError, match="reader failed") as exc_info:
        reader.get_memory(
            [{"role": "user", "content": "remember this"}],
            type="chat",
            info={"user_id": "alice", "session_id": "session-1"},
            user_name="cube-1",
        )

    assert exc_info.value is error
    assert [stage for stage, _kwargs in events] == ["failed"]
    failure = events[0][1]
    assert failure["error"] is error
    assert failure["hook_context"].source == "mem_reader.extract"
