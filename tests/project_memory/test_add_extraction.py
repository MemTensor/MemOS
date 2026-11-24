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
    result = extract_episode(
        writer, {"id": "episode"}, [row("one", "user", "确认限制为 32 个连接")]
    )
    assert result["drafts"] == []
    assert result["extract_status"] == "skipped"
    assert result["dropped_drafts"] == 1


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
    result = extract_episode(
        writer,
        {"id": "episode"},
        [row("adopt", "user", "同意")],
        [row("earlier", role, "建议使用 PG17", "earlier-task")],
    )
    assert result["drafts"] == []
    assert result["dropped_drafts"] == 1


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
        assert extract_episode(writer, {"id": "episode"}, [current, later])["drafts"] == []


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


def test_draft_preserves_original_whitespace_in_source_and_reason_quotes():
    source_quote = "Updated the\u00a0connection pool."
    reason_quote = "It was\n  saturated."
    current = [
        row("member", "user", "Update the pool."),
        row(
            "assistant",
            "assistant",
            f"Reason: {reason_quote}",
            tool_calls=[
                {"function": {"name": "record_result", "arguments": f"Result: {source_quote}"}}
            ],
        ),
    ]
    writer = Writer(
        {
            "episode_summary": "Connection pool updated",
            "drafts": [
                {
                    "kind": "timeline",
                    "content": "Connection pool updated",
                    "message_id": "assistant",
                    "source_path": "/tool_calls/0/function/arguments",
                    "quote": "Updated the connection pool.",
                    "reason_quote": "It was saturated.",
                }
            ],
        }
    )

    (draft,) = extract_episode(writer, {"id": "episode"}, current)["drafts"]

    assert draft["quote"] == draft["evidence"][0]["quote"] == source_quote
    assert draft["reason_quote"] == draft["evidence"][1]["quote"] == reason_quote


def test_extraction_prompt_excludes_reply_style_and_execution_steps():
    from memos.project_memory.add_extraction import _EXTRACT

    assert "Agent 回复格式或表达方式的要求" in _EXTRACT
    assert "执行步骤" in _EXTRACT


def test_extraction_prompt_keeps_stated_reasons_and_guides_timeline_and_experience():
    from memos.project_memory.add_extraction import _EXTRACT

    assert "把原因随结论写进 content" in _EXTRACT
    assert "已撤回" in _EXTRACT
    assert "排查或试错后得到的、可复用的做法" in _EXTRACT


def _restated_decision(context):
    return {
        "episode_summary": "dry-run 后不搬 export",
        "drafts": [
            {
                "kind": "decision",
                "content": "月报用不上 export，那份拷贝不再恢复，也不往 ledger 搬。",
                "message_id": "reply",
                "quote": "月报用不上 export，那份拷贝不再恢复，也不往 ledger 搬。",
                "origin": "adopted",
                "context": context,
            }
        ],
    }


def test_agent_restated_decision_is_anchored_to_the_member_instruction():
    member = row("ask", "user", "dry-run 报告出来了，export 在月报里用不上。")
    reply = row(
        "reply", "assistant", "看了报告：月报用不上 export，那份拷贝不再恢复，也不往 ledger 搬。"
    )
    writer = Writer(_restated_decision([{"message_id": "ask", "quote": "export 在月报里用不上"}]))
    (draft,) = extract_episode(writer, {"id": "episode"}, [member, reply])["drafts"]
    assert draft["origin"] == "member"
    assert draft["quote"] == "export 在月报里用不上"
    assert draft["source_refs"][0]["message_id"] == "ask"
    assert draft["authorizing_evidence_refs"] == draft["source_refs"]


def test_agent_decision_without_the_member_instruction_is_still_dropped():
    member = row("ask", "user", "看一下报告。")
    reply = row("reply", "assistant", "月报用不上 export，那份拷贝不再恢复，也不往 ledger 搬。")
    writer = Writer(_restated_decision([]))
    result = extract_episode(writer, {"id": "episode"}, [member, reply])
    assert result["drafts"] == []
    assert result["dropped_drafts"] == 1


@pytest.mark.parametrize(
    ("content", "quote"),
    [
        # A path-like token at the end of a sentence carries the period in the source.
        ("首行首列作 truthy/falsy 判断", "use the first column as truthy/falsy."),
        (
            "不变量错误需提及 validation/invariants。",
            "errors need to mention validation/invariants.",
        ),
        # The model drops a prefix that the source glues onto the same token.
        ("第 N 个非 skipped/non-todo 失败", "bail on the Nth non-skipped/non-todo failure"),
    ],
)
def test_draft_accepts_path_tokens_across_source_punctuation(content, quote):
    writer = Writer(
        {
            "episode_summary": content,
            "drafts": [
                {"kind": "decision", "content": content, "message_id": "one", "quote": quote}
            ],
        }
    )
    result = extract_episode(writer, {"id": "episode"}, [row("one", "user", quote)])
    assert [draft["content"] for draft in result["drafts"]] == [content]
    assert result["episode_summary"] == content


def test_draft_still_rejects_a_path_token_absent_from_the_witness():
    writer = Writer(
        {
            "episode_summary": "改用 src/cache.py",
            "drafts": [
                {
                    "kind": "decision",
                    "content": "改用 src/cache.py",
                    "message_id": "one",
                    "quote": "改用 src/store.py",
                }
            ],
        }
    )
    result = extract_episode(writer, {"id": "episode"}, [row("one", "user", "改用 src/store.py")])
    assert result["drafts"] == []


def test_unverifiable_summary_token_is_removed_without_discarding_the_summary():
    quote = "Add `safe_bulk_insert` and `safe_bulk_upsert` on `Database`."
    summary = "成员要求在 Database 上新增 safe_bulk_insert/upsert 两个安全批量接口"
    writer = Writer(
        {
            "episode_summary": summary,
            "drafts": [
                {
                    "kind": "decision",
                    "content": "新增安全批量接口",
                    "message_id": "one",
                    "quote": quote,
                }
            ],
        }
    )
    result = extract_episode(writer, {"id": "episode"}, [row("one", "user", quote)])
    assert result["episode_summary"] == "成员要求在 Database 上新增  两个安全批量接口"
