import json

import pytest

from memos.project_memory.add_evidence import collect_anchors
from memos.project_memory.add_extraction import extract_episode
from memos.project_memory.judge import ModelError


class Writer:
    def __init__(self, output):
        self.output = output
        self.calls = []

    def write(self, scope, _prompt, inputs):
        self.calls.append((scope, inputs))
        return self.output


def row(mid, role, content, task="task-current", **extra):
    return {
        "message_id": mid,
        "turn_id": "turn-current",
        "role": role,
        "content": content,
        "origin_task_id": task,
        "origin_user_id": "member",
        "chat_time": "2026-11-19T09:00:00+08:00",
        **extra,
    }


def test_decision_authorization_is_current_task_owned_and_quote_is_exact():
    prior = row("prior", "assistant", "建议使用 PG17", "task-prior")
    current = row("now", "user", "🧪 同意，按 PG17 做", role_id="alice")
    output = {
        "episode_summary": "选择 PG17",
        "drafts": [
            {"kind": "decision", "content": "使用 PG17", "message_id": "prior", "quote": "PG17"},
            {"kind": "decision", "content": "使用 PG16", "message_id": "now", "quote": "PG16"},
            {
                "kind": "decision",
                "content": "使用 PG17",
                "message_id": "now",
                "quote": "按 PG17 做",
                "origin": "adopted",
                "context": [{"message_id": "prior", "quote": "建议使用 PG17"}],
                "reason_quote": "生产版本只能用 PG17",
            },
        ],
    }
    writer = Writer(output)
    result = extract_episode(writer, {"id": "episode"}, [current], [prior])
    assert len(writer.calls) == 1
    assert result["extract_status"] == "drafted"
    (draft,) = result["drafts"]
    assert draft["origin_task_id"] == "task-current"
    assert draft["authors"] == ["alice"]
    assert draft["authorizing_evidence_refs"] == [
        {"message_id": "now", "source_path": "/content", "start": 5, "end": 13}
    ]
    assert draft["context_refs"][0]["message_id"] == "prior"
    assert not draft["reason_quote"]


def test_truncation_preserves_original_and_revalidates_anchor_source():
    args = '{"file_path":"src/cache.py","text":"' + "x" * 20000 + '"}'
    messages = [
        row("turn-current", "user", "检查缓存"),
        row(
            "a",
            "assistant",
            "",
            tool_calls=[{"function": {"name": "apply_patch", "arguments": args}}],
        ),
        row("tool", "tool", "head " + "y " * 20000 + "tail"),
    ]
    writer = Writer({"episode_summary": "", "drafts": []})
    result = extract_episode(writer, {"id": "episode"}, messages, input_budget=300)
    serialized = json.dumps(writer.calls[0][1])
    assert "src/cache.py" in serialized
    assert len(serialized) < 1500
    assert result["input_truncations"]
    assert messages[1]["tool_calls"][0]["function"]["arguments"] == args
    observed = collect_anchors(messages)
    source = next(anchor for anchor in observed if anchor["change_kind"] == "modified")
    assert source["status"] == "unresolved"
    (ref,) = source["source_refs"]
    assert args[ref["start"] : ref["end"]] == "src/cache.py"


def test_invalid_model_result_does_not_turn_into_a_skip():
    writer = Writer({"episode_summary": "some text"})
    with pytest.raises(ModelError):
        extract_episode(writer, {"id": "episode"}, [row("msg", "user", "更新项目版本")])
