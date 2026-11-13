"""Successful Feedback tasks preserve existing knowledge-base event formats."""

import json

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler import (
    FeedbackMessageHandler,
)


@pytest.mark.parametrize("playground", [False, True])
@pytest.mark.parametrize("decoded", [False, True])
def test_feedback_records_emit_only_complete_changes(monkeypatch, playground, decoded):
    monkeypatch.setattr(
        "memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler.is_playground_api",
        lambda: playground,
    )
    context = Mock()
    context.get_feedback_server.return_value.process_feedback.return_value = {
        "record": {
            "add": [
                {"id": "a", "memory": "one", "source_doc_id": "doc"},
                {"id": "b", "text": "two"},
                SimpleNamespace(id="c", memory="three", origin_memory="old"),
                {"id": "missing-memory"},
                {"memory": "missing-id"},
            ],
            "update": [
                {"id": "d", "memory": "after", "origin_memory": "before"},
                {"id": "e", "text": "after", "old_memory": "before"},
                SimpleNamespace(id="f", memory="after", origin_memory="before"),
                {"id": "g", "text": "after", "original_content": "before"},
                {"id": "missing-memory"},
                {},
            ],
        }
    }
    handler = FeedbackMessageHandler(context)
    payload = {"feedback_content": "change", "task_id": "business"}
    message = ScheduleMessageItem(
        user_id="u", mem_cube_id="A", label="mem_feedback", content=json.dumps(payload)
    )
    if decoded:
        message = message.model_copy(update={"content": payload})
    handler.process_single_feedback(message)
    if playground:
        context.services.create_event_log.assert_not_called()
    else:
        event = context.services.create_event_log.call_args.kwargs
        changes = event["memcube_log_content"]
        assert [item["memory_id"] for item in changes] == list("abcdefg")
        assert [item["operation"] for item in changes] == ["ADD"] * 3 + ["UPDATE"] * 4
        assert all(item["original_content"] == "before" for item in changes[3:])
        assert changes[0]["source_doc_id"] == "doc"
        assert event["memory_len"] == 7
        assert context.services.create_event_log.return_value.task_id == "business"
        context.services.submit_web_logs.assert_called_once()


@pytest.mark.parametrize(
    "result", [None, {}, {"record": None}, {"record": {"add": None, "update": []}}]
)
def test_empty_feedback_records_emit_no_content_event(monkeypatch, result):
    monkeypatch.setattr(
        "memos.mem_scheduler.task_schedule_modules.handlers.feedback_handler.is_playground_api",
        lambda: False,
    )
    context = Mock()
    context.get_feedback_server.return_value.process_feedback.return_value = result
    handler = FeedbackMessageHandler(context)
    message = ScheduleMessageItem(
        user_id="u", mem_cube_id="A", label="mem_feedback", content="{}", task_id="fallback"
    )
    handler.process_single_feedback(message)
    assert (
        context.get_feedback_server.return_value.process_feedback.call_args.kwargs["task_id"]
        == "fallback"
    )
    context.services.create_event_log.assert_not_called()
