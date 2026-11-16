# -*- coding: utf-8 -*-
"""经验模块：输入 → 抽取 → 相似识别与合并更新（经验方案 v1.1 §1–§3）。

每段最多 2 次模型调用：过滤（判两个信号）+ 抽卡片；Agent 写了稿件的段不再调抽取。
合并：Space 内召回前 10 → 一次合并判定（creates / updates / deletes）→ 近重复复核。
判定与生成都走 `judge()` / `write()`。
"""

from __future__ import annotations

from typing import Any

from .judge import judge, one, write
from .types import EXP_CREATE, EXP_DELETE, EXP_UPDATE, Episode, ExperienceCard, Msg


Q_HAS_EXPLORATION = "has_exploration"
Q_HAS_USER_CORRECTION = "has_user_correction"
Q_DEDUP = "same_card"

MIN_TOOL_CALLS = 3
COMPLEX_TOOL_CALLS = 20
DEDUP_COSINE = 0.97
MAX_CARDS_PER_SEGMENT = 2


# ── §2.1 规则闸（照 EverOS）──────────────────────────────────────────────────


def passes_rule_gate(ep: Episode, tool_call_count: int | None = None) -> tuple[bool, str]:
    """没有成员消息、不以 Agent 回复收尾、工具调用少于 3 次 → 跳过。"""
    if not ep.members:
        return False, "没有成员消息"
    if not ep.agents or ep.messages[-1].role != "agent":
        return False, "不是以 Agent 回复收尾"
    n = tool_call_count if tool_call_count is not None else sum(1 for m in ep.messages if m.role == "tool")
    if n < MIN_TOOL_CALLS:
        return False, f"工具调用 {n} 次，少于 {MIN_TOOL_CALLS} 次"
    return True, f"工具调用 {n} 次"


# ── §2.2 过滤（照 EverOS，两个信号）───────────────────────────────────────────


def segment_payload(ep: Episode) -> dict[str, Any]:
    return {
        "segment_id": ep.id,
        "space_id": ep.space_id,
        "messages": [
            {
                "id": m.id,
                "role": m.role if m.role != "member" else "user",
                "text": m.text,
                **({"name": m.name} if m.is_member else {}),
                **({"args": m.tool_args, "output": m.tool_output} if m.role == "tool" else {}),
            }
            for m in ep.messages
        ],
        "notes": [],
    }


def should_extract(
    ep: Episode, tool_call_count: int | None = None, answers: dict[str, Any] | None = None
) -> tuple[bool, str]:
    n = tool_call_count if tool_call_count is not None else sum(1 for m in ep.messages if m.role == "tool")
    if n > COMPLEX_TOOL_CALLS:
        return True, f"工具调用 {n} 次，复杂任务，直接放行"
    payload = segment_payload(ep)
    payload["_answers"] = (answers or {})
    qs = [Q_HAS_EXPLORATION, Q_HAS_USER_CORRECTION]
    ans = judge("exp.filter", payload, qs)
    a1, a2 = one(ans, Q_HAS_EXPLORATION), one(ans, Q_HAS_USER_CORRECTION)
    if a1.value == "yes" or a2.value == "yes":
        return True, a1.reason or a2.reason or "走过弯路 / 或被成员纠正"
    return False, "两个信号都为假，不抽"


# ── §2.3 抽卡片（EverOS 两套提示词 + MemoraX 卡片字段）──────────────────────────


def extract_card(ep: Episode, generated: dict[str, Any] | None = None, note: dict[str, Any] | None = None) -> ExperienceCard | None:
    """有稿件时直接用稿件（0 次调用），否则一次调用抽一张卡片。"""
    if note:
        card = ExperienceCard.from_json(note)
        card.space_id, card.topic_id = ep.space_id, ep.topic_id
        card.time = card.time or (ep.messages[-1].chat_time if ep.messages else "")
        card.user_ids = card.user_ids or ep.member_names()
        return card

    payload = segment_payload(ep)
    payload["_generated"] = generated or {"cards": []}
    out = write("exp.extract", "pm-experience-extract-v0.1", payload)
    cards = out.get("cards") or out.get("card") or []
    if isinstance(cards, dict):
        cards = [cards]
    if not cards:
        return None
    row = cards[0]
    card = ExperienceCard.from_json(row)
    card.space_id, card.topic_id = ep.space_id, ep.topic_id
    card.time = card.time or (ep.messages[-1].chat_time if ep.messages else "")
    if not card.user_ids:
        card.user_ids = ep.member_names()
    return card


# ── §3 合并判定（照 Hindsight）───────────────────────────────────────────────


def merge_card(
    card: ExperienceCard,
    candidates: list[ExperienceCard],
    generated: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """一次调用决定 creates / updates / deletes。返回动作，存储层照写。"""
    payload = {
        "new": card.to_json(),
        "existing": [
            {
                "id": c.id,
                "task_intent": c.task_intent,
                "problem": c.problem,
                "principle": c.principle,
                "form": c.form,
                "status": c.status,
                "confidence": c.confidence,
                "time": c.time,
            }
            for c in candidates
        ],
        "_generated": generated or {},
    }
    out = write("exp.merge", "pm-experience-merge-v0.1", payload)

    actions: list[dict[str, Any]] = []
    for row in out.get("creates") or []:
        actions.append({"op": EXP_CREATE, "card": row})
    for row in out.get("updates") or []:
        actions.append({"op": EXP_UPDATE, "id": row.get("id"), "card": row.get("card") or {}, "reason": row.get("reason", "")})
    for row in out.get("deletes") or []:
        actions.append({"op": EXP_DELETE, "id": row.get("id"), "merged_into": row.get("merged_into"), "reason": row.get("reason", "")})
    if not actions:
        actions.append({"op": EXP_CREATE, "card": card.to_json()})
    return {"actions": actions, "raw": out}


def dedup_pair(
    a: ExperienceCard, b: ExperienceCard, answers: dict[str, Any] | None = None
) -> tuple[bool, str]:
    """近重复复核：任何重要细节不同就保留两张（Hindsight）。"""
    payload = {"a": a.to_json(), "b": b.to_json(), "_answers": answers or {}}
    ans = one(judge("exp.dedup", payload, [Q_DEDUP]), Q_DEDUP)
    return ans.value == "yes", ans.reason or ans.value
