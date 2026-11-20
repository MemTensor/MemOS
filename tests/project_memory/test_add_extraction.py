import json

import pytest

from memos.project_memory.add_evidence import collect_anchors
from memos.project_memory.add_extraction import extract_episode
from memos.project_memory.judge import ModelError


class Writer:
    def __init__(self, output):
        self.output = output
        self.calls = []
        self.prompts = []

    def write(self, scope, prompt, inputs):
        self.calls.append((scope, inputs))
        self.prompts.append(prompt)
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


def test_draft_rejects_numeric_value_missing_from_the_witness():
    writer = Writer(
        {
            "episode_summary": "调整池容量",
            "drafts": [
                {
                    "kind": "decision",
                    "content": "使用 64 个连接",
                    "message_id": "one",
                    "quote": "确认限制为 32 个连接",
                },
            ],
        }
    )
    with pytest.raises(ModelError, match="no valid evidence"):
        extract_episode(writer, {"id": "episode"}, [row("one", "user", "确认限制为 32 个连接")])


@pytest.mark.parametrize("role", ["user", "tool"])
def test_adoption_requires_a_prior_assistant_proposal(role):
    writer = Writer(
        {
            "episode_summary": "选择版本",
            "drafts": [
                {
                    "kind": "decision",
                    "content": "使用 PG17",
                    "message_id": "adopt",
                    "quote": "同意",
                    "origin": "adopted",
                    "context": [{"message_id": "earlier", "quote": "建议使用 PG17"}],
                },
            ],
        }
    )
    with pytest.raises(ModelError, match="no valid evidence"):
        extract_episode(
            writer,
            {"id": "episode"},
            [row("adopt", "user", "同意")],
            [row("earlier", role, "建议使用 PG17", "earlier-task")],
        )


def test_listed_disclosures_use_actual_assistant_text_before_authorization():
    first = "Use a single large export."
    second = "Use multiple small exports."
    future = "Use a timed export."
    decision = "Choose multiple small exports."
    earlier = row(
        "earlier",
        "assistant",
        f"Alternatives: {first} {second}",
        chat_time="2026-11-19T09:00:00+08:00",
        turn_id="turn-1",
    )
    arrived_late = row(
        "future", "assistant", future, chat_time="2026-11-19T09:05:00+08:00", turn_id="turn-2"
    )
    author = row("member", "user", decision, role_id="owner", chat_time="2026-11-19T09:04:00+08:00")
    writer = Writer(
        {
            "episode_summary": decision,
            "drafts": [
                {
                    "kind": "decision",
                    "message_id": "member",
                    "content": decision,
                    "quote": decision,
                    "final": True,
                    "listed": [first, second, future, "A nonexistent option."],
                }
            ],
        }
    )

    result = extract_episode(writer, {"id": "episode"}, [earlier, arrived_late, author])

    assert result["drafts"][0]["listed"] == [first, second]


def test_extraction_prompt_preserves_the_source_numeral_and_unit():
    quote = "重试次数限制为三次"
    current = row("member", "user", quote)
    later = row("assistant", "assistant", "限制为 3 次", chat_time="2026-11-19T09:01:00+08:00")
    draft = {
        "kind": "decision",
        "content": quote,
        "message_id": "member",
        "quote": quote,
        "key_values": ["三次", "3 次"],
    }
    writer = Writer({"episode_summary": quote, "drafts": [draft]})

    result = extract_episode(writer, {"id": "episode"}, [current, later])

    assert "原样保留数量和单位" in writer.prompts[0]
    assert result["drafts"][0]["content"] == quote
    assert result["drafts"][0]["key_values"] == ["三次"]
    for unsupported in ("重试次数限制为 3 次", "重试次数限制为 4 次"):
        draft["content"] = unsupported
        with pytest.raises(ModelError, match="no valid evidence"):
            extract_episode(writer, {"id": "episode"}, [current, later])


def test_quote_ref_tolerates_whitespace_layout_but_never_guesses():
    from memos.project_memory.add_evidence import quote_ref

    message = {"message_id": "m1", "content": "早班 6 点发车，\n迟到 10 分钟\n  就取消。"}
    ref = quote_ref(message, "迟到 10 分钟 就取消。")
    assert ref is not None
    assert message["content"][ref["start"] : ref["end"]] == "迟到 10 分钟\n  就取消。"
    assert quote_ref(message, "早班 7 点发车") is None
    repeated = {"message_id": "m2", "content": "好的\n好的"}
    assert quote_ref(repeated, "好的 好的") is not None
    assert quote_ref({"message_id": "m3", "content": "ok  ok"}, "ok") is not None
    assert quote_ref({"message_id": "m4", "content": "a b\na b"}, "a  b") is None
