"""Fine-transfer Hooks describe the actual Reader result grouping."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.mem_reader.strategy_struct import StrategyStructMemReader
from memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler import (
    MemReadMessageHandler,
)
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.plugins.hook_defs import H
from memos.plugins.hooks import register_hook


class CustomTransferReader(SimpleStructMemReader):
    def fine_transfer_simple_mem(self, *args, **kwargs):
        return self.transfer_result


@pytest.fixture
def captured_operations(clean_hooks):
    captured = []
    register_hook(H.SCHEDULER_MEMORY_OPERATION_AFTER, lambda **kwargs: captured.append(kwargs))
    return captured


def memory(text):
    return TextualMemoryItem(
        memory=text,
        metadata=TreeNodeTextualMemoryMetadata(memory_type="LongTermMemory"),
    )


@pytest.mark.parametrize(
    "reader_class,expected_grouping",
    [
        (SimpleStructMemReader, "per_input"),
        (StrategyStructMemReader, "per_input"),
        (MultiModalStructMemReader, "batch"),
        (CustomTransferReader, "unknown"),
    ],
)
def test_scheduler_hook_reports_reader_grouping_without_changing_results(
    monkeypatch, captured_operations, reader_class, expected_grouping
):
    sources = [memory("first"), memory("missing"), memory("last")]
    enhanced = [memory("first enhanced"), memory("last enhanced")]
    reader = object.__new__(reader_class)
    reader.save_rawfile = False
    reader.graph_db = None
    reader.memory_version_switch = "off"
    reader.transfer_result = [enhanced]

    def process(source, custom_tags, **kwargs):
        if source is sources[1]:
            return None
        return [enhanced[0] if source is sources[0] else enhanced[1]]

    reader._process_transfer_chat_data = process
    reader._process_transfer_multi_modal_data = lambda *args, **kwargs: enhanced
    monkeypatch.setattr(
        "memos.mem_reader.simple_struct.concurrent.futures.as_completed",
        lambda futures: iter(reversed(list(futures))),
    )
    text_mem = Mock()
    text_mem.get.side_effect = sources
    text_mem.add.return_value = [item.id for item in enhanced]
    text_mem.memory_manager.reorganizer.is_reorganize = False
    handler = MemReadMessageHandler(
        SimpleNamespace(get_mem_reader=lambda: reader, services=Mock(), get_mem_cube=Mock())
    )
    handler._process_memories_with_reader(
        mem_ids=[item.id for item in sources],
        user_id="test-user",
        mem_cube_id="test-cube",
        text_mem=text_mem,
        user_name="test-cube",
        operation_context={
            "trace_id": "test-trace",
            "user_id": "test-user",
            "cube_id": "test-cube",
        },
    )

    transfer = next(
        event
        for event in captured_operations
        if event["hook_context"].source == "scheduler.mem_read.fine_transfer_simple_mem"
    )
    assert transfer["operation_input"]["result_grouping"] == expected_grouping
    assert transfer["operation_input"]["memories"] == sources
    if reader_class in (SimpleStructMemReader, StrategyStructMemReader):
        assert transfer["result"] == [[enhanced[0]], [], [enhanced[1]]]
    else:
        assert transfer["result"] == [enhanced]
    text_mem.add.assert_called_once_with(enhanced, user_name="test-cube")
    text_mem.delete.assert_called_once_with([item.id for item in sources], user_name="test-cube")
    text_mem.memory_manager.remove_and_refresh_memory.assert_called_once_with(user_name="test-cube")


def test_scheduler_failed_hook_keeps_grouping_and_original_error(captured_operations):
    error = ValueError("synthetic transfer failure")
    reader = CustomTransferReader.__new__(CustomTransferReader)

    def fail(*args, **kwargs):
        raise error

    reader.fine_transfer_simple_mem = fail
    failed = []
    register_hook(H.SCHEDULER_MEMORY_OPERATION_FAILED, lambda **kwargs: failed.append(kwargs))
    text_mem = Mock()
    text_mem.get.return_value = memory("source")
    handler = MemReadMessageHandler(SimpleNamespace(get_mem_reader=lambda: reader))
    handler._process_memories_with_reader(
        mem_ids=[text_mem.get.return_value.id],
        user_id="test-user",
        mem_cube_id="test-cube",
        text_mem=text_mem,
        user_name="test-cube",
    )
    assert len(failed) == 1
    assert failed[0]["error"] is error
    assert failed[0]["operation_input"]["result_grouping"] == "unknown"
    assert all(
        event["hook_context"].source != "scheduler.mem_read.fine_transfer_simple_mem"
        for event in captured_operations
    )
    text_mem.add.assert_not_called()
