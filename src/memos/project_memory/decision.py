# -*- coding: utf-8 -*-
"""决策模块：抽取 → 同类决策识别 → 冲突识别与解决（T1 v0.15 §2–§4）。

五个模型调用点（T1 §0）：判别 4 次（gate / same_problem 的排序与确认 / same 结论 / informed 知情），
抽取 1 次。全部走 `judge()` / `write()`，业务代码不读概率、不认后端。

模型输出一律当不可信：原话、Agent 说过的结论都在这里逐字核对（T1 §2.3）。
"""

from __future__ import annotations

from typing import Any

from .judge import judge, one, write
from .types import (
    OP_ADD,
    OP_CONFLICT_APPEND,
    OP_CONFLICT_UPDATE,
    OP_JOIN,
    OP_RESOLVE,
    OP_REWRITE,
    ConflictItem,
    Decision,
    DecisionAction,
    DecisionDraft,
    Episode,
    HistoryItem,
    InvariantError,
    Msg,
    Source,
)


# 阈值初值（T1 §3.2、§4.2，11/27 在标注集上定）
T_GATE_PASS = 0.3  # 判别模型 >0.3 就放行，拿不准也放行
T_SAME_QUESTION = 0.7
T_SAME_CONCLUSION = 0.8
T_INFORMED = 0.8

Q_HAS_DECISION = "has_decision"
Q_RANK = "rank"
Q_SAME_QUESTION = "same_question"

MAX_CONTENT_CHARS = 100
RECALL_TOP_K = 10


# ── §2 抽取 ────────────────────────────────────────────────────────────────


def episode_payload(ep: Episode) -> dict[str, Any]:
    """喂给模型的输入，形状照 T1 §1 的输入样例。决策不读工具返回。"""
    rows: list[dict[str, Any]] = []
    for m in ep.prev:
        rows.append(_row(m))
    for m in ep.messages:
        if m.role == "tool":
            continue
        rows.append(_row(m))
    return {"prev": [_row(m) for m in ep.prev], "episode": rows, "members": ep.member_names()}


def _row(m: Msg) -> dict[str, Any]:
    out: dict[str, Any] = {"id": m.id, "role": m.role, "text": m.text}
    if m.is_member:
        out["name"] = m.name or m.user_id
    return out


def has_decision(ep: Episode, answers: dict[str, Any] | None = None) -> tuple[bool, str]:
    """第一步：这一段有没有决策。每个 episode 一次请求（题目 pm-decision-gate-v0.1）。"""
    if not ep.members:
        return False, "没有成员消息，跳过（照 EverOS 的规则闸）"
    payload = episode_payload(ep)
    gate = (answers or {}).get(Q_HAS_DECISION, "unsure")
    payload["_answers"] = {Q_HAS_DECISION: gate if isinstance(gate, (dict, str)) else "unsure"}
    ans = one(judge("dec.gate", payload, [Q_HAS_DECISION]), Q_HAS_DECISION)
    # mock 后端直接给 yes/no/unsure；Jev 类后端给概率时按阈值换算
    ok = ans.value != "no"
    if ans.value == "unsure":
        ok = True  # 拿不准也放行：漏放是静默丢失
    return ok, ans.reason or f"gate={ans.value}"


def extract_drafts(ep: Episode, generated: dict[str, Any] | None = None) -> list[DecisionDraft]:
    """第二步：一次调用写出这一段全部决策（提示词 pm-decision-extract-v0.2）。"""
    payload = episode_payload(ep)
    payload["_generated"] = generated or {"decisions": []}
    out = write("dec.extract", "pm-decision-extract-v0.2", payload)
    drafts: list[DecisionDraft] = []
    time_by_msg = {m.id: m.chat_time for m in ep.messages}
    user_by_msg = {m.id: (m.user_id or m.name) for m in ep.messages}
    name_by_msg = {m.id: (m.name or m.user_id) for m in ep.messages}
    for row in out.get("decisions") or []:
        mid = row.get("message_id") or ""
        drafts.append(
            DecisionDraft(
                message_id=mid,
                quote=row.get("quote") or "",
                content=row.get("content") or "",
                user_name=name_by_msg.get(mid, ""),
                user_id=user_by_msg.get(mid, ""),
                chat_time=time_by_msg.get(mid, ""),
                category=row.get("category") or "",
                change_reason=row.get("change_reason") or "",
                origin=row.get("origin") or "member",
                sure=bool(row.get("sure", True)),
                resolve=bool(row.get("resolve", False)),
                approved_by=list(row.get("approved_by") or []),
                listed=list(row.get("listed") or []),
            )
        )
    return drafts


def verify_drafts(
    ep: Episode, drafts: list[DecisionDraft], conv_id: str
) -> tuple[list[DecisionDraft], list[dict[str, Any]]]:
    """第三步：代码核对（T1 §2.3）。逐字核对原话与 listed，过不了的丢弃并记原因。"""
    member_msg = {m.id: m for m in ep.messages if m.is_member}
    ordered = list(ep.prev) + list(ep.messages)
    kept: list[DecisionDraft] = []
    dropped: list[dict[str, Any]] = []

    for d in drafts:
        if d.message_id not in member_msg:
            dropped.append({"draft": d.content or d.quote, "reason": "message_id 不是成员消息", "quote": d.quote})
            continue
        src_msg = member_msg[d.message_id]
        if not d.quote or d.quote not in _norm(src_msg.text):
            d.dropped_reason = "source_mismatch"
            dropped.append({"draft": d.content, "reason": "source_mismatch：原话在成员消息里找不到", "quote": d.quote})
            continue
        if not d.sure:
            d.dropped_reason = "unsure"
            dropped.append(
                {
                    "draft": d.content,
                    "reason": "拿不准是不是要团队照做，不写入，只留丢弃清单",
                    "quote": d.quote,
                    "message_id": d.message_id,
                }
            )
            continue
        if not d.content:
            dropped.append({"draft": "", "reason": "content 为空（找不到所指的内容），进暂缓", "quote": d.quote})
            continue
        if len(d.content) > MAX_CONTENT_CHARS:
            d.content = d.content[:MAX_CONTENT_CHARS]

        # 说话人就是这项结论的负责人
        d.user_id = src_msg.user_id or src_msg.name
        d.user_name = src_msg.name or src_msg.user_id
        d.chat_time = src_msg.chat_time

        # 已和谁确认：名字要在名单里、不是本人、且在那条消息里出现过
        members = set(ep.member_names())
        d.approved_by = [
            n for n in d.approved_by if n in members and n != d.user_name and n in src_msg.text
        ]

        # listed 必须能在这条消息之前的 Agent 回复里逐字找到
        before = _agent_text_before(ordered, d.message_id)
        d.listed = [s for s in d.listed if s and _norm(s) in before]
        if d.origin not in ("member", "adopted"):
            d.origin = "member"
        kept.append(d)

    return kept, dropped


def _norm(s: str) -> str:
    return (s or "").replace("　", " ").strip()


def _agent_text_before(ordered: list[Msg], message_id: str) -> str:
    buf: list[str] = []
    for m in ordered:
        if m.id == message_id:
            break
        if m.role == "agent":
            buf.append(m.text)
    return _norm("\n".join(buf))


# ── §3 同类决策识别 ────────────────────────────────────────────────────────


def pick_same_question(
    draft: DecisionDraft, candidates: list[Decision], answers: dict[str, Any] | None = None
) -> tuple[Decision | None, str]:
    """先排序再确认（照 Hindsight）。召回到 1 条时跳过排序。不设「都不是」选项。"""
    if not candidates:
        return None, "没召回到相近的决策，直接新增"
    preset = (answers or {})
    cand = candidates[0] if len(candidates) == 1 else None
    if cand is None:
        payload = {
            "topic": "",
            "new": draft.content,
            "_answers": {Q_RANK: preset.get(Q_RANK, {})},
        }
        ans = one(judge("dec.rank", payload, [Q_RANK]), Q_RANK)
        chosen = ans.reason or ""
        # mock 后端把选中的 id 放进 reason
        cand = next((c for c in candidates if c.id == chosen), None)
        if cand is None:
            cand = candidates[0]

    payload = {
        "new": draft.content,
        "existing": cand.content,
        "_answers": {Q_SAME_QUESTION: preset.get(Q_SAME_QUESTION, {})},
    }
    ans = one(judge("dec.same_problem", payload, [Q_SAME_QUESTION]), Q_SAME_QUESTION)
    if ans.value == "yes":
        return cand, f"同一件事（{ans.reason or '确认'}）"
    return None, f"不是同一件事（{ans.value}），新增"


# ── §4 冲突识别与解决 ──────────────────────────────────────────────────────


def decide_action(
    draft: DecisionDraft,
    decision: Decision,
    conv_id: str,
    answers: dict[str, Any] | None = None,
) -> DecisionAction:
    """按 T1 §4.3 的表定结果。从上往下，先符合哪条就按哪条。"""
    preset = answers or {}
    items = {"content": decision.content}
    for c in decision.conflicts:
        items[f"conflict:{c.seq}"] = c.content

    # ① 相同题：和每一项各比一次
    same_qs = [f"same:{k}" for k in items]
    same_payload = {"new": draft.content, "items": items, "_answers": _subset(preset, same_qs)}
    same_ans = judge("dec.same_conclusion", same_payload, same_qs) if same_qs else {}

    matched: list[tuple[str, float]] = []
    for k in items:
        a = one(same_ans, f"same:{k}")
        if a.value == "yes":
            matched.append((k, 1.0 if not a.reason else 1.0))
    # 判为相同的不止一项时取概率最高的：mock 后端没有概率，按冲突项优先（更近的结论）
    target_same = ""
    if matched:
        target_same = sorted(matched, key=lambda x: 0 if x[0] == "content" else 1)[0][0]

    # ② 知情题：草稿是定案时才问
    informed_matched: list[str] = []
    if draft.resolve and draft.listed:
        listed = {f"l{i + 1}": s for i, s in enumerate(draft.listed)}
        inf_qs = [f"informed:{l}:{k}" for l in listed for k in items]
        inf_payload = {
            "new": draft.content,
            "items": items,
            "listed": listed,
            "_answers": _subset(preset, inf_qs),
        }
        inf_ans = judge("dec.informed", inf_payload, inf_qs) if inf_qs else {}
        for l in listed:
            for k in items:
                if one(inf_ans, f"informed:{l}:{k}").value == "yes":
                    if k not in informed_matched:
                        informed_matched.append(k)

    src = Source(conversation_id=conv_id, message_id=draft.message_id, quote=draft.quote)
    base = dict(user_ids=[draft.user_id] if draft.user_id else [], content=draft.content, time=draft.chat_time, source=src, decision_id=decision.id)

    # 不靠模型的两个查库事实
    is_owner = draft.user_id in decision.user_ids
    earlier = bool(draft.chat_time) and bool(decision.time) and draft.chat_time < decision.time
    already = decision.item_of(draft.user_id)

    # 第 1 行：定案 + 知情 → 拍板
    if draft.resolve and informed_matched and not earlier:
        target = target_same or informed_matched[0]
        return DecisionAction(
            op=OP_RESOLVE,
            target=target,
            reason=f"{draft.user_name} 确定以选定结论为准",
            **base,
        )

    # 第 2 行：不同 + 负责人或已确认 → 改写
    if target_same == "" and (is_owner or draft.approved_by) and not earlier:
        merge_with = ""
        for k in items:
            if k.startswith("conflict:") and k != "content":
                a = one(same_ans, f"same:{k}")
                if a.value == "yes":
                    merge_with = k
        return DecisionAction(op=OP_REWRITE, reason=draft.change_reason, merge_with=merge_with, **base)

    # 第 3 行：和某一项相同 → 加入
    if target_same:
        if already == target_same:
            return DecisionAction(op=OP_JOIN, target=target_same, reason="他已经在那一项里，不写入", **base)
        return DecisionAction(op=OP_JOIN, target=target_same, reason="同意其中一项", **base)

    # 第 4 行：记成不一致结论
    if already and already.startswith("conflict:"):
        return DecisionAction(op=OP_CONFLICT_UPDATE, target=already, reason=draft.change_reason, **base)
    return DecisionAction(op=OP_CONFLICT_APPEND, reason=draft.change_reason, **base)


def _subset(preset: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {k: preset.get(k, "unsure") for k in keys} if preset else {}


# ── 按动作落库（存储层只照写，不重判）──────────────────────────────────────────


def apply_action(d: Decision, a: DecisionAction) -> Decision:
    """照 T1 §5.1 的动作表改一条决策。返回改后的副本，三条不变式自检不过就抛。"""
    out = Decision.from_json(d.to_json(), decision_id=d.id)
    h0 = len(out.history)
    before_conflicts = {c.seq: c.content for c in out.conflicts}

    def push_history(item: ConflictItem, reason: str, change: Source) -> None:
        out.history.append(
            HistoryItem(
                seq=len(out.history) + 1,
                content=item.content,
                time=item.time,
                user_ids=list(item.user_ids),
                source=item.source,
                reason=reason,
                change_source=change,
            )
        )

    if a.op == OP_ADD:
        out.content, out.time, out.user_ids, out.source = a.content, a.time, list(a.user_ids), a.source

    elif a.op == OP_JOIN:
        for u in a.user_ids:
            _remove_user(out, u, a.target, f"{u} 改为支持另一项结论", a.source, push_history)
            grp = out.user_ids if a.target == "content" else out.conflict(a.target).user_ids
            if u not in grp:
                grp.append(u)

    elif a.op == OP_CONFLICT_APPEND:
        for u in a.user_ids:
            _remove_user(out, u, None, f"{u} 改为支持另一项结论", a.source, push_history)
        seq = max([c.seq for c in out.conflicts] + [0]) + 1
        out.conflicts.append(
            ConflictItem(seq=seq, content=a.content, time=a.time, user_ids=list(a.user_ids), source=a.source)
        )

    elif a.op == OP_CONFLICT_UPDATE:
        c = out.conflict(a.target)
        c.content, c.time, c.source = a.content, a.time, a.source
        # 内容与当前结论相同就不再是不一致结论
        if c.content == out.content:
            out.conflicts.remove(c)

    elif a.op == OP_REWRITE:
        push_history(out.as_item(), a.reason, a.source)
        if a.merge_with:
            c = out.conflict(a.merge_with)
            out.conflicts.remove(c)
            out.content, out.source, out.user_ids = c.content, c.source, list(c.user_ids)
            for u in a.user_ids:
                _remove_user(out, u, "content", f"{u} 改为支持另一项结论", a.source, push_history)
                if u not in out.user_ids:
                    out.user_ids.append(u)
            out.time = c.time
        else:
            out.content, out.source, out.user_ids, out.time = a.content, a.source, list(a.user_ids), a.time
            for u in list(a.user_ids):
                _remove_user(out, u, "content", f"{u} 改为支持另一项结论", a.source, push_history)

    elif a.op == OP_RESOLVE:
        t = a.target
        if t.startswith("conflict:"):
            c = out.conflict(t)
            push_history(out.as_item(), a.reason, a.source)
            for o in list(out.conflicts):
                if o is not c:
                    push_history(o, a.reason, a.source)
            out.content, out.source, out.user_ids = c.content, c.source, list(c.user_ids)
        elif t == "content":
            for o in list(out.conflicts):
                push_history(o, a.reason, a.source)
        else:
            push_history(out.as_item(), a.reason, a.source)
            for o in list(out.conflicts):
                push_history(o, a.reason, a.source)
            out.content, out.source, out.user_ids = a.content, a.source, []
        for u in a.user_ids:
            if u not in out.user_ids:
                out.user_ids.append(u)
        out.time = a.time
        out.conflicts = []

    else:
        raise ValueError(f"未知动作 {a.op}")

    out.version += 1
    out.check()

    # 不变式 2 的后半句：被移走的不一致结论，要么成为当前结论，要么进了历史
    gone = [c for seq, c in before_conflicts.items() if seq not in {x.seq for x in out.conflicts}]
    new_hist = [h.content for h in out.history[h0:]]
    for c in gone:
        if c != out.content and c not in new_hist:
            raise InvariantError(f"不变式 2：不一致结论「{c}」被移走但没有进历史")
    return out


def _remove_user(d: Decision, u: str, keep: str | None, reason: str, change: Source, push) -> None:
    """一位成员在一条决策里只占一项。"""
    if keep != "content" and u in d.user_ids and len(d.user_ids) > 1:
        d.user_ids.remove(u)
    for c in list(d.conflicts):
        t = f"conflict:{c.seq}"
        if t != keep and u in c.user_ids:
            if len(c.user_ids) == 1:
                push(c, reason, change)
                d.conflicts.remove(c)
            else:
                c.user_ids.remove(u)
