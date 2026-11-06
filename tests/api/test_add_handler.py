"""Unit tests for the AddHandler message validator and feedback flow.

Covers the module-level ``_check_messages`` validator (its pydantic schema is
built once at import time) and the add/feedback routing of
``handle_add_memories``.
"""

from unittest.mock import MagicMock

import pytest

from pydantic import ValidationError, validate_call

from memos.api.handlers.add_handler import AddHandler, _check_messages
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.product_models import APIADDRequest
from memos.types import MessageList


VALID_MESSAGES = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "I am learning ggplot2 in R."},
    {"role": "assistant", "content": "Great! What would you like to know?"},
]


@pytest.fixture
def add_handler():
    """AddHandler with mocked dependencies and a mocked cube view."""
    deps = HandlerDependencies(
        naive_mem_cube=MagicMock(),
        mem_reader=MagicMock(),
        mem_scheduler=MagicMock(),
        feedback_server=MagicMock(),
    )
    handler = AddHandler(deps)
    handler.cube_view = MagicMock()
    handler._build_cube_view = MagicMock(return_value=handler.cube_view)
    return handler


class TestModuleLevelValidator:
    def test_accepts_valid_messages(self):
        _check_messages(VALID_MESSAGES)
        _check_messages([])  # an empty list is still a valid MessageList

    def test_rejects_invalid_messages(self):
        with pytest.raises(ValidationError):
            _check_messages([{"role": "bogus", "content": 12345}])
        with pytest.raises(ValidationError):
            _check_messages("not-a-list")

    def test_matches_legacy_per_request_validator(self):
        """The shared validator behaves exactly like a freshly built one."""

        # Replica of the pre-change pattern: validator defined (and its
        # schema rebuilt) at call time.
        @validate_call
        def legacy_check(messages: MessageList) -> None:
            pass

        battery = [
            VALID_MESSAGES,
            [],
            [{"role": "user", "content": "single"}],
            [{"role": "bogus", "content": 12345}],
            [{"content": "missing role"}],
            [{"role": "user"}],  # missing content
            "not-a-list",
            [None],
            [123],
        ]
        for case in battery:
            legacy_rejected = _raises_validation_error(legacy_check, case)
            module_rejected = _raises_validation_error(_check_messages, case)
            assert legacy_rejected == module_rejected, f"behavior differs for {case!r}"


def _raises_validation_error(func, value) -> bool:
    try:
        func(value)
    except ValidationError:
        return True
    return False


class TestHandleAddMemoriesRouting:
    def test_feedback_flow_with_valid_messages(self, add_handler):
        add_req = APIADDRequest(
            user_id="u1",
            is_feedback=True,
            chat_history=[{"role": "assistant", "content": "prior answer"}],
            messages=[{"role": "user", "content": "please fix that memory"}],
        )
        process_record = {"records": ["r1"]}
        add_handler.cube_view.feedback_memories.return_value = process_record

        response = add_handler.handle_add_memories(add_req)

        assert response.message == "Memory feedback successfully"
        assert response.data == [process_record]
        add_handler.cube_view.feedback_memories.assert_called_once()
        add_handler.cube_view.add_memories.assert_not_called()
        feedback_req = add_handler.cube_view.feedback_memories.call_args[0][0]
        assert feedback_req.feedback_content == "please fix that memory"
        assert feedback_req.history == [{"role": "assistant", "content": "prior answer"}]

    def test_feedback_failure_falls_back_to_regular_add(self, add_handler):
        """Exceptions inside the feedback branch degrade to the add path."""
        add_req = APIADDRequest(
            user_id="u1",
            is_feedback=True,
            chat_history=[{"role": "assistant", "content": "prior"}],
            messages=[{"role": "assistant", "content": "still no user message"}],
        )
        add_handler.cube_view.add_memories.return_value = ["added"]

        response = add_handler.handle_add_memories(add_req)

        # No user-role message -> the feedback branch raises internally,
        # is caught, and the request is handled as a regular add.
        assert response.message == "Memory added successfully"
        assert response.data == ["added"]
        add_handler.cube_view.feedback_memories.assert_not_called()
        add_handler.cube_view.add_memories.assert_called_once()

    def test_non_feedback_add_unchanged(self, add_handler):
        add_req = APIADDRequest(
            user_id="u1",
            messages=[{"role": "user", "content": "hello"}],
        )
        add_handler.cube_view.add_memories.return_value = ["added"]

        response = add_handler.handle_add_memories(add_req)

        assert response.message == "Memory added successfully"
        assert response.data == ["added"]
        add_handler.cube_view.add_memories.assert_called_once()
        add_handler.cube_view.feedback_memories.assert_not_called()
