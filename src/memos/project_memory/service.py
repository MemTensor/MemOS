"""项目记忆服务：接口层与调度层只调这里。

写入：accept()（add 受理，同步）→ 调度消息 `project_memory`（一个 Space 一条流）→ execute()（异步）
      → 切段 → 每个关掉的段：归主题 → 决策（两次调用）→ 经验 → 写库 → 任务记录更新主题 id。
读取：search()（search/memory）、list_topics()（get/memory + space_id）、get_topic()（get/memory/{id}）。
管理：Space 4 个、领域 4 个、delete()、task_status()、get_message()。
"""

from __future__ import annotations

import contextlib
import json
import logging
import threading

from collections.abc import Callable
from typing import Any

from memos.graph_dbs.base import ConcurrentUpdateError

from . import decision as dec
from . import experience as exp
from . import topic as topic_mod
from .judge import ModelHub
from .segmenter import IDLE_MINUTES, idle_minutes_between, segment, split_turns
from .store import ProjectStore, cosine, lexical_sim
from .types import (
    OP_ADD,
    Decision,
    Domain,
    Episode,
    Msg,
    OrganizeResult,
    Space,
    TaskRecord,
    Topic,
    new_uuid,
    now_iso,
)


logger = logging.getLogger(__name__)

PROJECT_MEMORY_TASK_LABEL = "project_memory"  # 与 mem_scheduler.schemas.task_schemas 一致
MAX_DOMAINS = 20
DEFAULT_LIMIT = 9
REL_MIN = 0.12  # 条目与 query 的最低相关度（二元组相似度；接真向量后在评测集上定）
MAX_ENTRIES = 5
MAX_CAS_RETRIES = 3
MAX_TRACE_LINES = 80

Submit = Callable[[list[Any]], Any]


class ProjectMemoryService:
    def __init__(self, store: ProjectStore, hub: ModelHub, submit: Submit | None = None):
        self.store = store
        self.hub = hub
        self.submit = submit
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self.last_trace: list[str] = []  # 最近一次整理的 trace（调试、演示用）

    # ═════════════════════════════════ Space ═════════════════════════════════

    def create_space(
        self, space_name: str, instructions: str = "", domains: list[dict] | None = None
    ) -> Space:
        if not space_name or not space_name.strip():
            raise ValueError("space_name 不能为空")
        space = Space(
            space_id=new_uuid(), space_name=space_name.strip(), instructions=instructions or ""
        )
        if domains:
            space.domains = self._validate_new_domains(space, domains)
        self.store.put_space(space)
        return space

    def get_space(self, space_id: str) -> Space:
        space = self.store.get_space(space_id)
        if space is None:
            raise LookupError(f"Space 不存在：{space_id}")
        return space

    def update_space(
        self, space_id: str, space_name: str | None = None, instructions: str | None = None
    ) -> Space:
        space = self.get_space(space_id)
        if space_name is not None:
            if not space_name.strip():
                raise ValueError("space_name 不能为空")
            space.space_name = space_name.strip()
        if instructions is not None:
            space.instructions = instructions
        self.store.put_space(space)
        return space

    def delete_space(self, space_id: str) -> dict[str, Any]:
        self.get_space(space_id)
        for t in self.store.list_topics(space_id):
            self.store.delete_index(f"topic:{t.id}")
        n = self.store.delete_space_nodes(space_id)
        return {"space_id": space_id, "deleted_nodes": n}

    # ═════════════════════════════════ 领域 ══════════════════════════════════

    def _validate_new_domains(self, space: Space, domains: list[dict]) -> list[Domain]:
        names = set(space.domain_names())
        out: list[Domain] = []
        for d in domains:
            name = (d.get("name") if isinstance(d, dict) else d) or ""
            if not str(name).strip():
                raise ValueError("领域名称不能为空")
            name = str(name).strip()
            if name in names:
                raise ValueError(f"领域已存在：{name}")
            names.add(name)
            out.append(
                Domain(
                    name=name,
                    description=(d.get("description") or "") if isinstance(d, dict) else "",
                )
            )
        if len(space.domains) + len(out) > MAX_DOMAINS:
            raise ValueError(f"每个 Space 最多 {MAX_DOMAINS} 个领域")
        return out

    def create_domains(self, space_id: str, domains: list[dict]) -> list[dict]:
        space = self.get_space(space_id)
        space.domains += self._validate_new_domains(space, domains)  # 整批校验，失败不落任何一个
        self.store.put_space(space)
        return [d.__dict__ for d in space.domains]

    def update_domains(self, space_id: str, domains: list[dict]) -> list[dict]:
        """每项 {name, new_name?, description?}。改名同步到已有主题。"""
        space = self.get_space(space_id)
        by_name = {d.name: d for d in space.domains}
        final = set(by_name)
        renames: dict[str, str] = {}
        for d in domains:
            name = d.get("name")
            if name not in by_name:
                raise ValueError(f"领域未登记：{name}")
            new = d.get("new_name")
            if new:
                new = new.strip()
                if not new or (new in final and new != name):
                    raise ValueError(f"领域改名冲突：{name} → {new}")
                final.discard(name)
                final.add(new)
                renames[name] = new
        for d in domains:
            dom = by_name[d["name"]]
            if d.get("description") is not None:
                dom.description = d["description"]
            if d["name"] in renames:
                dom.name = renames[d["name"]]
        self.store.put_space(space)
        if renames:
            for t in self.store.list_topics(space_id):
                if t.domain in renames:
                    t.domain = renames[t.domain]
                    self.store.put_topic(t)
        return [d.__dict__ for d in space.domains]

    def delete_domains(self, space_id: str, names: list[str]) -> list[dict]:
        space = self.get_space(space_id)
        registered = set(space.domain_names())
        missing = [n for n in names if n not in registered]
        if missing:
            raise ValueError(f"领域未登记：{missing}")
        used = {t.domain for t in self.store.list_topics(space_id)}
        busy = [n for n in names if n in used]
        if busy:
            raise ValueError(f"领域仍被主题引用，不能删除：{busy}")
        space.domains = [d for d in space.domains if d.name not in names]
        self.store.put_space(space)
        return [d.__dict__ for d in space.domains]

    def list_domains(self, space_id: str) -> list[dict]:
        return [d.__dict__ for d in self.get_space(space_id).domains]

    # ═════════════════════════════════ 写入 ══════════════════════════════════

    def accept(self, req: Any) -> dict[str, Any]:
        """add/message 受理（同步部分）：校验、存消息、建任务、按 Space 入队。"""
        space_ids: list[str] = list(req.space_ids or [])
        domains: list[str] = list(getattr(req, "domains", None) or [])
        spaces = [self.get_space(s) for s in space_ids]  # 任一不存在 → 「Space 不存在」
        for sp in spaces:
            if not sp.domains:
                raise ValueError(
                    f"未配置领域：Space {sp.space_id} 至少登记一个领域后才能写入项目记忆"
                )
            bad = [d for d in domains if d not in sp.domain_names()]
            if bad:
                raise ValueError(f"领域未登记：{bad}（Space {sp.space_id}）")

        conv = getattr(req, "conversation_id", None) or getattr(req, "session_id", None) or None
        if conv == "default_session":
            conv = None
        user_id = req.user_id if isinstance(req.user_id, str) else ""
        agent_id = req.agent_id if isinstance(getattr(req, "agent_id", None), str) else ""
        msgs = parse_messages(req.messages or [], user_id)
        task = TaskRecord(
            task_id=getattr(req, "task_id", None) or new_uuid(),
            user_id=user_id,
            space_ids=space_ids,
            pending_spaces=list(space_ids),
        )
        self.store.put_task(task)

        for space_id in space_ids:
            node_ids = self._store_messages(space_id, conv, msgs, user_id, agent_id)
            payload = {
                "task_id": task.task_id,
                "conversation_id": conv,
                "message_node_ids": node_ids,
                "domains": domains,
                "user_id": user_id,
                "agent_id": agent_id,
            }
            if conv:
                idx = self.store.get_index(f"conv:{conv}") or {"space_ids": []}
                if space_id not in idx["space_ids"]:
                    idx["space_ids"].append(space_id)
                    self.store.put_index(f"conv:{conv}", idx)
            self._enqueue(space_id, payload, sync=getattr(req, "async_mode", "async") == "sync")

        task = self.store.get_task(task.task_id) or task
        return {
            "success": True,
            "task_id": task.task_id,
            "status": "completed" if task.status == "completed" else "running",
            "memory_view": "project",
        }

    def _store_messages(
        self, space_id: str, conv: str | None, msgs: list[Msg], user_id: str, agent_id: str
    ) -> list[str]:
        """按 PRD 去重：同一会话里 role + chat_time 相同的视为已有消息，不重复保存。"""
        existing = self.store.list_messages(space_id, conv) if conv else []
        seen = {(m.role, m.chat_time, m.text) for m in existing if m.chat_time}
        seq0 = max([m.seq for m in existing] + [0])
        ids: list[str] = []
        for i, m in enumerate(msgs):
            if conv and m.chat_time and (m.role, m.chat_time, m.text) in seen:
                continue
            m.seq = seq0 + i + 1
            m.node_id = new_uuid()
            ids.append(
                self.store.put_message(
                    space_id, conv or "", m, {"user_id": user_id, "agent_id": agent_id}
                )
            )
        return ids

    def _enqueue(self, space_id: str, payload: dict[str, Any], sync: bool) -> None:
        if self.submit is not None and not sync:
            from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem

            item = ScheduleMessageItem(
                user_id=space_id,  # 一个 Space 一条流：流键 = 前缀:space:space:project_memory
                mem_cube_id=space_id,
                label=PROJECT_MEMORY_TASK_LABEL,
                content=json.dumps(payload, ensure_ascii=False),
                user_name=space_id,
                task_id=payload["task_id"],
            )
            self.submit([item])
            return
        with self._lock(space_id):
            self.run_item(space_id, payload)

    def _lock(self, space_id: str) -> threading.RLock:
        """同一 Space 的整理与 flush 串行（可重入：同步路径在锁内调 run_item）。"""
        with self._locks_guard:
            return self._locks.setdefault(space_id, threading.RLock())

    # —— 调度入口（H.PROJECT_MEMORY_EXECUTE）——
    def execute(self, space_id: str, batch: list[Any]) -> None:
        items = sorted(batch, key=lambda m: getattr(m, "timestamp", None) or 0)
        with self._lock(space_id):
            for item in items:
                try:
                    payload = json.loads(item.content)
                except (TypeError, ValueError):
                    logger.warning(
                        "[ProjectMemory] 调度消息不是 JSON，跳过：%s",
                        getattr(item, "content", "")[:200],
                    )
                    continue
                self.run_item(space_id, payload)

    def run_item(self, space_id: str, payload: dict[str, Any]) -> OrganizeResult:
        result = OrganizeResult()
        task_id = payload["task_id"]
        try:
            conv = payload.get("conversation_id")
            new_msgs = self.store.get_messages(space_id, payload.get("message_node_ids") or [])
            # 懒关段：先把这个 Space 里别的会话空闲超过阈值的段关掉（会话最后一段没有「下一轮」
            # 来触发，照 memmy 的做法在每次整理前扫一遍；会话结束时接入方也可调 flush）。
            # 「现在」取这批消息的时间而不是墙钟：导入历史会话时消息时间都很早，按墙钟会把
            # 每一段都判成空闲。
            ref = new_msgs[0].chat_time if new_msgs and new_msgs[0].chat_time else now_iso()
            for stale in self.store.open_episodes(space_id):
                if conv and stale.conversation_id == conv:
                    continue  # 本会话的段由 segment() 按消息时间判
                last = self.store.get_messages(space_id, stale.message_ids)
                gap = idle_minutes_between(last[-1].chat_time, ref) if last else None
                if gap is not None and gap >= IDLE_MINUTES:
                    result.merge(self._close_and_organize(stale, "idle_timeout"))
            open_ep = self.store.open_episode(space_id, conv) if conv else None
            prev_tail = [] if open_ep else self._last_tail(space_id, conv)
            closed, still_open = segment(
                self.hub,
                space_id,
                conv,
                open_ep,
                new_msgs,
                load=lambda ids: self.store.get_messages(space_id, ids),
                domains=payload.get("domains") or [],
                task_id=task_id,
                log=result.log,
                prev_tail=prev_tail,
            )
            for ep in closed:
                ep.agent_id = ep.agent_id or payload.get("agent_id", "")
                result.merge(self.organize(ep))
            if still_open is not None:
                still_open.agent_id = still_open.agent_id or payload.get("agent_id", "")
                self.store.put_episode(still_open)
            self._finish_task(
                task_id,
                space_id,
                result.topic_ids,
                len(still_open.message_ids) if still_open else 0,
                error="",
                trace=result.trace,
            )
        except Exception as e:
            logger.exception("[ProjectMemory] 整理失败 space=%s task=%s", space_id, task_id)
            result.log(f"失败：{e}")
            self._finish_task(
                task_id, space_id, result.topic_ids, 0, error=str(e), trace=result.trace
            )
        self.last_trace = result.trace
        return result

    def _close_and_organize(self, ep: Episode, reason: str) -> OrganizeResult:
        msgs = self.store.get_messages(ep.space_id, ep.message_ids)
        ep.state, ep.closed_reason = "closed", reason
        ep.messages, ep.prev = msgs, self.store.get_messages(ep.space_id, ep.prev_message_ids)
        self.store.put_episode(ep)
        return self.organize(ep)

    def flush(
        self,
        space_id: str,
        conversation_id: str | None = None,
        task_id: str | None = None,
    ) -> OrganizeResult:
        """会话结束：把这个 Space（或这个会话）里还开着的段立即关掉并整理。

        本地插件在会话结束时调；也可以由定时任务调。不调的话，这些段会在下一次同 Space 的
        整理时按空闲超时关掉，最慢等到下一次有人写。

        传了 `task_id` 时把这次整理出的主题记到那个任务上（`get/status` 才看得到）。
        """
        self.get_space(space_id)  # Space 不存在 → LookupError → 404
        out = OrganizeResult()
        with self._lock(space_id):
            for ep in self.store.open_episodes(space_id):
                if conversation_id and ep.conversation_id != conversation_id:
                    continue
                out.merge(self._close_and_organize(ep, "session_end"))
            if task_id and out.topic_ids:
                self._finish_task(task_id, space_id, out.topic_ids, 0, error="", trace=out.trace)
        if out.trace:
            self.last_trace = out.trace
        return out

    def _last_tail(self, space_id: str, conv: str | None) -> list[str]:
        if not conv:
            return []
        nodes = self.store._nodes(
            "ProjectEpisodeMemory",
            space_id,
            [
                {"field": "conversation_id", "op": "=", "value": conv},
                {"field": "episode_state", "op": "=", "value": "closed"},
            ],
        )
        if not nodes:
            return []
        nodes.sort(key=lambda n: n["metadata"].get("create_time", ""))
        ids = nodes[-1]["metadata"].get("message_ids") or []
        turns = split_turns(self.store.get_messages(space_id, ids))
        return [m.node_id for m in turns[-1]] if turns else []

    def _finish_task(
        self,
        task_id: str,
        space_id: str,
        topic_ids: list[str],
        open_n: int,
        error: str,
        trace: list[str] | None = None,
    ) -> None:
        task = self.store.get_task(task_id)
        if task is None:
            return
        if trace:
            task.trace = (task.trace + trace)[-MAX_TRACE_LINES:]
        for t in topic_ids:
            if t not in task.memory_ids:
                task.memory_ids.append(t)
        task.pending_spaces = [s for s in task.pending_spaces if s != space_id]
        task.open_episode_messages += open_n
        if error:
            task.status, task.error = "failed", error
        elif not task.pending_spaces and task.status != "failed":
            task.status = "completed"
        self.store.put_task(task)

    # —— 一段的整理 ——
    def organize(self, ep: Episode) -> OrganizeResult:
        r = OrganizeResult()
        ep.messages = self.store.get_messages(ep.space_id, ep.message_ids)
        ep.prev = self.store.get_messages(ep.space_id, ep.prev_message_ids)
        r.log(f"关段（{ep.closed_reason}）：{len(ep.messages)} 条消息")
        space = self.get_space(ep.space_id)
        domains = ep.domains or space.domain_names()
        topic = topic_mod.assign(self.hub, self.store, space, ep, domains, r.log)
        if topic is None:
            self.store.put_episode(ep)
            return r
        ep.topic_id = topic.id
        r.topic_ids.append(topic.id)

        self._run_decisions(ep, topic, r)
        r.experience_ops += exp.run(self.hub, self.store, ep, r.log)
        self.store.put_episode(ep)
        return r

    def _run_decisions(self, ep: Episode, topic: Topic, r: OrganizeResult) -> None:
        existing = self.store.list_decisions(ep.space_id, topic.id)
        members = ep.member_names()
        for d in existing:
            for name in d.user_labels.values():
                if name and name not in members:
                    members.append(name)
        has, drafts = dec.extract(self.hub, ep, members)
        r.log(f"  决策判定：{'有' if has else '无'}（抽出 {len(drafts)} 条）")
        if not has:
            return
        kept, dropped = dec.verify(ep, drafts, members)
        r.dropped += dropped
        for x in dropped:
            r.log(f"  决策丢弃：{x['reason']}｜{x['quote']}")
        if not kept:
            return

        existing = sorted(existing, key=lambda d: d.time, reverse=True)[: dec.MAX_TOPIC_DECISIONS]
        if not existing:  # 召回为空：不调第二次，直接新增
            for d in kept:
                self._add(d, ep, topic, r, "主题里还没有决策")
            return

        rows = dec.update(self.hub, kept, existing, topic.name)
        touched: set[str] = set()
        for d, row in zip(kept, rows, strict=False):
            for attempt in range(MAX_CAS_RETRIES):
                cands = {x.id: x for x in self.store.list_decisions(ep.space_id, topic.id)}
                if attempt or row.get("decision_id") in touched:
                    # 同一段里前一条已改过这条决策，或写回时发现被别人改过：按新状态重判
                    row = dec.update(self.hub, [d], list(cands.values()), topic.name)[0]
                plan = dec.decide(d, row, cands)
                try:
                    self._apply_plan(d, plan, cands, ep, topic, r, touched)
                    break
                except ConcurrentUpdateError:
                    r.log(
                        f"  决策写回冲突（第 {attempt + 1} 次）：这条决策刚被别的任务改过，重读重判"
                    )
            else:
                r.log(f"  决策写回连续冲突 {MAX_CAS_RETRIES} 次，放弃这一条：{d.content}")

    def _apply_plan(
        self, d, plan, cands, ep: Episode, topic: Topic, r: OrganizeResult, touched: set[str]
    ) -> None:
        for g in plan.guarded:
            r.log(f"  决策护栏：{g}")
        if plan.action == OP_ADD:
            self._add(d, ep, topic, r, plan.reason)
            return
        before = cands[plan.decision_id]
        after, plan = dec.apply(before, plan, d, ep.conversation_id)
        if after is None:
            r.log(f"  决策 {plan.action}：{d.name} 已在那一项里，不写入")
            return
        self.store.put_decision(after, expected_rev=before.rev)
        touched.add(after.id)
        r.decision_ops.append(
            {
                "op": plan.action,
                "decision_id": after.id,
                "same_as": plan.same_as,
                "model_action": plan.model_action,
                "guarded": plan.guarded,
                "reason": plan.reason,
                "content": after.content,
                "conflicts": [c.content for c in after.conflicts],
                "history": [h.content for h in after.history],
            }
        )
        r.log(
            f"  决策 {plan.action}（{plan.same_as or '-'}）→ 当前结论「{after.content}」；"
            f"不一致 {len(after.conflicts)} 项；历史 {len(after.history)} 项"
        )

    def _add(self, d, ep: Episode, topic: Topic, r: OrganizeResult, reason: str) -> None:
        new = dec.new_decision(d, ep, topic.id)
        self.store.put_decision(new)
        r.decision_ops.append(
            {"op": OP_ADD, "decision_id": new.id, "content": new.content, "reason": reason}
        )
        r.log(f"  决策 add：{new.content}")

    # ═════════════════════════════════ 读取 ══════════════════════════════════

    def search(self, req: Any) -> list[dict[str, Any]]:
        limit = getattr(req, "memory_limit_number", None) or DEFAULT_LIMIT
        query = req.query
        conv = getattr(req, "conversation_id", None) or getattr(req, "session_id", None)
        user_id = req.user_id
        scored: list[tuple[float, Topic]] = []
        for space_id in req.space_ids:
            space = self.get_space(space_id)
            bad = [d for d in (req.domains or []) if d not in space.domain_names()]
            if bad:
                raise ValueError(f"领域未登记：{bad}（Space {space_id}）")
            for s, t in self.store.recall_topics(space_id, query, limit * 2, domains=req.domains):
                if conv and any(src.get("conversation_id") == conv for src in t.sources):
                    s += 0.1  # 来源会话包含当前会话的主题优先
                scored.append((s, t))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [
            self.topic_detail(t, query=query, user_id=user_id, relativity=min(1.0, s))
            for s, t in scored[:limit]
        ]

    def topic_detail(
        self, t: Topic, query: str | None = None, user_id: str = "", relativity: float | None = None
    ) -> dict[str, Any]:
        """query 为 None：完整返回（get/memory）；否则只带与 query 相关的条目、不带来源（search/memory）。"""
        full = query is None
        decisions = self.store.list_decisions(t.space_id, t.id)
        experiences = [
            e
            for e in self.store.list_experiences(t.space_id)
            if t.id in e.topic_ids
            and exp.lifecycle(e) != "archived"
            and (full or exp.visible(e, user_id))
        ]
        timeline = list(t.timeline)
        if not full:
            decisions = self._relevant(query, decisions, lambda d: d.index_text)
            experiences = self._relevant(
                query, experiences, lambda e: e.memory_text, weight=lambda e: e.confidence
            )
            timeline = self._relevant(query, timeline, lambda x: x.get("content", ""))
        else:
            decisions.sort(key=lambda d: d.time)
            experiences.sort(key=lambda e: e.confidence, reverse=True)
        out = {
            "id": t.id,
            "space_id": t.space_id,
            "domain": t.domain,
            "topic_name": t.name,
            "topic_summary": t.summary,
            "topic_description": t.description,
            "decisions": [self._decision_out(d, full) for d in decisions],
            "experiences": [self._experience_out(e, full) for e in experiences],
            "timeline": [
                {
                    "content": x.get("content", ""),
                    "time": x.get("time", ""),
                    "user_ids": x.get("user_ids", []),
                }
                for x in sorted(timeline, key=lambda x: x.get("time", ""))
            ],
            "update_time": t.update_time,
        }
        if relativity is not None:
            out["relativity"] = round(relativity, 4)
        if full:
            out["sources"] = t.sources
            out["create_time"] = t.create_time
        return out

    def _relevant(
        self, query: str, items: list, text: Callable, weight: Callable | None = None
    ) -> list:
        scored = []
        qv = None
        if self.store.embedder is not None:
            try:
                qv = self.store.embedder([query])[0]
            except Exception:
                qv = None
        for it in items:
            s = lexical_sim(query, text(it))
            if qv is not None:
                with contextlib.suppress(Exception):
                    s = max(s, cosine(qv, self.store.embedder([text(it)])[0]))
            if s >= REL_MIN:
                scored.append((s * (weight(it) if weight else 1.0), it))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [it for _, it in scored[:MAX_ENTRIES]]

    @staticmethod
    def _decision_out(d: Decision, full: bool) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": d.id,
            "content": d.content,
            "time": d.time,
            "user_ids": d.user_ids,
            "user_labels": d.user_labels,
        }
        if full:
            out["source"] = d.source.to_json()
        if d.history:
            out["history"] = [
                {
                    "content": h.content,
                    "time": h.time,
                    "user_ids": h.user_ids,
                    "reason": h.reason,
                    **(
                        {"source": h.source.to_json(), "change_source": h.change_source.to_json()}
                        if full
                        else {}
                    ),
                }
                for h in d.history
            ]
        if d.conflicts:
            out["conflicts"] = [
                {
                    "content": c.content,
                    "time": c.time,
                    "user_ids": c.user_ids,
                    **({"source": c.source.to_json()} if full else {}),
                }
                for c in d.conflicts
            ]
        return out

    @staticmethod
    def _experience_out(e, full: bool) -> dict[str, Any]:
        out = {
            "id": e.id,
            "content": e.memory_text,
            "time": e.time,
            "user_ids": e.author_ids,
            "task_intent": e.task_intent,
            "exp_status": e.exp_status,
            "confidence": e.confidence,
            "lifecycle": exp.lifecycle(e),
        }
        if full:
            out["card"] = e.card()
            out["version"] = e.version
            out["sources"] = e.sources
        return out

    def list_topics(self, req: Any) -> dict[str, Any]:
        space = self.get_space(req.space_id)
        topics = self.store.list_topics(space.space_id)
        related = (getattr(req, "filter", None) or {}).get("related_id")
        if related:
            topics = [t for t in topics if related in t.related_user_ids()]
        size = getattr(req, "size", None) or getattr(req, "page_size", None)
        page = getattr(req, "page", None) or 1
        total = len(topics)
        if size:
            topics = topics[(page - 1) * size : page * size]
        return {
            "space_id": space.space_id,
            "total": total,
            "topic_detail_list": [self.topic_detail(t) for t in topics],
        }

    def get_topic(self, memory_id: str) -> dict[str, Any] | None:
        t = self.store.get_topic(memory_id)
        return self.topic_detail(t) if t else None

    def delete(self, req: Any) -> dict[str, Any]:
        space = self.get_space(req.space_id)
        ids = list(getattr(req, "memory_ids", None) or [])
        topics = self.store.list_topics(space.space_id)
        targets = [t for t in topics if t.id in ids] if ids else topics
        missing = set(ids) - {t.id for t in targets}
        if missing:
            raise LookupError(f"主题不在这个 Space 里：{sorted(missing)}")
        for t in targets:
            self.store.delete_topic(t)
        return {"space_id": space.space_id, "deleted_topic_ids": [t.id for t in targets]}

    def task_status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
        task = self.store.get_task(task_id)
        return task.to_api() if task else None

    def get_message(
        self, conversation_id: str, space_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        spaces = (
            [space_id]
            if space_id
            else (self.store.get_index(f"conv:{conversation_id}") or {}).get("space_ids", [])
        )
        seen: set[tuple] = set()
        out: list[dict[str, Any]] = []
        for sid in spaces:
            for m in self.store.list_messages(sid, conversation_id):
                key = (m.role, m.chat_time, m.text, m.tool_args)
                if key in seen:
                    continue
                seen.add(key)
                out.append(
                    {
                        "message_id": m.id,
                        "role": {"member": "user", "agent": "assistant"}.get(m.role, m.role),
                        "content": m.text,
                        "chat_time": m.chat_time,
                        "role_id": m.user_id,
                        "role_name": m.name,
                        **(
                            {"tool_name": m.tool_name, "tool_args": m.tool_args}
                            if m.role == "tool"
                            else {}
                        ),
                    }
                )
        return out[-limit:] if limit else out


# ═════════════════════════════════ 消息解析 ══════════════════════════════════


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(p.get("text", ""))
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    if isinstance(content, dict):
        return str(content.get("text", ""))
    return "" if content is None else str(content)


def parse_messages(raw: list[Any], user_id: str) -> list[Msg]:
    """把 add/message 的 messages 转成三类消息。

    - user → 成员消息（说话人取 role_id / role_name，没传就用请求的 user_id）；
    - assistant 正文 → Agent 回复；assistant 的 tool_calls → 每个调用一条工具记录；
    - tool → 并进对应 tool_call_id 的工具记录作为返回（找不到就单独一条）。
    """
    out: list[Msg] = []
    calls: dict[str, Msg] = {}
    now = now_iso()
    for i, r in enumerate(raw):
        r = dict(r) if isinstance(r, dict) else {"role": "user", "content": str(r)}
        role = r.get("role", "user")
        t = r.get("chat_time") or now
        mid = r.get("message_id") or f"m{i + 1:04d}-{new_uuid()[:8]}"
        if role == "user":
            out.append(
                Msg(
                    id=mid,
                    role="member",
                    text=_text(r.get("content")),
                    chat_time=t,
                    user_id=r.get("role_id") or user_id,
                    name=r.get("role_name") or r.get("role_id") or user_id,
                )
            )
        elif role == "assistant":
            body = _text(r.get("content"))
            calls_raw = r.get("tool_calls") or []
            if isinstance(calls_raw, dict):
                calls_raw = [calls_raw]
            for j, c in enumerate(calls_raw):
                fn = (c or {}).get("function") or {}
                tm = Msg(
                    id=(c or {}).get("id") or f"{mid}-call{j + 1}",
                    role="tool",
                    text="",
                    chat_time=t,
                    tool_name=fn.get("name", ""),
                    tool_args=str(fn.get("arguments", "")),
                    tool_call_id=(c or {}).get("id", ""),
                )
                out.append(tm)
                if tm.tool_call_id:
                    calls[tm.tool_call_id] = tm
            notes = r.get("experience_notes") or []
            if body or notes:
                out.append(Msg(id=mid, role="agent", text=body, chat_time=t, notes=list(notes)))
        elif role == "tool":
            cid = r.get("tool_call_id", "")
            if cid in calls:
                calls[cid].text = _text(r.get("content"))
            else:
                out.append(
                    Msg(
                        id=mid,
                        role="tool",
                        text=_text(r.get("content")),
                        chat_time=t,
                        tool_call_id=cid,
                    )
                )
    return out
