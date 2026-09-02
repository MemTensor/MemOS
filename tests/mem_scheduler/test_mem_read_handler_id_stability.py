"""
Tests for ID stability in MemReadMessageHandler._process_memories_with_reader.

Bug: in async mode add_memory returns IDs_A, the scheduler later creates
refined memories with new UUIDs (IDs_B), then hard-deletes IDs_A.
Any get_memory(IDs_A) call after the scheduler runs returns 404.

Fix: when fine_transfer_simple_mem returns exactly one enhanced memory per
input (1:1), reuse the original ID on the enhanced item so the caller's
handle remains valid.
"""

from __future__ import annotations

import uuid

from unittest.mock import MagicMock, patch

from memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler import (
    MemReadMessageHandler,
)
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


def _make_fast_item(memory_id: str) -> TextualMemoryItem:
    """Build a fast-mode LongTermMemory item (the kind add_memory writes)."""
    return TextualMemoryItem(
        id=memory_id,
        memory="user likes coffee",
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="LongTermMemory",
            tags=["mode:fast"],
            background=f"[working_binding:{memory_id}] direct built from raw inputs",
        ),
    )


def _make_enhanced_item() -> TextualMemoryItem:
    """Build an enhanced item with a brand-new UUID (simulates current behaviour)."""
    return TextualMemoryItem(
        id=str(uuid.uuid4()),
        memory="user prefers coffee over tea",
        metadata=TreeNodeTextualMemoryMetadata(memory_type="UserMemory"),
    )


def _build_handler(text_mem: MagicMock, mem_reader: MagicMock) -> MemReadMessageHandler:
    """Construct a MemReadMessageHandler backed by mocked collaborators."""
    mem_cube = MagicMock()
    mem_cube.text_mem = text_mem

    scheduler_context = MagicMock()
    scheduler_context.get_mem_cube.return_value = mem_cube
    scheduler_context.get_mem_reader.return_value = mem_reader

    handler = MemReadMessageHandler.__new__(MemReadMessageHandler)
    handler.scheduler_context = scheduler_context
    return handler


# ---------------------------------------------------------------------------
# Helper: common text_mem mock wiring
# ---------------------------------------------------------------------------


def _wire_text_mem(text_mem: MagicMock, original_id: str) -> None:
    fast_item = _make_fast_item(original_id)
    text_mem.get.return_value = fast_item
    # add() returns whatever IDs are in the group — simulate by returning the id
    text_mem.add.side_effect = lambda mem_group, user_name=None: [m.id for m in mem_group]
    text_mem.memory_manager = MagicMock()
    text_mem.memory_manager.remove_and_refresh_memory = MagicMock()


# ---------------------------------------------------------------------------
# Test 1 — 1:1 mapping: original ID must be reused, not deleted
# ---------------------------------------------------------------------------


class TestIdStability1to1:
    def test_enhanced_item_receives_original_id(self):
        """When fine_transfer_simple_mem returns 1 item per input, the enhanced
        item's .id must be set to the original memory ID."""
        original_id = str(uuid.uuid4())

        text_mem = MagicMock()
        _wire_text_mem(text_mem, original_id)

        enhanced_item = _make_enhanced_item()
        new_id_before_fix = enhanced_item.id
        assert new_id_before_fix != original_id  # sanity check

        mem_reader = MagicMock()
        mem_reader.fine_transfer_simple_mem.return_value = [[enhanced_item]]
        mem_reader.save_rawfile = False
        mem_reader.memory_version_switch = "off"
        mem_reader.graph_db = None

        handler = _build_handler(text_mem, mem_reader)

        with patch(
            "memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler.is_playground_api",
            return_value=True,
        ):
            handler._process_memories_with_reader(
                mem_ids=[original_id],
                user_id="u1",
                mem_cube_id="c1",
                text_mem=text_mem,
                user_name="u1",
            )

        # The item passed to text_mem.add must carry the original ID
        add_call_args = text_mem.add.call_args
        assert add_call_args is not None, "text_mem.add was not called"
        added_group = add_call_args[0][0]
        assert len(added_group) == 1
        assert added_group[0].id == original_id, (
            f"Expected enhanced item to be stored under original ID {original_id!r}, "
            f"but got {added_group[0].id!r}"
        )

    def test_original_id_not_deleted_after_reuse(self):
        """When the original ID is reused on the enhanced item it must NOT
        appear in the delete call — deleting a node we just overwrote is wrong."""
        original_id = str(uuid.uuid4())

        text_mem = MagicMock()
        _wire_text_mem(text_mem, original_id)

        enhanced_item = _make_enhanced_item()
        mem_reader = MagicMock()
        mem_reader.fine_transfer_simple_mem.return_value = [[enhanced_item]]
        mem_reader.save_rawfile = False
        mem_reader.memory_version_switch = "off"
        mem_reader.graph_db = None

        handler = _build_handler(text_mem, mem_reader)

        with patch(
            "memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler.is_playground_api",
            return_value=True,
        ):
            handler._process_memories_with_reader(
                mem_ids=[original_id],
                user_id="u1",
                mem_cube_id="c1",
                text_mem=text_mem,
                user_name="u1",
            )

        # Verify the handler ran the happy path (enhanced item was stored)
        assert text_mem.add.called, (
            "text_mem.add was not called — handler may have exited early"
        )

        # delete must not be called with the original_id
        if text_mem.delete.called:
            for c in text_mem.delete.call_args_list:
                deleted = c[0][0] if c[0] else c[1].get("memory_ids", [])
                assert original_id not in deleted, (
                    f"original_id {original_id!r} must not be deleted after it was reused"
                )


# ---------------------------------------------------------------------------
# Test 2 — 1:N mapping: original IDs should still be cleaned up
# ---------------------------------------------------------------------------


class TestIdStability1toN:
    def test_original_id_deleted_when_1_to_many(self):
        """When one input expands to two enhanced memories, the original ID
        can no longer be trivially reused — it must be included in the delete
        list so stale data does not linger."""
        original_id = str(uuid.uuid4())

        text_mem = MagicMock()
        _wire_text_mem(text_mem, original_id)

        enhanced1 = _make_enhanced_item()
        enhanced2 = _make_enhanced_item()
        mem_reader = MagicMock()
        mem_reader.fine_transfer_simple_mem.return_value = [[enhanced1, enhanced2]]
        mem_reader.save_rawfile = False
        mem_reader.memory_version_switch = "off"
        mem_reader.graph_db = None

        handler = _build_handler(text_mem, mem_reader)

        with patch(
            "memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler.is_playground_api",
            return_value=True,
        ):
            handler._process_memories_with_reader(
                mem_ids=[original_id],
                user_id="u1",
                mem_cube_id="c1",
                text_mem=text_mem,
                user_name="u1",
            )

        assert text_mem.delete.called, "delete must be called for 1→N expansion"
        deleted_ids: list[str] = []
        for c in text_mem.delete.call_args_list:
            deleted_ids.extend(c[0][0] if c[0] else c[1].get("memory_ids", []))
        assert original_id in deleted_ids, (
            f"original_id {original_id!r} must be deleted when 1→N expansion occurred"
        )


# ---------------------------------------------------------------------------
# Test 3 — zero processed memories: original IDs should be deleted (unchanged)
# ---------------------------------------------------------------------------


class TestIdStabilityNoOutput:
    def test_original_id_deleted_when_no_enhanced_output(self):
        """When fine_transfer returns an empty list the original raw node should
        still be cleaned up so orphans don't accumulate."""
        original_id = str(uuid.uuid4())

        text_mem = MagicMock()
        _wire_text_mem(text_mem, original_id)

        mem_reader = MagicMock()
        mem_reader.fine_transfer_simple_mem.return_value = []
        mem_reader.save_rawfile = False
        mem_reader.memory_version_switch = "off"
        mem_reader.graph_db = None

        handler = _build_handler(text_mem, mem_reader)

        with patch(
            "memos.mem_scheduler.task_schedule_modules.handlers.mem_read_handler.is_playground_api",
            return_value=True,
        ):
            handler._process_memories_with_reader(
                mem_ids=[original_id],
                user_id="u1",
                mem_cube_id="c1",
                text_mem=text_mem,
                user_name="u1",
            )

        assert text_mem.delete.called, "delete must be called when no enhanced output produced"
        deleted_ids: list[str] = []
        for c in text_mem.delete.call_args_list:
            deleted_ids.extend(c[0][0] if c[0] else c[1].get("memory_ids", []))
        assert original_id in deleted_ids
