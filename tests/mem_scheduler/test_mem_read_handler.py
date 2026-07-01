from types import SimpleNamespace
from unittest.mock import MagicMock

from memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler import (
    MemReadMessageHandler,
)


def test_mem_read_handler_keeps_fast_memories_when_transfer_fails():
    mem_reader = MagicMock()
    mem_reader.fine_transfer_simple_mem.side_effect = RuntimeError("extract failed")
    mem_reader.memory_version_switch = "off"

    raw_memory = SimpleNamespace(
        memory="raw user message",
        metadata=SimpleNamespace(background="", memory_type="LongTermMemory"),
    )

    text_mem = MagicMock()
    text_mem.get.return_value = raw_memory
    text_mem.memory_manager = SimpleNamespace(
        remove_and_refresh_memory=MagicMock(),
    )

    scheduler_context = MagicMock()
    scheduler_context.get_mem_reader.return_value = mem_reader

    handler = MemReadMessageHandler(scheduler_context)
    handler._process_memories_with_reader(
        mem_ids=["fast-1"],
        user_id="user-1",
        mem_cube_id="cube-1",
        text_mem=text_mem,
        user_name="alice",
    )

    text_mem.delete.assert_not_called()
    text_mem.soft_delete.assert_not_called()
