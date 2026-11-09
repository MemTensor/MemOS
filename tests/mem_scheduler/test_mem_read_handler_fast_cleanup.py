from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock


def _make_text_item(
    item_id: str,
    memory: str,
    *,
    memory_type: str = "LongTermMemory",
    key: str | None = None,
    info: dict | None = None,
):
    metadata = SimpleNamespace(
        memory_type=memory_type,
        info=info if info is not None else {},
        key=key,
        status="activated",
        confidence=0.9,
        tags=[],
    )
    return SimpleNamespace(id=item_id, memory=memory, metadata=metadata)


class _FakeTextMem:
    def __init__(self, items, added_ids: list[str] | None = None):
        self._items = {item.id: item for item in items}
        self._added_ids = added_ids
        self.add_calls: list = []
        self.delete_calls: list = []
        self.soft_delete_calls: list = []
        self.memory_manager = SimpleNamespace(
            reorganizer=None,
            remove_and_refresh_memory=lambda **kwargs: None,
        )

    def get(self, mem_id, user_name=None):
        return self._items[mem_id]

    def add(self, memories, user_name=None):
        mem_list = list(memories)
        self.add_calls.append((mem_list, user_name))
        if self._added_ids is not None:
            return list(self._added_ids)
        return [item.id for item in mem_list]

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


def test_playground_legacy_events_align_enhanced_ids_with_filtered_mem_group(monkeypatch):
    import memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler as handler_module

    from memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler import (
        MemReadMessageHandler,
    )

    monkeypatch.setattr(handler_module, "is_playground_api", lambda: True)

    raw_chunk = _make_text_item("raw_1", "raw chunk")
    raw_file_mem = _make_text_item(
        "raw_file_1",
        "raw file content",
        memory_type="RawFileMemory",
        key="raw-file-key",
    )
    added_mem = _make_text_item(
        "mem_add_1",
        "user prefers dark mode",
        memory_type="LongTermMemory",
        key="theme-pref",
    )
    updated_mem = _make_text_item(
        "mem_upd_1",
        "user lives in Shanghai",
        memory_type="UserMemory",
        key="city-pref",
        info={"merged_from": ["old_mem_1"]},
    )

    text_mem = _FakeTextMem(
        [raw_chunk],
        added_ids=["enhanced_id_add_1", "enhanced_id_upd_1"],
    )
    mem_cube = SimpleNamespace(text_mem=text_mem)

    mem_reader = MagicMock()
    mem_reader.fine_transfer_simple_mem.return_value = [[raw_file_mem, added_mem, updated_mem]]
    mem_reader.memory_version_switch = "off"
    mem_reader.graph_db = None
    mem_reader.save_rawfile = False

    submitted_events: list = []
    services = SimpleNamespace(
        create_event_log=lambda **kwargs: SimpleNamespace(**kwargs),
        submit_web_logs=lambda events, **kwargs: submitted_events.extend(events),
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

    handler._process_memories_with_reader(
        mem_ids=["raw_1"],
        user_id="user_1",
        mem_cube_id="cube_1",
        text_mem=text_mem,
        user_name="cube_1",
        task_id="task_1",
        info={"trigger_source": "Messages"},
    )

    assert len(text_mem.add_calls) == 1
    assert text_mem.add_calls[0] == ([added_mem, updated_mem], "cube_1")

    assert len(submitted_events) == 2
    add_event, update_event = submitted_events

    assert add_event.label == "addMemory"
    assert add_event.task_id == "task_1"
    assert add_event.memory_len == 1
    assert add_event.memcube_log_content == [
        {
            "content": "theme-pref: user prefers dark mode",
            "ref_id": "enhanced_id_add_1",
        }
    ]
    assert add_event.metadata == [
        {
            "ref_id": "enhanced_id_add_1",
            "id": "enhanced_id_add_1",
            "key": "theme-pref",
            "memory": "user prefers dark mode",
            "memory_type": "LongTermMemory",
            "status": "activated",
            "confidence": 0.9,
            "tags": [],
            "updated_at": None,
        }
    ]

    assert update_event.label == "updateMemory"
    assert update_event.task_id == "task_1"
    assert update_event.memory_len == 1
    assert update_event.memcube_log_content == [
        {
            "content": "city-pref: user lives in Shanghai",
            "ref_id": "enhanced_id_upd_1",
        }
    ]
    assert update_event.metadata == [
        {
            "ref_id": "enhanced_id_upd_1",
            "id": "enhanced_id_upd_1",
            "key": "city-pref",
            "memory": "user lives in Shanghai",
            "memory_type": "UserMemory",
            "status": "activated",
            "confidence": 0.9,
            "tags": [],
            "updated_at": None,
        }
    ]
