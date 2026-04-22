from unittest.mock import Mock

from memos.api.handlers.memory_handler import handle_delete_memories
from memos.api.product_models import DeleteMemoryRequest


def _build_naive_mem_cube() -> Mock:
    naive_mem_cube = Mock()
    naive_mem_cube.text_mem = Mock()
    naive_mem_cube.pref_mem = Mock()
    return naive_mem_cube


def test_delete_memories_quick_by_user_id():
    naive_mem_cube = _build_naive_mem_cube()
    req = DeleteMemoryRequest(user_id="u_1")

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "success"
    naive_mem_cube.text_mem.delete_by_filter.assert_called_once_with(
        writable_cube_ids=None,
        filter={"and": [{"user_id": "u_1"}]},
    )
    naive_mem_cube.pref_mem.delete_by_filter.assert_called_once_with(
        filter={"and": [{"user_id": "u_1"}]}
    )


def test_delete_memories_quick_by_conversation_alias():
    naive_mem_cube = _build_naive_mem_cube()
    req = DeleteMemoryRequest(conversation_id="conv_1")

    assert req.session_id == "conv_1"

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "success"
    naive_mem_cube.text_mem.delete_by_filter.assert_called_once_with(
        writable_cube_ids=None,
        filter={"and": [{"session_id": "conv_1"}]},
    )
    naive_mem_cube.pref_mem.delete_by_filter.assert_called_once_with(
        filter={"and": [{"session_id": "conv_1"}]}
    )


def test_delete_memories_filter_and_quick_conditions():
    naive_mem_cube = _build_naive_mem_cube()
    req = DeleteMemoryRequest(
        filter={"and": [{"memory_type": "WorkingMemory"}]},
        user_id="u_1",
        session_id="s_1",
    )

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "success"
    naive_mem_cube.text_mem.delete_by_filter.assert_called_once_with(
        writable_cube_ids=None,
        filter={
            "and": [
                {"memory_type": "WorkingMemory"},
                {"user_id": "u_1", "session_id": "s_1"},
            ]
        },
    )
    naive_mem_cube.pref_mem.delete_by_filter.assert_called_once_with(
        filter={
            "and": [
                {"memory_type": "WorkingMemory"},
                {"user_id": "u_1", "session_id": "s_1"},
            ]
        }
    )


def test_delete_memories_filter_or_with_distribution():
    naive_mem_cube = _build_naive_mem_cube()
    req = DeleteMemoryRequest(
        filter={"or": [{"memory_type": "WorkingMemory"}, {"memory_type": "UserMemory"}]},
        user_id="u_1",
    )

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "success"
    naive_mem_cube.text_mem.delete_by_filter.assert_called_once_with(
        writable_cube_ids=None,
        filter={
            "or": [
                {"memory_type": "WorkingMemory", "user_id": "u_1"},
                {"memory_type": "UserMemory", "user_id": "u_1"},
            ]
        },
    )
    naive_mem_cube.pref_mem.delete_by_filter.assert_called_once_with(
        filter={
            "or": [
                {"memory_type": "WorkingMemory", "user_id": "u_1"},
                {"memory_type": "UserMemory", "user_id": "u_1"},
            ]
        }
    )


def test_delete_memories_reject_multiple_modes():
    naive_mem_cube = _build_naive_mem_cube()
    req = DeleteMemoryRequest(memory_ids=["m_1"], user_id="u_1")

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "failure"
    assert "Exactly one delete mode must be provided" in resp.message
    naive_mem_cube.text_mem.delete_by_filter.assert_not_called()
    naive_mem_cube.text_mem.delete_by_memory_ids.assert_not_called()


def test_delete_memories_reject_empty_filter():
    naive_mem_cube = _build_naive_mem_cube()
    req = DeleteMemoryRequest(filter={})

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "failure"
    assert "filter cannot be empty" in resp.message
    naive_mem_cube.text_mem.delete_by_filter.assert_not_called()
    naive_mem_cube.pref_mem.delete_by_filter.assert_not_called()


def test_delete_memories_with_pref_mem_disabled():
    naive_mem_cube = _build_naive_mem_cube()
    naive_mem_cube.pref_mem = None
    req = DeleteMemoryRequest(user_id="u_1")

    resp = handle_delete_memories(req, naive_mem_cube)

    assert resp.data["status"] == "success"
    naive_mem_cube.text_mem.delete_by_filter.assert_called_once_with(
        writable_cube_ids=None,
        filter={"and": [{"user_id": "u_1"}]},
    )
