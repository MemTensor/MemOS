"""Scheduler Hook contracts and their MemRead integration points."""

from unittest.mock import MagicMock

import pytest

from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler import (
    MemReadMessageHandler,
)
from memos.mem_scheduler.task_schedule_modules.operation_observer import (
    SchedulerOperationObserver,
)
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree import TreeTextMemory
from memos.plugins.hook_defs import H, get_hook_spec
from memos.plugins.hooks import register_hook


pytestmark = pytest.mark.usefixtures("clean_hooks")

RAW_MEMORY_ID = "00000000-0000-0000-0000-000000000001"
ENHANCED_MEMORY_ID = "00000000-0000-0000-0000-000000000002"
SCHEDULER_ITEM_ID = "00000000-0000-0000-0000-000000000003"
OPERATION_SOURCE = {
    "fine": "fine_transfer_simple_mem",
    "add": "add_enhanced_memories",
    "delete": "remove_memories",
    "soft_delete": "remove_memories",
}


def _memory(memory_id, memory_type, *, merged_from=None):
    return TextualMemoryItem(
        id=memory_id,
        memory=f"{memory_type} content",
        metadata=TreeNodeTextualMemoryMetadata(
            user_id="alice",
            session_id="session-1",
            memory_type=memory_type,
            sources=[],
            info={"merged_from": merged_from} if merged_from else {},
        ),
    )


def _mem_read_dependencies(memory_version_switch):
    raw_memory = _memory(RAW_MEMORY_ID, "WorkingMemory")
    enhanced_memory = _memory(
        ENHANCED_MEMORY_ID,
        "LongTermMemory",
        merged_from=RAW_MEMORY_ID,
    )

    reader = MagicMock()
    reader.fine_transfer_simple_mem.return_value = [[enhanced_memory]]
    reader.save_rawfile = False
    reader.memory_version_switch = memory_version_switch

    text_memory = MagicMock()
    text_memory.__class__ = TreeTextMemory
    text_memory.get.return_value = raw_memory
    text_memory.add.return_value = [ENHANCED_MEMORY_ID]
    text_memory.memory_manager.reorganizer.is_reorganize = False

    scheduler_context = MagicMock()
    scheduler_context.get_mem_reader.return_value = reader
    scheduler_context.get_mem_cube.return_value.text_mem = text_memory
    scheduler_context.services.create_event_log.return_value = MagicMock()

    message = ScheduleMessageItem(
        item_id=SCHEDULER_ITEM_ID,
        user_id="alice",
        trace_id="trace-1",
        mem_cube_id="cube-1",
        session_id="session-1",
        label="mem_read",
        content=f'["{RAW_MEMORY_ID}"]',
        user_name="cube-1",
        task_id="task-1",
    )
    return MemReadMessageHandler(scheduler_context), reader, text_memory, message


def test_mem_read_handler_uses_replaced_transfer_results_and_stored_ids(monkeypatch):
    handler, _reader, text_memory, message = _mem_read_dependencies("off")
    replacement = _memory("00000000-0000-0000-0000-000000000004", "LongTermMemory")
    stored_id = "00000000-0000-0000-0000-000000000005"
    text_memory.memory_manager.reorganizer.is_reorganize = True
    monkeypatch.setattr(
        "memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler.is_playground_api",
        lambda: False,
    )

    def replace_result(*, operation, result, **_kwargs):
        if operation == "fine":
            return [[replacement]]
        if operation == "add":
            return [stored_id]
        return result

    register_hook(H.SCHEDULER_MEMORY_OPERATION_AFTER, replace_result)
    handler._process_memories_with_reader(
        mem_ids=[RAW_MEMORY_ID],
        user_id="alice",
        mem_cube_id="cube-1",
        text_mem=text_memory,
        user_name="cube-1",
        operation_context=message.model_dump(),
    )

    text_memory.add.assert_called_once_with([replacement], user_name="cube-1")
    submitted = handler.scheduler_context.services.submit_messages.call_args.args[0]
    assert submitted[0].content == f'["{stored_id}"]'


def test_scheduler_observer_pipes_result_and_exposes_operation_contract():
    captured = {}

    def replace_result(**kwargs):
        captured.update(kwargs)
        return ["plugin-result"]

    register_hook(H.SCHEDULER_MEMORY_OPERATION_AFTER, replace_result)

    with SchedulerOperationObserver(
        source="scheduler.mem_read.add_enhanced_memories",
        operation="add",
        operation_context={"trace_id": "trace-1", "task_id": "task-1"},
        operation_input={"memory_ids": ["memory-1"]},
    ) as observer:
        observer.result(["stored-1"])

    assert observer.value == ["plugin-result"]
    assert captured["operation"] == "add"
    assert set(captured) == set(get_hook_spec(H.SCHEDULER_MEMORY_OPERATION_AFTER).params)
    assert captured["operation_input"] == {"memory_ids": ["memory-1"]}
    assert captured["result"] == ["stored-1"]
    assert captured["hook_context"].source == "scheduler.mem_read.add_enhanced_memories"


def test_scheduler_observer_reports_failure_and_preserves_error():
    error = ValueError("scheduler operation failed")
    events = []
    register_hook(
        H.SCHEDULER_MEMORY_OPERATION_FAILED,
        lambda **kwargs: events.append(("failed", kwargs)),
    )
    register_hook(
        H.SCHEDULER_MEMORY_OPERATION_AFTER,
        lambda **kwargs: events.append(("after", kwargs)),
    )
    observer = SchedulerOperationObserver(
        source="scheduler.mem_read.fine_transfer_simple_mem",
        operation="fine",
        operation_context={"trace_id": "trace-1", "mem_cube_id": "cube-1"},
        operation_input={"memory_ids": ["memory-1"]},
        capture_failure=True,
    )

    with pytest.raises(ValueError, match="scheduler operation failed") as exc_info, observer:
        raise error

    assert exc_info.value is error
    assert [stage for stage, _kwargs in events] == ["failed"]
    failure = events[0][1]
    assert failure["error"] is error
    assert set(failure) == set(get_hook_spec(H.SCHEDULER_MEMORY_OPERATION_FAILED).params)
    assert failure["hook_context"].cube_ids == ("cube-1",)


@pytest.mark.parametrize(
    ("memory_version_switch", "expected_operations"),
    [
        ("off", ["fine", "add", "delete"]),
        ("on", ["fine", "add", "soft_delete"]),
    ],
)
@pytest.mark.parametrize("task_id", ["task-1", None])
def test_mem_read_handler_exposes_each_memory_operation(
    memory_version_switch,
    expected_operations,
    task_id,
    monkeypatch,
):
    handler, reader, text_memory, message = _mem_read_dependencies(memory_version_switch)
    message.task_id = task_id
    message.redis_message_id = "synthetic-redis-id"
    message.info = {"custom_tags": ["synthetic-tag"], "is_upload_skill": True}
    message.chat_history = [{"role": "user", "content": "synthetic history"}]
    monkeypatch.setattr(
        ScheduleMessageItem,
        "model_dump",
        MagicMock(
            side_effect=AssertionError("Correlation metadata must not dump message payloads")
        ),
    )
    events = []
    monkeypatch.setattr(
        "memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler.is_playground_api",
        lambda: False,
    )

    def record_operation(**kwargs):
        events.append(kwargs)
        return kwargs["result"]

    register_hook(H.SCHEDULER_MEMORY_OPERATION_AFTER, record_operation)

    handler.process_message(message)

    assert [event["operation"] for event in events] == expected_operations
    assert [event["hook_context"].source for event in events] == [
        f"scheduler.mem_read.{OPERATION_SOURCE[operation]}" for operation in expected_operations
    ]
    for event in events:
        context = event["hook_context"]
        assert context.trace_id == "trace-1"
        assert context.user_id == "alice"
        assert context.session_id == "session-1"
        assert context.task_id == task_id
        assert context.cube_ids == ("cube-1",)
        assert context.attributes == {"scheduler_item_id": SCHEDULER_ITEM_ID, "label": "mem_read"}

    inputs = {event["operation"]: event["operation_input"] for event in events}
    assert inputs["fine"]["memories"][0].id == RAW_MEMORY_ID
    assert inputs["fine"]["type"] == "chat"
    fine_input = inputs["fine"]
    reader.fine_transfer_simple_mem.assert_called_once_with(
        fine_input["memories"],
        type=fine_input["type"],
        custom_tags=fine_input["custom_tags"],
        user_name=fine_input["user_name"],
        chat_history=fine_input["chat_history"],
        user_context=fine_input["user_context"],
        is_upload_skill=fine_input["is_upload_skill"],
    )
    assert fine_input["custom_tags"] == ["synthetic-tag"]
    assert fine_input["chat_history"] == message.chat_history
    assert fine_input["is_upload_skill"] is True
    assert inputs["add"]["memories"][0].id == ENHANCED_MEMORY_ID
    assert inputs["add"]["user_name"] == "cube-1"

    if memory_version_switch == "off":
        assert inputs["delete"] == {"memory_ids": [RAW_MEMORY_ID], "user_name": "cube-1"}
        reader.graph_db.update_node.assert_called_once_with(
            RAW_MEMORY_ID,
            {"status": "archived"},
            user_name="cube-1",
        )
        text_memory.delete.assert_called_once_with([RAW_MEMORY_ID], user_name="cube-1")
        text_memory.soft_delete.assert_not_called()
    else:
        assert inputs["soft_delete"] == {
            "memory_ids": [RAW_MEMORY_ID],
            "user_name": "cube-1",
            "preserved_memory_ids": [ENHANCED_MEMORY_ID],
        }
        reader.graph_db.update_node.assert_not_called()
        text_memory.delete.assert_not_called()
        text_memory.soft_delete.assert_called_once_with(
            [RAW_MEMORY_ID],
            "cube-1",
            [ENHANCED_MEMORY_ID],
        )
