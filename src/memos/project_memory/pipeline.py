# -*- coding: utf-8 -*-
"""主干：add/message → episode 切分 → 归主题 →（并行）决策抽取+合并、经验抽取+合并 → 落库；
search/memory → 召回主题 → 带出决策、经验、轨迹，组装 PRD 的 `topic_detail_list`。

上下游约定（T1 §1）：
- 进展抽取与归主题在抽取之前做，归主题是上游（冉浚枫）。主干先给一个可替换的默认实现
  `SimpleTopicAssigner`，接口定成 `assign(episode) -> Topic`，方便换成他们的归类模块。
- 一个 episode 归到一个主题；关段原因、时间先后都记进 trace。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import decision as dec
from . import experience as exp
from .episode import split_episodes
from .judge import judge, one, write
from .store import ProjectMemoryStore
from .types import (
    Decision,
    DecisionDraft,
    Episode,
    ExperienceCard,
    IngestResult,
    Msg,
    PROJECT_DECISION,
    PROJECT_EXPERIENCE,
    PROJECT_TOPIC,
    Topic,
    new_id,
    now_iso,
)


Q_NEW_TOPIC = "is_new_topic"


# ── 归主题（上游，可替换）────────────────────────────────────────────────────


class SimpleTopicAssigner:
    """默认实现：先召回本 Space 的主题，判「这一段推进的是不是已有主题」。
    判不出来就新建。真正的归类由冉浚枫的模块接进来，接口不变。
    """

    def __init__(self, store: ProjectMemoryStore, default_domain: str = "未分类"):
        self.store = store
        self.default_domain = default_domain

    def assign(self, ep: Episode, answers: dict[str, Any] | None = None, new_topic: dict[str, Any] | None = None, key: str = "") -> Topic:
        text = "\n".join(m.text for m in ep.messages if m.role != "tool")
        cands = self.store.recall_topics(ep.space_id, text, top_k=5)
        if cands:
            payload = {
                "segment": text,
                "topics": [{"id": t.id, "summary": t.summary} for t in cands],
                "_answers": (answers or {}).get(key) or (answers or {}).get("*") or {},
            }
            if one(judge("topic.assign", payload, [Q_NEW_TOPIC]), Q_NEW_TOPIC).value == "no":
                chosen = cands[0]
                chosen.sources = _append_source(chosen.sources, ep)
                chosen.description = (new_topic or {}).get("description") or chosen.description
                self.store.put_topic(chosen)
                return chosen

        gen = new_topic or {}
        topic = Topic(
            id=new_id("topic"),
            space_id=ep.space_id,
            domain=gen.get("domain") or self.default_domain,
            name=gen.get("name") or _fallback_name(ep),
            summary=gen.get("summary") or "",
            description=gen.get("description") or "",
        )
        topic.sources = _append_source([], ep)
        self.store.put_topic(topic)
        return topic


def _per_episode(table: dict[str, Any], key: str) -> dict[str, Any]:
    """剧本按段存放：`{段键: {...}}`。取不到就是空（mock 后端会答拿不准）。"""
    got = table.get(key)
    return got if isinstance(got, dict) else {}


def episode_key(ep: Episode) -> str:
    """剧本的键：这一段第一条成员消息的 id（稳定，跑两次也对得上）。"""
    return ep.members[0].id if ep.members else ep.id


def _append_source(sources: list[dict[str, Any]], ep: Episode) -> list[dict[str, Any]]:
    out = list(sources)
    for m in ep.members:
        key = (ep.conversation_id, m.user_id or m.name)
        if not any((s.get("conversation_id"), s.get("user_id")) == key for s in out):
            out.append({"conversation_id": ep.conversation_id, "user_id": m.user_id or m.name,
                        "agent_id": "", "agent_name": ""})
    return out


def _fallback_name(ep: Episode) -> str:
    first = next((m.text for m in ep.members if m.text), "")
    return (first[:18] + "…") if len(first) > 18 else (first or "未命名主题")


# ── 主干 ───────────────────────────────────────────────────────────────────


@dataclass
class MockScript:
    """mock add 的剧本：每个 episode 里，模型该答什么。

    真跑时这些由模型给；主干用它们把链路跑通并固定样例（T1 的样例输出就是手写的期望结果）。
    """

    gate: dict[str, str] = field(default_factory=dict)
    extract: dict[str, Any] = field(default_factory=dict)
    rank: dict[str, Any] = field(default_factory=dict)
    same_problem: dict[str, Any] = field(default_factory=dict)
    same_conclusion: dict[str, Any] = field(default_factory=dict)
    informed: dict[str, Any] = field(default_factory=dict)
    topic_assign: dict[str, str] = field(default_factory=dict)
    new_topic: dict[str, Any] = field(default_factory=dict)
    exp_filter: dict[str, str] = field(default_factory=dict)
    exp_extract: dict[str, Any] = field(default_factory=dict)
    exp_merge: dict[str, Any] = field(default_factory=dict)
    exp_dedup: dict[str, str] = field(default_factory=dict)


class ProjectMemoryPipeline:
    def __init__(
        self,
        store: ProjectMemoryStore,
        topic_assigner: SimpleTopicAssigner | None = None,
        script: MockScript | None = None,
    ):
        self.store = store
        self.assigner = topic_assigner or SimpleTopicAssigner(store)
        self.script = script or MockScript()

    # —— 写入 ——
    def ingest(
        self,
        space_id: str,
        conversation_id: str,
        messages: list[Msg],
        boundary_flags: list[bool] | None = None,
        note_after: set[str] | None = None,
        notes: dict[str, dict[str, Any]] | None = None,
    ) -> IngestResult:
        result = IngestResult()
        episodes = split_episodes(messages, space_id, conversation_id, boundary_flags, note_after)
        result.log(f"切成 {len(episodes)} 段：{[ep.closed_reason for ep in episodes]}")

        for idx, ep in enumerate(episodes):
            key = episode_key(ep)
            topic = self.assigner.assign(ep, self.script.topic_assign, self.script.new_topic, key)
            ep.topic_id = topic.id
            if topic.id not in result.topic_ids:
                result.topic_ids.append(topic.id)
            result.log(f"第 {idx + 1} 段（{ep.closed_reason}）归到主题 {topic.name or topic.id}")

            self._run_decisions(ep, result, key)
            self._run_experiences(ep, result, (notes or {}).get(ep.id), key)

        return result

    # —— 决策：抽取 → 同类识别 → 冲突 ——
    def _run_decisions(self, ep: Episode, result: IngestResult, key: str) -> None:
        ok, why = dec.has_decision(ep, {"has_decision": self.script.gate.get(key, "yes")})
        result.log(f"  有没有决策：{'有' if ok else '无'}（{why}）")
        if not ok:
            return

        drafts = dec.extract_drafts(ep, self.script.extract.get(key))
        kept, dropped = dec.verify_drafts(ep, drafts, ep.conversation_id)
        result.dropped.extend(dropped)
        result.log(f"  抽取 {len(drafts)} 条，核对后留下 {len(kept)} 条")
        for d in dropped:
            result.log(f"  丢弃：{d['reason']}｜{d.get('quote', '')}")

        for d in kept:
            self._merge_one(d, ep, result, key)

    def _merge_one(self, d: DecisionDraft, ep: Episode, result: IngestResult, key: str) -> None:
        cands = self.store.recall_decisions(ep.space_id, d.content, top_k=dec.RECALL_TOP_K)
        rank_preset = _per_episode(self.script.rank, key)
        same_topic_preset = _per_episode(self.script.same_problem, key)
        cand, why = dec.pick_same_question(d, cands, {**rank_preset, **same_topic_preset})
        result.log(f"  同类识别：{why}")
        if cand is None:
            new = Decision(
                id=new_id("dec"),
                space_id=ep.space_id,
                topic_id=ep.topic_id,
                content=d.content,
                time=d.chat_time,
                user_ids=[d.user_id] if d.user_id else [],
                source=_src(d, ep),
                category=d.category,
                reason=d.change_reason,
                user_labels={d.user_id: d.user_name} if d.user_id and d.user_name else {},
            )
            new.check()
            self.store.put_decision(new)
            result.decision_ops.append({"op": "add", "decision_id": new.id, "content": new.content})
            result.log(f"  新增决策 {new.id}：{new.content}")
            return

        fresh = self.store.get_decision(cand.id, ep.space_id) or cand
        same_conclusion = _per_episode(self.script.same_conclusion, key)
        informed = _per_episode(self.script.informed, key)
        action = dec.decide_action(d, fresh, ep.conversation_id, {**same_conclusion, **informed})
        after = dec.apply_action(fresh, action)
        if d.user_id and d.user_name:
            after.user_labels[d.user_id] = d.user_name
        self.store.put_decision(after)
        result.decision_ops.append(
            {
                "op": action.op,
                "decision_id": after.id,
                "target": action.target,
                "content": after.content,
                "conflicts": [c.content for c in after.conflicts],
                "history": [h.content for h in after.history],
                "reason": action.reason,
            }
        )
        result.log(f"  {action.op}（{action.target or '-'}）：{action.reason} → 当前结论「{after.content}」")

    # —— 经验：规则闸 → 过滤 → 抽卡片 → 合并 ——
    def _run_experiences(self, ep: Episode, result: IngestResult, note: dict[str, Any] | None, key: str) -> None:
        ok, why = exp.passes_rule_gate(ep)
        if not ok:
            result.log(f"  经验：跳过（{why}）")
            return
        if note is None:
            ok2, why2 = exp.should_extract(ep, answers=_exp_filter_answers(self.script.exp_filter.get(key)))
            result.log(f"  经验过滤：{'抽' if ok2 else '不抽'}（{why2}）")
            if not ok2:
                return
        card = exp.extract_card(ep, self.script.exp_extract.get(key), note)
        if card is not None:
            card.user_labels = {m.user_id or m.name: (m.name or m.user_id) for m in ep.members}
        if card is None:
            result.log("  经验：抽卡返回空")
            return

        cands = self.store.recall_experiences(ep.space_id, card.index_text, top_k=10)
        merged = exp.merge_card(card, cands, self.script.exp_merge.get(key))
        for act in merged["actions"]:
            self._apply_experience_action(act, card, ep, result)

    def _apply_experience_action(self, act: dict[str, Any], card: ExperienceCard, ep: Episode, result: IngestResult) -> None:
        src = {"segment_id": ep.id, "conversation_id": ep.conversation_id,
               "user_ids": card.user_ids, "time": card.time, "signal": card.signal}

        if act["op"] == "create":
            new = ExperienceCard.from_json({**card.to_json(), **(act.get("card") or {})})
            new.space_id, new.topic_id = ep.space_id, ep.topic_id
            new.sources = [src]
            self.store.put_experience(new)
            result.experience_ops.append({"op": "create", "id": new.id, "task_intent": new.task_intent})
            result.log(f"  经验新增 {new.id}：{new.task_intent}（{new.confidence}）")
            return

        target = self.store.get_experience(act.get("id") or "", ep.space_id)
        if target is None:
            new = ExperienceCard.from_json({**card.to_json(), **(act.get("card") or {})})
            new.space_id, new.topic_id = ep.space_id, ep.topic_id
            self.store.put_experience(new)
            result.experience_ops.append({"op": "create", "id": new.id, "task_intent": new.task_intent,
                                          "reason": f"要改的 {act.get('id')} 不存在，按新增处理"})
            return

        if act["op"] == "update":
            body = act.get("card") or {}
            before = target.confidence
            for k, v in body.items():
                if k in ("id", "space_id", "topic_id", "sources", "time", "use_count"):
                    continue
                if hasattr(target, k):
                    setattr(target, k, v)
            # 再次确认 +0.05、新增分支 +0.1（经验方案 §3.2 的样例）
            delta = 0.1 if body.get("form") == "principle" or body.get("technical_context") else 0.05
            target.confidence = min(1.0, round(target.confidence + delta, 2))
            if src not in target.sources:
                target.sources.append(src)
            self.store.put_experience(target)
            result.experience_ops.append(
                {"op": "update", "id": target.id, "confidence": target.confidence,
                 "reason": act.get("reason", ""), "delta": round(target.confidence - before, 2)}
            )
            result.log(f"  经验更新 {target.id}：{before} → {target.confidence}（{act.get('reason', '')}）")
            return

        if act["op"] == "delete":
            target.status = "revoked"
            target.merged_into = act.get("merged_into", "")  # type: ignore[attr-defined]
            self.store.put_experience(target)
            result.experience_ops.append({"op": "delete", "id": target.id,
                                          "merged_into": act.get("merged_into"), "reason": act.get("reason", "")})
            result.log(f"  经验删除 {target.id} → {act.get('merged_into')}")

    # —— 读取 ——
    def search(self, space_id: str, query: str, limit: int = 9) -> dict[str, Any]:
        """组装 PRD 的 `topic_detail_list`：主题摘要与描述 + 与 query 相关的条目。"""
        topics = self.store.recall_topics(space_id, query, top_k=limit)
        out: list[dict[str, Any]] = []
        for t in topics:
            decisions = [d for d in self.store.list_decisions(space_id) if d.topic_id == t.id]
            experiences = [e for e in self.store.list_experiences(space_id) if e.topic_id == t.id]
            out.append(
                {
                    "id": t.id,
                    "space_id": t.space_id,
                    "domain": t.domain,
                    "topic_name": t.name,
                    "topic_summary": t.summary,
                    "topic_description": t.description,
                    "decisions": [
                        {
                            "content": d.content,
                            "time": d.time,
                            "user_ids": d.user_ids,
                            "user_labels": d.user_labels,
                            **({"history": [h.to_json() for h in d.history]} if d.history else {}),
                            **({"conflicts": [c.to_json() for c in d.conflicts]} if d.conflicts else {}),
                        }
                        for d in decisions
                    ],
                    "experiences": [
                        {
                            "content": e.principle,
                            "time": e.time,
                            "user_ids": e.user_ids,
                            "user_labels": e.user_labels,
                            "form": e.form,
                            "confidence": e.confidence,
                            "status": e.status,
                        }
                        for e in sorted(experiences, key=lambda x: x.confidence, reverse=True)
                    ],
                    "timeline": [],
                    "update_time": t.update_time,
                }
            )
        return {"topic_detail_list": out}

    def get_topic(self, topic_id: str, space_id: str) -> dict[str, Any] | None:
        """get/memory/{memory_id}：返回一个主题的全部条目与来源会话（PRD §get/memory）。"""
        t = self.store.get_topic(topic_id, space_id)
        if not t:
            return None
        got = self.search(space_id, t.index_text, limit=50)
        for item in got["topic_detail_list"]:
            if item["id"] == topic_id:
                item["sources"] = t.sources
                item["create_time"] = t.create_time
                return item
        return None


def _src(d: DecisionDraft, ep: Episode):
    from .types import Source

    return Source(conversation_id=ep.conversation_id, message_id=d.message_id, quote=d.quote)


def _exp_filter_answers(preset: dict[str, str] | None) -> dict[str, Any]:
    return preset or {}


# ── 注入文本（接入方按模板拼；这里给一份能直接看的渲染）───────────────────────────


def render_injection(items: list[dict[str, Any]]) -> str:
    """照 T1 §5.3 的模板：不一致结论全部列出，历史只列最近 2 次，来源不渲染。"""
    if not items:
        return ""
    def names(item: dict[str, Any], ids: list[str]) -> str:
        labels = item.get("user_labels") or {}
        return "、".join(labels.get(i, i) for i in ids)

    lines: list[str] = ["相关决策："]
    for topic in items:
        for d in topic.get("decisions") or []:
            who = names(d, d.get("user_ids") or [])
            day = (d.get("time") or "")[5:10].replace("-", "/")
            lines.append(f"- {d['content']}（{day}，{who}）")
            for c in d.get("conflicts") or []:
                cday = (c.get("time") or "")[5:10].replace("-", "/")
                cwho = "、".join((d.get("user_labels") or {}).get(i, i) for i in (c.get("user_ids") or []))
                lines.append(f"  不一致：{c['content']}（{cday}，{cwho}）")
            for h in (d.get("history") or [])[-2:]:
                hday = (h.get("time") or "")[5:10].replace("-", "/")
                r = f"；原因：{h['reason']}" if h.get("reason") else ""
                lines.append(f"  此前：{h['content']}（{hday}{r}）")
    return "\n".join(lines)
