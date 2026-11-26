"""决策模块：两次模型调用（《决策抽取 · 维护 · 冲突处理 模块方案评审》§5）。

    𝒰 = 𝒲 ∘ 𝒢 ∘ ℳ ∘ 𝒱 ∘ 𝒳
    𝒳  第一次调用：判定 + 抽取（9 个字段）             → extract()
    𝒱  代码核对：成员消息、原话、sure、content、listed  → verify()
    ℳ  第二次调用：更新 + 冲突识别与解决（7 个字段）    → update()
    𝒢  代码护栏：动作由代码按模型给的指向和条件重算      → decide()
    𝒲  落库：五种动作的状态转移 + 三条不变式            → apply()

召回范围：只在这一段归到的主题里（11/17 定：先按不跨主题设计）。召回为空时不调第二次，直接新增。
"""

from __future__ import annotations

import re
import unicodedata

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .add_limits import LIMITS, cut_at_sentence
from .judge import ModelError
from .prompts import DECISION_EXTRACT, DECISION_UPDATE
from .types import (
    OP_ADD,
    OP_CONFLICT,
    OP_JOIN,
    OP_RESOLVE,
    OP_REWRITE,
    ConflictItem,
    Decision,
    DecisionDraft,
    Episode,
    HistoryItem,
    InvariantError,
    Msg,
    Source,
)


if TYPE_CHECKING:
    from .judge import ModelHub


MAX_TOPIC_DECISIONS = 50
CATEGORIES = ("范围", "对外约定", "共同约定")


# ── 归一与逐字核对 ──────────────────────────────────────────────────────────


def norm(s: str) -> str:
    """全半角归一（NFKC）+ 空白压成一个空格，再逐字比。"""
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", " ", s).strip()


def contains(haystack: str, needle: str) -> bool:
    return bool(needle) and norm(needle) in norm(haystack)


# ── 𝒳 第一次调用：判定 + 抽取 ───────────────────────────────────────────────


def _row(m: Msg) -> dict[str, Any]:
    out: dict[str, Any] = {"id": m.id, "role": m.role, "text": m.text}
    if m.is_member:
        out["name"] = m.speaker
    return out


def extract_inputs(ep: Episode, members: list[str]) -> dict[str, Any]:
    """决策不读工具返回：只给成员的话和 Agent 的回复。"""

    def keep(ms: list[Msg]) -> list[dict[str, Any]]:
        return [_row(m) for m in ms if m.role in ("member", "agent")]

    return {"prev": keep(ep.prev), "episode": keep(ep.messages), "members": members}


def extract(hub: ModelHub, ep: Episode, members: list[str]) -> tuple[bool, list[DecisionDraft]]:
    if not ep.members:
        return False, []  # 没有成员消息：不调模型
    out = hub.write("dec.extract", DECISION_EXTRACT, extract_inputs(ep, members))
    has = bool(out.get("has_decision"))
    drafts: list[DecisionDraft] = []
    for row in out.get("decisions") or []:
        if not isinstance(row, dict):
            continue
        drafts.append(
            DecisionDraft(
                message_id=str(row.get("message_id") or ""),
                quote=str(row.get("quote") or ""),
                content=row.get("content"),
                category=str(row.get("category") or ""),
                change_reason=row.get("change_reason"),
                sure=bool(row.get("sure", False)),
                final=bool(row.get("final", False)),
                approved_by=[str(x) for x in row.get("approved_by") or []],
                listed=[str(x) for x in row.get("listed") or []],
            )
        )
    return has and bool(drafts), drafts


# ── 𝒱 代码核对 ─────────────────────────────────────────────────────────────


def verify(
    ep: Episode, drafts: list[DecisionDraft], members: list[str]
) -> tuple[list[DecisionDraft], list[dict[str, Any]]]:
    by_id = {m.id: m for m in ep.messages}
    ordered = list(ep.prev) + list(ep.messages)
    kept: list[DecisionDraft] = []
    dropped: list[dict[str, Any]] = []

    def drop(d: DecisionDraft, reason: str) -> None:
        dropped.append(
            {
                "kind": "decision",
                "reason": reason,
                "message_id": d.message_id,
                "quote": d.quote,
                "content": d.content,
            }
        )

    for d in drafts:
        m = by_id.get(d.message_id)
        if m is None or not m.is_member:
            drop(d, "message_id 不是这一段里成员的消息")
            continue
        if not contains(m.text, d.quote):
            drop(d, "source_mismatch：原话在那条成员消息里找不到")
            continue
        if not d.sure:
            drop(d, "sure=false：看不出要不要团队照做，不写入")
            continue
        if not d.content:
            drop(d, "content 为空：找不到所指的内容，暂缓")
            continue
        d.content = cut_at_sentence(d.content, LIMITS.decision)[0]
        if d.category not in CATEGORIES:
            d.category = "共同约定"
        # 代码从消息元数据补说话人与时间：说话人就是这项结论的负责人
        d.user_id, d.name, d.time = m.user_id or m.name, m.speaker, m.chat_time
        # 「已和谁确认」要能在原话里落到人身上：照原方案（T1 §2.3），名字须在成员名单里、
        # 不是说话人本人，并且在那条消息里出现过。项目记忆实测里大模型常把「已和 X 确认」编出来。
        d.approved_by = [n for n in d.approved_by if n in members and n != d.name and n in m.text]
        before = _agent_text_before(ordered, d.message_id)
        d.listed = [x for x in d.listed if contains(before, x)]
        kept.append(d)
    return kept, dropped


def _agent_text_before(ordered: list[Msg], message_id: str) -> str:
    buf: list[str] = []
    for m in ordered:
        if m.id == message_id:
            break
        if m.role == "agent":
            buf.append(m.text)
    return "\n".join(buf)


# ── ℳ 第二次调用：更新 + 冲突识别与解决 ───────────────────────────────────────


def update_inputs(
    drafts: list[DecisionDraft], decisions: list[Decision], topic_name: str
) -> dict[str, Any]:
    new = [
        {
            "n": i + 1,
            "name": d.name,
            "time": d.time,
            "content": d.content,
            "quote": cut_at_sentence(d.quote, LIMITS.quote)[0],
            "final": d.final,
            "approved_by": d.approved_by,
            "listed": d.listed,
        }
        for i, d in enumerate(drafts)
    ]
    olds = []
    for dec in decisions:
        items = []
        for key, it in dec.items().items():
            items.append(
                {
                    "item": key,
                    "members": [dec.user_labels.get(u, u) for u in it.user_ids],
                    "time": it.time,
                    "text": it.content,
                    "quote": cut_at_sentence(it.source.quote or "", LIMITS.quote)[0],
                }
            )
        olds.append({"id": dec.id, "topic": topic_name, "items": items})
    return {"new": new, "decisions": olds}


def _require_complete_updates(
    rows: Any, count: int, decisions: list[Decision]
) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or len(rows) != count:
        raise ModelError("Decision update must return one result for each Draft")
    candidates = {decision.id: decision for decision in decisions}
    by_n: dict[int, dict[str, Any]] = {}
    for row in rows:
        index = row.get("n") if isinstance(row, dict) else None
        if type(index) is not int or not 1 <= index <= count or index in by_n:
            raise ModelError("Decision update has an invalid or duplicate Draft number")
        target = row.get("decision_id")
        same_as = row.get("same_as")
        if target is None:
            if "decision_id" not in row or row.get("action") != OP_ADD or same_as is not None:
                raise ModelError("Decision update must explicitly select add for a new Decision")
        elif not isinstance(target, str) or target not in candidates:
            raise ModelError("Decision update references a Decision outside the snapshot")
        elif "same_as" not in row:
            raise ModelError("Decision update must include same_as for an existing Decision")
        elif same_as is not None and (
            not isinstance(same_as, str) or same_as not in candidates[target].items()
        ):
            raise ModelError("Decision update references an unknown Decision option")
        by_n[index] = row
    return [by_n[index] for index in range(1, count + 1)]


def update(
    hub: ModelHub,
    drafts: list[DecisionDraft],
    decisions: list[Decision],
    topic_name: str,
    *,
    require_complete: bool = False,
) -> list[dict[str, Any]]:
    out = hub.write("dec.update", DECISION_UPDATE, update_inputs(drafts, decisions, topic_name))
    if require_complete:
        return _require_complete_updates(out.get("results"), len(drafts), decisions)
    rows = [r for r in out.get("results") or [] if isinstance(r, dict)]
    by_n = {int(r.get("n", 0) or 0): r for r in rows}
    return [
        by_n.get(i + 1, {"n": i + 1, "decision_id": None, "action": OP_ADD})
        for i in range(len(drafts))
    ]


# ── 𝒢 代码护栏：动作由代码重算 ───────────────────────────────────────────────


@dataclass
class Plan:
    """一条新决策最终怎么处理。"""

    action: str
    decision_id: str | None = None
    same_as: str | None = None
    model_action: str = ""
    reason: str = ""
    guarded: list[str] = field(default_factory=list)  # 被护栏改掉的原因
    informed: dict[str, str] = field(default_factory=dict)
    merge_with: str = ""  # rewrite 时并入某一项（decide 给，或负责人改投时由 apply 补）


def decide(draft: DecisionDraft, row: dict[str, Any], candidates: dict[str, Decision]) -> Plan:
    """π 的五行（§5.2）用模型给的指向（decision_id、same_as）与 informed，
    own / late 由代码查库算；结果与模型的 action 不一致时以代码为准，记进 guarded。"""
    model_action = str(row.get("action") or "")
    plan = Plan(action=OP_ADD, model_action=model_action, reason=str(row.get("reason") or ""))

    did = row.get("decision_id")
    dec = candidates.get(did) if did else None
    if did and dec is None:
        plan.guarded.append(f"decision_id {did} 不在召回的决策里，按新增")
    if dec is None:
        return _finish(plan, OP_ADD)
    plan.decision_id = dec.id

    items = dec.items()
    same_as = row.get("same_as")
    if same_as and same_as not in items:
        plan.guarded.append(f"same_as {same_as} 不是这条决策里的项，按没有相同项")
        same_as = None
    plan.same_as = same_as

    if same_as is None and dec.source.message_id and dec.source.message_id == draft.message_id:
        # One message stating several rules yields sibling decisions; a member does not revise
        # a rule with the next clause of the same sentence.
        plan.decision_id = None
        plan.guarded.append("同一条消息里拆出的另一条规则，按新增")
        return _finish(plan, OP_ADD)

    # Only the owner changes their own decision. A member relaying that the owner agreed
    # ("B 同意改成…") is not the owner's statement, so it stays a conflict for people to settle.
    own = draft.user_id in dec.user_ids
    late = not (draft.time and dec.time and draft.time < dec.time)
    informed = row.get("informed")
    evidence = {
        key: quote
        for key, quote in (informed.items() if isinstance(informed, dict) else ())
        if key in items and isinstance(quote, str) and quote.strip() and quote in draft.listed
    }
    inf = bool(items) and len({"".join(quote.split()) for quote in evidence.values()}) == len(items)
    if inf:
        plan.informed = evidence

    if dec.conflicts and draft.final and same_as and inf and late:
        action = OP_RESOLVE
    elif same_as is None and own and late:
        action = OP_REWRITE
    elif same_as is not None:
        action = OP_JOIN
    else:
        action = OP_CONFLICT

    if model_action and model_action != action:
        why = {
            OP_RESOLVE: "满足拍板的全部条件",
            OP_REWRITE: "说话人是负责人，且不早于当前结论",
            OP_JOIN: "与已有的一项结论相同",
            OP_CONFLICT: "结论不同，说话人不是负责人",
        }[action]
        if model_action == OP_RESOLVE and not late:
            why = "这句话早于当前结论，不能拍板"
        elif model_action == OP_RESOLVE and not inf:
            why = "Agent 没把各项都说给他听（informed 没覆盖全部项或对不上 listed）"
        elif model_action == OP_REWRITE and not own:
            why = "说话人不是负责人；转述负责人同意不算授权"
        elif model_action == OP_REWRITE and not late:
            why = "这句话早于当前结论，不能改写"
        plan.guarded.append(f"模型给 {model_action}，代码改为 {action}：{why}")
    return _finish(plan, action)


def _finish(plan: Plan, action: str) -> Plan:
    plan.action = action
    return plan


# ── 𝒲 落库 ─────────────────────────────────────────────────────────────────


def new_decision(draft: DecisionDraft, ep: Episode, topic_id: str) -> Decision:
    d = Decision(
        space_id=ep.space_id,
        topic_id=topic_id,
        content=draft.content or "",
        time=draft.time,
        user_ids=[draft.user_id],
        source=Source(ep.conversation_id, draft.message_id, draft.quote),
        category=draft.category,
        reason=draft.change_reason or "",
        user_labels={draft.user_id: draft.name},
    )
    d.check()
    return d


def apply(
    dec: Decision, plan: Plan, draft: DecisionDraft, conversation_id: str
) -> tuple[Decision | None, Plan]:
    """照 §5.2 的状态转移表改一条决策。

    返回（改后的决策，实际执行的动作）。决策为 None 表示不写入（他已经在那一项里）；
    实际动作可能与 `plan.action` 不同：负责人改投某一项时，护栏把 join 处理成并入（rewrite）。
    """
    out = Decision.from_node(dec.id, dec.content, {"project": dec.to_project()})
    u = draft.user_id
    out.user_labels[u] = draft.name
    src = Source(conversation_id, draft.message_id, draft.quote)
    new_item = ConflictItem(0, draft.content or "", draft.time, [u], src)
    before = {c.seq: c.content for c in out.conflicts}
    h0 = len(out.history)

    def to_history(item: ConflictItem, reason: str) -> None:
        out.history.append(
            HistoryItem(
                len(out.history) + 1,
                item.content,
                item.time,
                list(item.user_ids),
                item.source,
                reason,
                src,
            )
        )

    def move_out(keep: str | None) -> None:
        """一位成员只占一项：从别的项移出；当前结论只剩他一人时不移；被移空的不一致结论进历史。"""
        if keep != "current" and u in out.user_ids and len(out.user_ids) > 1:
            out.user_ids.remove(u)
        for c in list(out.conflicts):
            if f"c{c.seq}" != keep and u in c.user_ids:
                c.user_ids.remove(u)
                if not c.user_ids:
                    to_history(c, f"{draft.name} 改为支持另一项结论")
                    out.conflicts.remove(c)

    action = plan.action
    if action == OP_JOIN and plan.same_as not in (None, "current"):
        target = plan.same_as
        if out.item_of(u) == target:
            return None, plan
        if u in out.user_ids and len(out.user_ids) == 1:
            # 说话人是当前结论唯一的负责人，却改去支持某一项不一致结论。
            # 「一位成员只占一项」和「当前结论有负责人」在这里冲突：移出他会让当前结论没人。
            # 按语义处理成「并入那一项」——那一项成为当前结论，原结论进历史，其余各项保留。
            action = OP_REWRITE
            plan = Plan(
                action=OP_REWRITE,
                decision_id=plan.decision_id,
                same_as=target,
                model_action=plan.model_action,
                reason=plan.reason,
                guarded=[
                    *plan.guarded,
                    "负责人改去支持某一项不一致结论：并入那一项，原结论进历史",
                ],
                informed=plan.informed,
                merge_with=target,
            )

    if action == OP_JOIN:
        target = plan.same_as or "current"
        if out.item_of(u) == target:
            return None, plan
        move_out(target)
        grp = out.user_ids if target == "current" else out.conflict(target).user_ids
        grp.append(u)

    elif action == OP_CONFLICT:
        mine = out.item_of(u)
        if mine and mine.startswith("c"):
            c = out.conflict(mine)  # 他已有自己独占的一项：更新那一项
            if len(c.user_ids) == 1:
                c.content, c.time, c.source = new_item.content, new_item.time, src
            else:
                move_out(None)
                out.conflicts.append(
                    ConflictItem(_next_seq(out), new_item.content, new_item.time, [u], src)
                )
        else:
            move_out(None)
            out.conflicts.append(
                ConflictItem(_next_seq(out), new_item.content, new_item.time, [u], src)
            )

    elif action == OP_REWRITE:
        reason = draft.change_reason or f"{draft.name} 更新了这条决策"
        to_history(out.items()["current"], reason)
        if plan.merge_with:
            # 并入某一项不一致结论：它成为当前结论，原结论进历史，其余各项保留
            item = out.conflict(plan.merge_with)
            out.conflicts = [x for x in out.conflicts if x.seq != item.seq]
            out.content, out.time, out.source = item.content, item.time, item.source
            out.user_ids = list(item.user_ids) + ([u] if u not in item.user_ids else [])
        else:
            out.content, out.time, out.source, out.user_ids = (
                new_item.content,
                new_item.time,
                src,
                [u],
            )
        move_out("current")

    elif action == OP_RESOLVE:
        chosen_key = plan.same_as or "current"
        chosen = out.items()[chosen_key]
        reason = f"{draft.name} 确定以「{_short(chosen.content)}」为准"
        for key, it in out.items().items():
            if key != chosen_key:
                to_history(it, reason)
        out.content, out.source = chosen.content, chosen.source
        out.user_ids = list(chosen.user_ids) + ([u] if u not in chosen.user_ids else [])
        out.time = draft.time
        out.conflicts = []

    else:
        raise ValueError(f"未知动作 {action}")

    out.version += 1
    out.rev = dec.rev
    out.check()
    gone = [c for s, c in before.items() if s not in {x.seq for x in out.conflicts}]
    landed = {h.content for h in out.history[h0:]} | {out.content}
    for c in gone:
        if c not in landed:
            raise InvariantError(f"不变式 2：不一致结论「{c}」被移走但没有进历史")
    return out, plan


def _next_seq(d: Decision) -> int:
    return max([c.seq for c in d.conflicts] + [0]) + 1


def _short(s: str, n: int = 24) -> str:
    return s if len(s) <= n else s[:n] + "…"
