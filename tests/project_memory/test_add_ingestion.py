from datetime import datetime, timezone

import pytest

from memos.project_memory.add_ingestion import AddRequestError, normalize_turns


def _normalize(messages):
    return normalize_turns(messages, "task", "member", {}, datetime.now(timezone.utc))


@pytest.mark.parametrize("text_blocks", [False, True])
def test_tool_output_escapes_nul_without_changing_source_identity(text_blocks):
    raw = "路径 C:\\tmp\\x00\n" + "\x00result" * 7
    expected = "路径 C:\\\\tmp\\\\x00\n" + r"\x00result" * 7
    call = {"id": "call", "type": "function", "function": {"name": "read", "arguments": "{}"}}
    messages = [
        {"role": "user", "content": "Read a file"},
        {"role": "assistant", "tool_calls": [call]},
        {
            "role": "tool",
            "message_id": "result",
            "tool_call_id": "call",
            "content": [{"type": "text", "text": raw}] if text_blocks else raw,
        },
    ]

    first = _normalize(messages)[0][-1]
    assert first["content"] == expected
    assert first["message_id"] == "result"
    assert first["tool_call_id"] == "call"
    assert first["tool_calls"] == [call]
    assert _normalize(messages)[0][-1]["content_sha256"] == first["content_sha256"]
    assert messages[-1]["content"] == ([{"type": "text", "text": raw}] if text_blocks else raw)

    messages[-1]["content"] = expected
    literal = _normalize(messages)[0][-1]
    assert literal["content"] == expected
    assert literal["content_sha256"] != first["content_sha256"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("content", "not supported \x00"),
        ("message_id", "message\x00"),
        ("role_id", "member\x00"),
        ("role_name", "name\x00"),
        ("tool_call_id", "call\x00"),
        ("experience_notes", [{"note": "nested\x00"}]),
        ("experience_notes", {"key\x00": "value"}),
    ],
)
def test_unstorable_message_fields_report_original_message_number(field, value):
    messages = [
        {"role": "user", "content": "Start"},
        {"role": "assistant", "content": "Continue", field: value},
    ]

    with pytest.raises(AddRequestError, match=rf"message 2 {field} contains a NUL") as error:
        _normalize(messages)

    assert error.value.status_code == 422
    assert error.value.reason == "INVALID_PARAMS"


@pytest.mark.parametrize("with_result", [False, True])
def test_unstorable_tool_arguments_report_the_original_call_message(with_result):
    call = {
        "id": "call",
        "type": "function",
        "function": {"name": "read", "arguments": "raw\x00value"},
    }
    messages = [
        {"role": "user", "content": "Read a file"},
        {"role": "assistant", "tool_calls": [call]},
    ]
    if with_result:
        messages.append({"role": "tool", "tool_call_id": "call", "content": "File read"})

    with pytest.raises(AddRequestError, match="message 2 tool_calls contains a NUL") as error:
        _normalize(messages)

    assert error.value.status_code == 422
    assert error.value.reason == "INVALID_PARAMS"
