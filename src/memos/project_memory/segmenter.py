"""episode 切分：由模型判每一轮和当前段的关系（11/17 定：关段由模型判，不靠空闲计时）。

每轮一道选择题 `turn_relation`（走 judge()）：
- follow_up：接着做同一件事 → 这一轮并进当前段；
- new_task：开始了另一件事 → 先关上一段，这一轮开新段；
- end_topic：这件事在这一轮做完了 → 这一轮并进当前段，然后关段。
拿不准或答不出按 follow_up（照经验方案：拿不准取 follow_up）。

另外两条规则兜底（经验方案 §3.2 ③）：超过 64k token 或 500 条消息关段；Agent 写了经验稿立即关段。
没传 conversation_id 的提交按 PRD「本次提交的消息单独整理」：自成一段，立即关。

一轮 = 成员的一次输入 + Agent 对它的完整回复（含其间的工具调用）（PRD 术语）。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .judge import ModelHub, one
from .prompts import TURN_RELATION_QUESTION
from .types import (
    TURN_END_TOPIC,
    TURN_FOLLOW_UP,
    TURN_NEW_TASK,
    Episode,
    Msg,
    new_uuid,
)


if TYPE_CHECKING:
    from collections.abc import Callable


MAX_TOKENS = 64_000
MAX_MESSAGES = 500
CHARS_PER_TOKEN = 2  # 中文按 2 字符 / token 粗估


def split_turns(msgs: list[Msg]) -> list[list[Msg]]:
    """按成员消息切轮：每条成员消息开一轮；开头不是成员消息的，作为「续上一轮」的那一组。"""
    turns: list[list[Msg]] = []
    cur: list[Msg] = []
    for m in msgs:
        if m.is_member and cur:
            turns.append(cur)
            cur = []
        cur.append(m)
    if cur:
        turns.append(cur)
    return turns


def _tokens(msgs: list[Msg]) -> int:
    return sum(len((m.text or "") + (m.tool_args or "")) for m in msgs) // CHARS_PER_TOKEN


def _render(msgs: list[Msg], limit: int = 12) -> list[dict[str, str]]:
    rows = []
    for m in msgs[-limit:]:
        text = m.text if m.role != "tool" else f"[{m.tool_name}] {m.tool_args}"
        rows.append(
            {"role": m.role, "name": m.speaker if m.is_member else "", "text": (text or "")[:800]}
        )
    return rows


def judge_relation(hub: ModelHub, episode_msgs: list[Msg], turn: list[Msg]) -> str:
    state = {"episode": _render(episode_msgs), "turn": _render(turn, limit=40)}
    ans = one(hub.judge("episode.turn_relation", state, TURN_RELATION_QUESTION), "turn_relation")
    return (
        ans.value
        if ans.value in (TURN_FOLLOW_UP, TURN_NEW_TASK, TURN_END_TOPIC)
        else TURN_FOLLOW_UP
    )


def segment(
    hub: ModelHub,
    space_id: str,
    conversation_id: str | None,
    open_ep: Episode | None,
    new_msgs: list[Msg],
    load: Callable[[list[str]], list[Msg]],
    domains: list[str],
    task_id: str,
    log: Callable[[str], None],
    prev_tail: list[str] | None = None,
) -> tuple[list[Episode], Episode | None]:
    """把新消息并进 episode。返回（这次关掉的段，仍开着的段）。

    `load(ids)` 按消息节点 id 取回消息（判段关系要看当前段里已有的内容）。
    """
    closed: list[Episode] = []

    def start(prev_tail: list[str]) -> Episode:
        return Episode(
            id=new_uuid(),
            space_id=space_id,
            conversation_id=conversation_id or "",
            prev_message_ids=prev_tail,
            domains=list(domains),
            task_ids=[task_id],
        )

    def close(ep: Episode, reason: str) -> list[str]:
        ep.state, ep.closed_reason = "closed", reason
        closed.append(ep)
        tail_turns = split_turns(load(ep.message_ids))
        return [m.node_id for m in (tail_turns[-1] if tail_turns else [])]

    if not conversation_id:
        ep = start([])
        ep.message_ids = [m.node_id for m in new_msgs]
        close(ep, "no_conversation_id")
        log(f"没有 conversation_id：本次 {len(new_msgs)} 条消息自成一段")
        return closed, None

    cur = open_ep
    cur_msgs: list[Msg] = load(cur.message_ids) if cur else []
    next_prev: list[str] = list(prev_tail or [])  # 上一段最后一轮，给下一段看懂指代
    for turn in split_turns(new_msgs):
        if cur is None:
            cur, cur_msgs = start(next_prev), []
        if task_id not in cur.task_ids:
            cur.task_ids.append(task_id)
        for d in domains:
            if d not in cur.domains:
                cur.domains.append(d)

        rel = judge_relation(hub, cur_msgs, turn) if turn[0].is_member else TURN_FOLLOW_UP
        log(f"段关系：{rel}（{(turn[0].text or '')[:24]}…）")
        if rel == TURN_NEW_TASK and cur_msgs:
            next_prev = close(cur, "new_task")
            cur, cur_msgs = start(next_prev), []

        cur.message_ids += [m.node_id for m in turn]
        cur_msgs += turn

        reason = ""
        if rel == TURN_END_TOPIC:
            reason = "end_topic"
        elif any(m.notes for m in turn):
            reason = "experience_note"
        elif len(cur_msgs) >= MAX_MESSAGES or _tokens(cur_msgs) >= MAX_TOKENS:
            reason = "size_limit"
        if reason:
            next_prev = close(cur, reason)
            cur, cur_msgs = None, []

    return closed, cur
