# -*- coding: utf-8 -*-
"""mock add 的输入：T1 决策让例的六轮 + 第 7 轮（分歧还挂着的状态），以及经验一段。

这些是**构造的**样例，成员说的话取自 PRD 的示例。用来把主链路跑通、
把三种动作与两张状态（分歧挂着 / 拍板后）都走到，不当作真实会话。
"""

from __future__ import annotations

from .types import Msg, ROLE_AGENT, ROLE_MEMBER, ROLE_TOOL


SPACE = "space_memos_cloud"
CONV = "claude-code:7d2e9f10"


def _m(i: int, who: str, text: str, t: str, uid: str = "") -> Msg:
    return Msg(id=f"cc-7d2e9f10-u-{i:04d}", role=ROLE_MEMBER, text=text, chat_time=t, user_id=uid or f"user_{who}", name=who)


def _a(i: int, text: str, t: str) -> Msg:
    return Msg(id=f"cc-7d2e9f10-a-{i:04d}", role=ROLE_AGENT, text=text, chat_time=t)


def decision_turns() -> list[Msg]:
    """T1 §0 的第 1–4 轮：新增 → 不一致 → 加入 → 再不一致。"""
    return [
        # 1 新增决策
        _m(1, "用户B", "本机整理结果存入 SQLite，每个 Space 一个库文件。", "2026-10-29T10:20:00+08:00", "user_b"),
        _a(2, "已按每个 Space 一个 SQLite 库文件实现存储层。", "2026-10-29T10:21:00+08:00"),
        # 2 不同结论 → 不一致结论 1
        _m(3, "用户C", "本机整理结果存入单个 SQLite 库，按 space_id 分表。", "2026-10-30T14:05:00+08:00", "user_c"),
        _a(4, "这与当前结论不同：现在记录的是每个 Space 一个库文件。要不要改成单库分表？", "2026-10-30T14:06:00+08:00"),
        # 3 同意 → 加入
        _m(5, "用户D", "同意单库按 space_id 分表。", "2026-10-30T14:40:00+08:00", "user_d"),
        # 4 另一种结论 → 不一致结论 2
        _m(6, "用户E", "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。", "2026-10-30T15:30:00+08:00", "user_e"),
        _a(7, "这与现有两项结论都不同，已记下。", "2026-10-30T15:31:00+08:00"),
    ]


def decision_turn7() -> list[Msg]:
    """第 7 轮（构造）：拍板之后，又一位成员提了第三种说法。

    顺序很要紧：10/31 拍板时清空的是当时挂着的各项；11/03 这句晚于拍板，
    应当记成新的不一致结论，而不是被那句拍板清掉。见 T1 §4.2 的「新旧按说话时间比」。
    """
    return [
        _m(8, "用户A", "本机整理结果按领域分库，每个领域一个 SQLite 库文件。", "2026-11-03T09:30:00+08:00", "user_a"),
        _a(9, "记下了，这与单库分表的结论不同。", "2026-11-03T09:31:00+08:00"),
    ]


def decision_final_turns() -> list[Msg]:
    """第 5、6 轮：Agent 列出三项结论，用户B 定案（同一会话，相隔两分钟 → 同一段）。"""
    return [
        _m(10, "用户B", "本机整理结果的存储层下一步怎么实现？", "2026-10-31T10:00:00+08:00", "user_b"),
        _a(
            11,
            "本机整理结果的存储方式目前有三种结论，还没有定下来：\n"
            "1. 每个 Space 一个库文件（用户B，10/29）\n"
            "2. 单个 SQLite 库，按 space_id 分表（用户C、用户D，10/30）\n"
            "3. 改用 LanceDB 统一存储，不再使用 SQLite（用户E，10/30）\n"
            "请确认以哪一项为准，我再继续实现存储层。",
            "2026-10-31T10:01:00+08:00",
        ),
        _m(12, "用户B", "以用户C 的为准。", "2026-10-31T10:02:00+08:00", "user_b"),
        _a(13, "好的，按单个 SQLite 库、按 space_id 分表继续实现存储层。", "2026-10-31T10:03:00+08:00"),
    ]


def experience_segment() -> list[Msg]:
    """经验一段（照经验方案 §1.4 的形状）：修好了一个并发覆盖问题。"""
    return [
        Msg(
            id="u-0101",
            role=ROLE_MEMBER,
            text="实现 add/message 的项目记忆写入，按 PRD 执行。",
            chat_time="2026-10-30T16:00:00+08:00",
            user_id="user_b",
            name="用户B",
        ),
        Msg(
            id="t-call_3",
            role=ROLE_TOOL,
            text="",
            chat_time="2026-10-30T16:05:00+08:00",
            tool_name="Bash",
            tool_args="pnpm vitest run test/pipeline.concurrency.test.ts",
            tool_output=" FAIL  test/pipeline.concurrency.test.ts > 两轮几乎同时提交时两轮都保留\n"
            "AssertionError: expected 12 entries, got 11\n Tests  1 failed | 11 passed (12)",
        ),
        Msg(
            id="t-call_4",
            role=ROLE_TOOL,
            text="",
            chat_time="2026-10-30T16:10:00+08:00",
            tool_name="Edit",
            tool_args="src/project/queue.ts",
            tool_output="ok",
        ),
        Msg(
            id="t-call_5",
            role=ROLE_TOOL,
            text="",
            chat_time="2026-10-30T16:15:00+08:00",
            tool_name="Bash",
            tool_args="pnpm vitest run test/pipeline.concurrency.test.ts",
            tool_output=" ✓ test/pipeline.concurrency.test.ts (12 tests)\n Tests  12 passed (12)",
        ),
        Msg(
            id="a-0102",
            role=ROLE_AGENT,
            text="已完成，已提交 PR #412。两轮消息几乎同时提交时，后写回的整理结果覆盖了先写回的条目；"
            "改为同一 Space 内串行执行后不再出现。",
            chat_time="2026-10-30T16:20:00+08:00",
        ),
    ]
