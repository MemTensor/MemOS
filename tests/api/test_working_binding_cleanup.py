"""Delete cleanup uses the same binding rules as refinement and Feedback."""

import uuid

from unittest.mock import Mock, call

import pytest

from memos.api.handlers.memory_handler import handle_delete_memories
from memos.api.product_models import DeleteMemoryRequest


@pytest.mark.parametrize("source", ["structured", "legacy", "self", "none"])
def test_delete_resolves_only_separate_working_node(source):
    primary, working = str(uuid.uuid4()), str(uuid.uuid4())
    metadata = {}
    if source == "structured":
        metadata = {"working_binding": working}
    elif source == "legacy":
        metadata = {"background": f"[working_binding:{working}]"}
    elif source == "self":
        metadata = {"background": f"[working_binding:{primary}]", "working_binding": primary}
    cube = Mock()
    cube.text_mem.get_by_ids.return_value = [{"id": primary, "metadata": metadata}]
    result = handle_delete_memories(
        DeleteMemoryRequest(memory_ids=[primary], auto_cleanup_working=True), cube
    )
    assert result.data["status"] == "success"
    expected = [call([primary])]
    if source in {"structured", "legacy"}:
        expected.append(call([working]))
    assert cube.text_mem.delete_by_memory_ids.call_args_list == expected


@pytest.mark.parametrize("failure", ["read", "cleanup", "main", "empty"])
def test_delete_cleanup_keeps_existing_failure_contract(failure):
    primary, working = str(uuid.uuid4()), str(uuid.uuid4())
    cube = Mock()
    cube.text_mem.get_by_ids.return_value = [
        {"id": primary, "metadata": {"working_binding": working}}
    ]
    if failure == "read":
        cube.text_mem.get_by_ids.side_effect = ValueError("read")
    elif failure == "cleanup":
        cube.text_mem.delete_by_memory_ids.side_effect = [None, ValueError("cleanup")]
    elif failure == "main":
        cube.text_mem.delete_by_memory_ids.side_effect = ValueError("main")
    else:
        cube.text_mem.get_by_ids.return_value = []
    result = handle_delete_memories(
        DeleteMemoryRequest(memory_ids=[primary], auto_cleanup_working=True), cube
    )
    assert result.data["status"] == ("failure" if failure == "main" else "success")


def test_delete_file_mode_keeps_scope():
    cube = Mock()
    result = handle_delete_memories(
        DeleteMemoryRequest(file_ids=["file"], writable_cube_ids=["A"]), cube
    )
    assert result.data["status"] == "success"
    cube.text_mem.delete_by_filter.assert_called_once_with(
        writable_cube_ids=["A"], file_ids=["file"]
    )
