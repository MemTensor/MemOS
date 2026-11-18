"""经验模块（《经验抽取 · 验证 · 维护 模块方案评审》§3.2 ④–⑫、§5）。

    ④ 规则闸 → ⑤ 过滤（exp.filter）→ ⑥ 抽卡片（exp.extract，一次直出）→ ⑦ 代码校验
    → ⑧ 召回候选 → ⑨ 合并判定（exp.merge）→ 证据护栏 guard → ⑪ 可信度维护 → ⑫ 写库

默认两次调用（⑤ 判、⑥ 写）；`EXPERIENCE_EXTRACT_MODE=one_shot` 时跳过 ⑤，直接用一次直出的提示词
（它自己先判两题，两题都答否就不出卡片）。Agent 写了经验稿的段不调 ⑤⑥，稿件直接当卡片进 ⑦。
⑩ 近重复复核方案标为可选，没做。
"""

from __future__ import annotations

import os
import re
import unicodedata

from datetime import datetime
from typing import TYPE_CHECKING, Any

from memos.graph_dbs.base import ConcurrentUpdateError

from .judge import ModelHub
from .prompts import EXP_EXTRACT, EXP_FILTER, EXP_MERGE
from .types import (
    CARD_FIELDS,
    EXP_ADD,
    EXP_CANDIDATE,
    EXP_CONFIRM,
    EXP_FAILED,
    EXP_REFUTE,
    EXP_UPDATE,
    EXP_VERIFIED,
    Episode,
    ExperienceCard,
    new_uuid,
    now_iso,
)


if TYPE_CHECKING:
    from .store import ProjectStore


MIN_TOOL_CALLS = 3
COMPLEX_TOOL_CALLS = 20
RECALL_TOP_K = 10
MAX_CAS_RETRIES = 3
MAX_STEPS = 8  # 11/17 由 5 放宽到 8：真实模型合并两张卡常给 6–8 步
MAX_ANCHORS = 5
CONF_NEW, CONF_MAX, CONF_MIN = 0.5, 0.95, 0.1
STALE_DAYS = 90

_SECRET = re.compile(
    r"(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|(?i:(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+))"
)


def redact(s: str | None) -> str | None:
    return _SECRET.sub("[REDACTED:secret]", s) if s else s


# ── ④ 规则闸 ───────────────────────────────────────────────────────────────


def rule_gate(ep: Episode) -> tuple[bool, str]:
    if not ep.members:
        return False, "没有成员消息"
    if not ep.messages or ep.messages[-1].role != "agent":
        return False, "不是以 Agent 回复收尾"
    if any(m.notes for m in ep.agents):
        return True, "Agent 写了经验稿"
    n = len(ep.tools)
    if n < MIN_TOOL_CALLS:
        return False, f"工具调用 {n} 次，少于 {MIN_TOOL_CALLS} 次"
    return True, f"工具调用 {n} 次"


# ── 段的文本（§5.1.1 的记录格式）──────────────────────────────────────────────


def segment_text(ep: Episode) -> str:
    first, last = (ep.messages[0].chat_time, ep.messages[-1].chat_time) if ep.messages else ("", "")
    names = "、".join(ep.member_names()) or "-"
    head = (
        f"[段 {ep.id[:8]} · {names} · {first} – {last} · 成员消息 {len(ep.members)} 条 · "
        f"工具调用 {len(ep.tools)} 次]"
    )
    lines = [head]
    for m in ep.messages:
        if m.is_member:
            lines.append(f"[成员 {m.id}] {m.text}")
        elif m.role == "tool":
            out = (m.text or "").strip().replace("\n", "\n    ")
            lines.append(f"[工具 {m.id} · {m.tool_name or 'tool'}] {m.tool_args}".rstrip())
            if out:
                lines.append(f"  → {out}")
        else:
            lines.append(f"[Agent {m.id} · 自述] {m.text}")
    return "\n".join(lines)


# ── ⑤ 过滤 ─────────────────────────────────────────────────────────────────


def should_extract(hub: ModelHub, ep: Episode) -> tuple[bool, str]:
    if len(ep.tools) > COMPLEX_TOOL_CALLS:
        return True, f"工具调用 {len(ep.tools)} 次，复杂任务直接放行"
    out = hub.write("exp.filter", EXP_FILTER, None, {"{{segment_text}}": segment_text(ep)})
    a1, a2 = out.get("has_exploration"), out.get("has_user_correction")
    ok = a1 == "是" or a2 == "是"  # 拿不准按假
    return ok, f"has_exploration={a1} has_user_correction={a2}；{out.get('reason', '')}"


# ── ⑥ 抽卡片 ───────────────────────────────────────────────────────────────


def extract_card(hub: ModelHub, ep: Episode) -> tuple[ExperienceCard | None, str]:
    note = next((n for m in ep.agents for n in m.notes), None)
    if note:
        card = _card_from(note)
        card.signal = note.get("signal") or card.signal
        card.exp_status = note.get("status") or card.exp_status
        return card, "经验稿"
    out = hub.write("exp.extract", EXP_EXTRACT, None, {"{{segment_text}}": segment_text(ep)})
    if out.get("has_exploration") != "是" and out.get("has_user_correction") != "是":
        return None, "两题都不是「是」，不出卡片"
    raw = out.get("card")
    if not isinstance(raw, dict):
        return None, "card 为空"
    card = _card_from(raw)
    q = out.get("quality_score")
    card.quality_score = float(q) if isinstance(q, int | float) else None
    card.exp_status = raw.get("status") or EXP_CANDIDATE
    card.signal = raw.get("signal") or "none"
    if card.quality_score is not None and card.quality_score < 0.5:
        card.exp_status = EXP_FAILED
    return card, f"quality_score={card.quality_score}"


def _as_text(v: Any) -> Any:
    """模型偶尔把字段写成对象（如 anchors 里放 {"file": "..."}）：取第一个字符串值。"""
    if isinstance(v, dict):
        for key in ("path", "file", "command", "text", "value"):
            if isinstance(v.get(key), str):
                return v[key]
        return next((x for x in v.values() if isinstance(x, str)), None)
    return v


def _card_from(raw: dict[str, Any]) -> ExperienceCard:
    c = ExperienceCard()
    for k in CARD_FIELDS:
        if k in raw and raw[k] is not None:
            if k == "anchors":
                items = raw[k] if isinstance(raw[k], list) else [raw[k]]
                setattr(c, k, [t for t in (_as_text(x) for x in items) if isinstance(t, str)])
            else:
                v = _as_text(raw[k])
                setattr(c, k, v if isinstance(v, str) else str(v))
    if c.exp_status not in (EXP_VERIFIED, EXP_CANDIDATE, EXP_FAILED):
        c.exp_status = EXP_CANDIDATE
    return c


# ── ⑦ 代码校验 ─────────────────────────────────────────────────────────────


def code_check(card: ExperienceCard, ep: Episode, from_note: bool) -> list[str]:
    notes: list[str] = []
    tool_text = _norm("\n".join(f"{m.tool_args}\n{m.text}" for m in ep.tools))
    # 工具调用编号（b-exp-c1 这种）是记录的定位符，不是文件或命令；模型偶尔当成锚点
    card.anchors = [
        a for a in card.anchors if isinstance(a, str) and not re.fullmatch(r"[\w-]+-?[ca]\d+", a)
    ]
    kept = [a for a in card.anchors if a and _norm(a) in tool_text]
    if len(kept) < len(card.anchors):
        notes.append(f"锚点 {sorted(set(card.anchors) - set(kept))} 在本段工具调用里找不到，删掉")
    card.anchors = kept[:MAX_ANCHORS]
    if card.validation:
        # 模型常把「命令 → 结果」写成一句：只要其中有片段（命令或结果）在本段工具调用里出现过，
        # 就算有据。任务编号、箭头这类装饰不算。
        pieces = [
            x.strip(" →✓\t")
            for x in re.split(r"[，,；;→\n]", card.validation)
            if len(_norm(x)) >= 6
        ]
        if pieces and not any(_norm(x) in tool_text for x in pieces):
            notes.append("validation 里的命令在本段工具调用里找不到，置空")
            card.validation = None
    if card.exp_status == EXP_VERIFIED and card.signal in ("", "none", None):
        card.exp_status = EXP_CANDIDATE
        notes.append("verified 但 signal=none，降为 candidate")
    if card.exp_status == EXP_FAILED and card.principle and not card.principle.startswith("待验证"):
        card.principle = "待验证：" + card.principle
    for k in ("problem", "technical_context", "failed_shape", "principle", "validation"):
        setattr(card, k, redact(getattr(card, k)))
    return notes


# ── ⑨ 合并判定 + 证据护栏 ───────────────────────────────────────────────────


def merge_payload(card: ExperienceCard, cands: list[ExperienceCard]) -> tuple[dict, list[dict]]:
    new = {
        "id": "new",
        "time": card.time,
        "status": card.exp_status,
        "signal": card.signal,
        **card.card(),
    }
    olds = [
        {
            "id": c.id,
            "time": c.time,
            "status": c.exp_status,
            "signal": c.signal,
            "confidence": c.confidence,
            "version": c.version,
            **c.card(),
        }
        for c in cands
    ]
    return new, olds


def merge(hub: ModelHub, card: ExperienceCard, cands: list[ExperienceCard]) -> dict[str, Any]:
    import json

    new, olds = merge_payload(card, cands)
    return hub.write(
        "exp.merge",
        EXP_MERGE,
        None,
        {
            "{{new_card}}": json.dumps(new, ensure_ascii=False, indent=1),
            "{{candidates}}": json.dumps(olds, ensure_ascii=False, indent=1),
        },
    )


def steps(principle: str | None) -> list[str]:
    if not principle:
        return []
    parts = re.split(r"(?:^|\s|；|;)\d+[.、．]\s*", principle)
    parts = [p.strip(" ；;。") for p in parts if p and p.strip(" ；;。")]
    return parts or [principle.strip()]


def _bigrams(text: str) -> set[str]:
    text = (text or "").lower()
    out: set[str] = set(re.findall(r"[a-z0-9_./#-]{2,}", text))
    for seg in re.findall(r"[\u3400-\u9fff]+", text):
        out.update(seg[i : i + 2] for i in range(len(seg) - 1))
    return out


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", "", s)


def guard(
    action: str, card: ExperienceCard, target: ExperienceCard | None, merged: dict[str, Any] | None
) -> tuple[str, str]:
    """§5.2 的证据护栏，从上到下取第一条。返回（动作，原因）；动作 add_opposed 表示 (add, k)。"""
    if action in (EXP_UPDATE, EXP_REFUTE, EXP_CONFIRM) and target is None:
        return EXP_ADD, "target_id 不在候选里，按新增"
    if action == EXP_ADD and target is not None:
        return "add_opposed", "没有证据的相反说法：新卡单独存为待验证"
    if action == EXP_REFUTE and not card.has_evidence():
        return "add_opposed", "refute 但新卡片没有证据"
    if action in (EXP_UPDATE, EXP_REFUTE) and merged is not None:
        n = len(steps(merged.get("principle")))
        if n > MAX_STEPS:
            # T2 §5.2 的合并约束：principle ≤8 步（原为 5）。模型给的合并结果超了就是不合规的输出，
            # 不写进已有卡片（否则卡片会越并越长，后续每次 update 都像在删步骤）。
            return "add_opposed", f"合并结果 {n} 步，超过 {MAX_STEPS} 步的约束：按新增（待验证）"
    if (
        action == EXP_UPDATE
        and target is not None
        and merged is not None
        and target.exp_status == EXP_VERIFIED
        and card.exp_status != EXP_VERIFIED
        and steps(merged.get("principle")) != steps(target.principle)
    ):
        # T2 §5.2「已有卡片是 verified、新卡片不是 verified：不要改动 principle」
        return "add_opposed", "未验证的新卡想改已验证卡片的做法：新卡单独存为待验证"
    return action, ""


# ── ⑪ 可信度 + ⑫ 写库 ──────────────────────────────────────────────────────


def _evidence(
    action: str, card: ExperienceCard, ep: Episode, injected: bool = True
) -> dict[str, Any]:
    last = ep.agents[-1] if ep.agents else (ep.messages[-1] if ep.messages else None)
    return {
        "type": "chat",
        "role": "assistant",
        "message_id": last.id if last else "",
        "chat_time": last.chat_time if last else card.time,
        "content": (last.text[:200] if last else ""),
        "role_id": ep.members[0].user_id if ep.members else "",
        "conversation_id": ep.conversation_id,
        "segment_id": ep.id,
        "quality_score": card.quality_score,
        "signal": card.signal,
        "action": action,
        "injected": injected,  # 不知道这段之前有没有被注入过：按注入过算（§5.3）
    }


def _clip(c: float) -> float:
    return round(max(0.0, min(CONF_MAX, c)), 4)


def _archive_version(store: ProjectStore, k: ExperienceCard, reason: str, replaced_by: str) -> None:
    """旧版本另存一个 status=archived 的完整节点，history 留一条精简记录指过去（MemOS 现成约定）。"""
    snap = ExperienceCard.from_node(new_uuid(), {**k.to_props(), "user_name": k.space_id})
    snap.space_id = k.space_id
    snap.node_status = "archived"
    snap.merged_into = k.id
    snap_props_reason = {"reason": reason, "replaced_by": replaced_by}
    store.put_experience(snap)
    k.history.append(
        {
            "version": k.version,
            "memory": k.memory_text,
            "update_type": "duplicate",
            "archived_memory_id": snap.id,
            "created_at": now_iso(),
            **snap_props_reason,
        }
    )


def apply(
    store: ProjectStore,
    ep: Episode,
    card: ExperienceCard,
    action: str,
    target: ExperienceCard | None,
    merged: dict[str, Any] | None,
    reason: str,
) -> dict[str, Any]:
    author = ep.members[0].user_id if ep.members else ""
    card.space_id, card.time = (
        ep.space_id,
        card.time or (ep.messages[-1].chat_time if ep.messages else now_iso()),
    )
    card.session_id = card.session_id or ep.conversation_id
    card.user_id = card.user_id or author
    card.author_ids = card.author_ids or [author]
    if ep.topic_id and ep.topic_id not in card.topic_ids:
        card.topic_ids.append(ep.topic_id)
    signaled = card.signal not in ("", "none", None)

    if action in (EXP_ADD, "add_opposed"):
        card.confidence = CONF_NEW
        if action == "add_opposed":
            card.exp_status = EXP_CANDIDATE if card.exp_status == EXP_VERIFIED else card.exp_status
        card.last_supported_at = card.time if signaled else ""
        card.sources = [_evidence(EXP_ADD, card, ep)]
        out = {
            "op": action,
            "id": card.id,
            "task_intent": card.task_intent,
            "confidence": card.confidence,
            "reason": reason,
        }
        if action == "add_opposed" and target is not None:
            # 先条件写被反对的那张卡：撞了就整体重判，不会留下一张多出来的新卡
            target.sources.append(
                {
                    **_evidence(EXP_ADD, card, ep),
                    "note": "有成员提出相反说法（未验证）",
                    "opposed_by": card.id,
                }
            )
            store.put_experience(target, expected_rev=target.rev)
            out["opposes"] = target.id
        store.put_experience(card)
        return out

    assert target is not None
    k = target
    seen_conv = {s.get("conversation_id") for s in k.sources}
    ev = _evidence(action, card, ep)
    before = k.confidence

    if action == EXP_CONFIRM:
        if not (ev["injected"] and not signaled) and ep.conversation_id not in seen_conv:
            k.confidence = _clip(k.confidence + 0.05)
    elif action in (EXP_UPDATE, EXP_REFUTE):
        _archive_version(store, k, reason, ev["message_id"])
        for f in CARD_FIELDS:
            if merged and f in merged and merged[f] is not None:
                setattr(k, f, merged[f])
        allowed = set(card.anchors) | set(target.anchors)
        k.anchors = [a for a in k.anchors if a in allowed][:MAX_ANCHORS]
        k.version += 1
        k.confidence = _clip(k.confidence + (0.10 if action == EXP_UPDATE else -0.20))
        for a in card.author_ids:
            if a not in k.author_ids:
                k.author_ids.append(a)
        if action == EXP_REFUTE and card.validation:
            k.validation = card.validation

    if k.exp_status == EXP_CANDIDATE and action in (EXP_CONFIRM, EXP_UPDATE) and signaled:
        k.exp_status = EXP_VERIFIED
    if action in (EXP_UPDATE, EXP_REFUTE) or (action == EXP_CONFIRM and signaled):
        k.last_supported_at = card.time
    if k.confidence < CONF_MIN:
        k.node_status = "archived"
    k.sources.append(ev)
    if ep.topic_id and ep.topic_id not in k.topic_ids:
        k.topic_ids.append(ep.topic_id)
    store.put_experience(k, expected_rev=target.rev)
    return {
        "op": action,
        "id": k.id,
        "task_intent": k.task_intent,
        "confidence": k.confidence,
        "delta": round(k.confidence - before, 4),
        "version": k.version,
        "reason": reason,
    }


def lifecycle(k: ExperienceCard, now: datetime | None = None) -> str:
    if k.node_status == "archived" or k.confidence < CONF_MIN or k.merged_into:
        return "archived"
    if k.last_supported_at:
        try:
            t = datetime.fromisoformat(k.last_supported_at)
            now = now or datetime.now(t.tzinfo)
            if (now - t).days > STALE_DAYS:
                return "stale"
        except ValueError:
            pass
    return "active"


def visible(k: ExperienceCard, user_id: str) -> bool:
    """vis(k, m)：已验证或失败经验对所有人可见；待验证只给作者本人。"""
    return k.exp_status in (EXP_VERIFIED, EXP_FAILED) or user_id in k.author_ids


# ── 一段的完整流程 ──────────────────────────────────────────────────────────


def run(hub: ModelHub, store: ProjectStore, ep: Episode, log, lock=None) -> list[dict[str, Any]]:
    """一段的经验流程：闸 → 过滤 → 抽卡 → 召回 → 合并判断 → 写回。

    并发：抽卡与合并判断不加锁。改已有卡靠条件写（撞了重读重判）；新建卡时（`lock` 不为空）
    拿这个 Space 的经验锁复核一次：判断之后如果别的段新建了相近的卡，重新判断，避免两段同时
    各建一张同样的卡。
    """
    from .locks import exp_key

    ok, why = rule_gate(ep)
    if not ok:
        log(f"  经验：规则闸不过（{why}）")
        return []
    from_note = any(m.notes for m in ep.agents)
    if not from_note and os.getenv("EXPERIENCE_EXTRACT_MODE", "two_step") == "two_step":
        ok, why = should_extract(hub, ep)
        log(f"  经验过滤：{'抽' if ok else '不抽'}（{why}）")
        if not ok:
            return []
    card, why = extract_card(hub, ep)
    if card is None:
        log(f"  经验：不出卡片（{why}）")
        return []
    for n in code_check(card, ep, from_note):
        log(f"  经验校验：{n}")
    card.space_id = ep.space_id
    card.time = ep.messages[-1].chat_time if ep.messages else now_iso()

    def _cands() -> list[ExperienceCard]:
        ranked = store.recall_experiences(ep.space_id, card.index_text, RECALL_TOP_K)
        return [k for _, k in ranked if lifecycle(k) != "archived"]

    for attempt in range(MAX_CAS_RETRIES):
        cands = _cands()
        seen = {k.id for k in cands}
        if not cands:
            final, target, merged, reason = EXP_ADD, None, None, "没有召回到已有经验"
        else:
            out = merge(hub, card, cands)
            action = str(out.get("action") or EXP_ADD)
            target = next((k for k in cands if k.id == out.get("target_id")), None)
            merged = out.get("card") if isinstance(out.get("card"), dict) else None
            final, guard_reason = guard(action, card, target, merged)
            if final != action:
                log(f"  经验护栏：模型给 {action}，改为 {final}（{guard_reason}）")
            reason = out.get("reason") or guard_reason
        last = attempt == MAX_CAS_RETRIES - 1
        try:
            if final in (EXP_ADD, "add_opposed") and lock is not None:
                with lock(exp_key(ep.space_id)):
                    if not last and {k.id for k in _cands()} - seen:
                        log(f"  经验：判断期间别的段新建了相近的卡（第 {attempt + 1} 次），重判")
                        continue
                    res = apply(store, ep, card, final, target, merged, reason)
            else:
                res = apply(store, ep, card, final, target, merged, reason)
        except ConcurrentUpdateError:
            log(f"  经验写回冲突（第 {attempt + 1} 次）：这张卡刚被别的任务改过，重读重判")
            continue
        if final == EXP_ADD and not cands:
            log(
                f"  经验新增 {res['id'][:8]}：{card.task_intent}"
                f"（{card.exp_status}，{card.confidence}）"
            )
        else:
            log(
                f"  经验 {res['op']} → {res['id'][:8]}（confidence {res.get('confidence')}）："
                f"{res.get('reason', '')}"
            )
        return [res]
    log(f"  经验写回连续冲突 {MAX_CAS_RETRIES} 次，放弃这一段")
    return []
