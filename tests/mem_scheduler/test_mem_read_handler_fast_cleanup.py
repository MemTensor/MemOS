from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock


def _make_text_item(item_id: str, memory: str):
    metadata = SimpleNamespace(
        memory_type="LongTermMemory",
        info={},
        key=None,
        status="activated",
        confidence=0.9,
        tags=[],
    )
    return SimpleNamespace(id=item_id, memory=memory, metadata=metadata)


class _FakeTextMem:
    def __init__(self, items):
        self._items = {item.id: item for item in items}
        self.delete_calls: list = []
        self.soft_delete_calls: list = []
        self.memory_manager = SimpleNamespace(
            reorganizer=None,
            remove_and_refresh_memory=lambda **kwargs: None,
        )

    def get(self, mem_id, user_name=None):
        return self._items[mem_id]

    def delete(self, ids, user_name=None):
        self.delete_calls.append((list(ids), user_name))

    def soft_delete(self, *args, **kwargs):
        self.soft_delete_calls.append((args, kwargs))


def _build_handler(*, memory_version_switch: str):
    from memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler import (
        MemReadMessageHandler,
    )

    raw_item = _make_text_item("raw_1", "raw chunk")
    text_mem = _FakeTextMem([raw_item])
    mem_cube = SimpleNamespace(text_mem=text_mem)

    mem_reader = MagicMock()
    mem_reader.fine_transfer_simple_mem.side_effect = RuntimeError("fine extraction failed")
    mem_reader.memory_version_switch = memory_version_switch
    mem_reader.graph_db = None
    mem_reader.save_rawfile = False

    services = SimpleNamespace(
        create_event_log=lambda **kwargs: SimpleNamespace(**kwargs),
        submit_web_logs=lambda events, **kwargs: None,
        map_memcube_name=lambda mem_cube_id: "UserMemCube",
        submit_messages=lambda messages: None,
    )
    scheduler_context = SimpleNamespace(
        get_mem_cube=lambda: mem_cube,
        get_mem_reader=lambda: mem_reader,
        services=services,
    )

    handler = MemReadMessageHandler.__new__(MemReadMessageHandler)
    handler.scheduler_context = scheduler_context
    return handler, text_mem


def test_fine_transfer_error_does_not_delete_fast_memory():
    handler, text_mem = _build_handler(memory_version_switch="off")

    handler._process_memories_with_reader(
        mem_ids=["raw_1"],
        user_id="user_1",
        mem_cube_id="cube_1",
        text_mem=text_mem,
        user_name="cube_1",
        info={"trigger_source": "Messages"},
    )

    assert text_mem.delete_calls == []
    assert text_mem.soft_delete_calls == []


def test_fine_transfer_error_does_not_soft_delete_fast_memory_with_versions():
    handler, text_mem = _build_handler(memory_version_switch="on")

    handler._process_memories_with_reader(
        mem_ids=["raw_1"],
        user_id="user_1",
        mem_cube_id="cube_1",
        text_mem=text_mem,
        user_name="cube_1",
        info={"trigger_source": "Messages"},
    )

    assert text_mem.delete_calls == []
    assert text_mem.soft_delete_calls == []
