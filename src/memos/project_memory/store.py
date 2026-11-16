# -*- coding: utf-8 -*-
"""存储层：主题、决策、经验都写成一类 Memory 节点（不新建关系表）。

一种 view 由什么组成（11/16 读码，与 EventMemory / SkillMemory 并列）：
- 所有记忆是同一张 `Memory` 表里的一行：`id, memory, properties(JSONB), embedding, user_name, created_at, updated_at`；
- 种类靠 `properties.memory_type` 区分；
- 隔离靠 `properties.user_name` / 表的 `user_name` 列 = cube id，<mark>没有 tenant_id</mark>；
- 现成可用的字段：`status`、`version`、`history`（ArchivedTextualMemory）、`sources`（SourceMessage）。

三张表的字段一一落进 properties.project：
    decisions             → memory（当前结论）+ properties.project.{time,user_ids,source,conflicts,version,category}
    decision_conflicts    → properties.project.conflicts[]（每项 content/time/user_ids/source/seq）
    decision_history      → properties.project.history[]（另带 reason、change_source）+ 节点 metadata.history
    experiences           → memory（principle）+ properties.project.{卡片字段}
    experience_sources    → properties.project.sources[]
    topics                → memory（summary）+ properties.project.{name,domain,description,sources}

两条实现：`GraphProjectStore` 包一个 BaseGraphDB（生产用 Postgres / PolarDB），
`InMemoryProjectStore` 用字典 + 关键词相似度（主干自测与 mock add 用，不依赖数据库）。
"""

from __future__ import annotations

import math
import re

from typing import Any, Callable, Iterable

from .types import (
    MEMORY_VIEW_PROJECT,
    PROJECT_DECISION,
    PROJECT_EXPERIENCE,
    PROJECT_TOPIC,
    Decision,
    ExperienceCard,
    Topic,
    new_id,
    now_iso,
)


Embedder = Callable[[list[str]], list[list[float]]]


def _tokens(text: str) -> set[str]:
    """粗分词：中文按 2-gram，英文数字按词。主干里只为做个稳定的相似度，接真模型时换成真向量。"""
    text = (text or "").lower()
    out: set[str] = set(re.findall(r"[a-z0-9_]{2,}", text))
    zh = re.findall(r"[一-鿿]+", text)
    for seg in zh:
        for i in range(len(seg) - 1):
            out.add(seg[i : i + 2])
    return out


def _cos(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / math.sqrt(len(a) * len(b))


class ProjectMemoryStore:
    """存储接口。上层（pipeline）只调这里，换后端不改算法。"""

    def put_topic(self, t: Topic) -> None:
        raise NotImplementedError

    def get_topic(self, topic_id: str, space_id: str) -> Topic | None:
        raise NotImplementedError

    def list_topics(self, space_id: str, limit: int = 50) -> list[Topic]:
        raise NotImplementedError

    def put_decision(self, d: Decision) -> None:
        raise NotImplementedError

    def get_decision(self, decision_id: str, space_id: str) -> Decision | None:
        raise NotImplementedError

    def list_decisions(self, space_id: str) -> list[Decision]:
        raise NotImplementedError

    def put_experience(self, e: ExperienceCard) -> None:
        raise NotImplementedError

    def get_experience(self, exp_id: str, space_id: str) -> ExperienceCard | None:
        raise NotImplementedError

    def list_experiences(self, space_id: str) -> list[ExperienceCard]:
        raise NotImplementedError

    def delete_experience(self, exp_id: str, space_id: str) -> None:
        raise NotImplementedError

    # —— 召回原语：只做硬过滤 + 全文/向量查询，不按用途组装（C02）——
    def recall_decisions(self, space_id: str, text: str, top_k: int = 10) -> list[Decision]:
        raise NotImplementedError

    def recall_experiences(self, space_id: str, text: str, top_k: int = 10) -> list[ExperienceCard]:
        raise NotImplementedError

    def recall_topics(self, space_id: str, text: str, top_k: int = 9) -> list[Topic]:
        raise NotImplementedError


class InMemoryProjectStore(ProjectMemoryStore):
    """主干自测用。向量位留空，相似度用关键词，够跑通链路与核对算法动作。"""

    def __init__(self, embedder: Embedder | None = None):
        self.topics: dict[str, Topic] = {}
        self.decisions: dict[str, Decision] = {}
        self.experiences: dict[str, ExperienceCard] = {}
        self.spaces: dict[str, set[str]] = {}
        self.embedder = embedder
        self.writes: list[dict[str, Any]] = []  # 记录每次落库，供 trace

    # —— 主题 ——
    def put_topic(self, t: Topic) -> None:
        t.update_time = now_iso()
        self.topics[t.id] = t
        self.spaces.setdefault(t.space_id, set()).add(t.id)
        self.writes.append({"node": t.id, "memory_type": PROJECT_TOPIC, "space": t.space_id})

    def get_topic(self, topic_id: str, space_id: str = "") -> Topic | None:
        t = self.topics.get(topic_id)
        if t and space_id and t.space_id != space_id:
            return None
        return t

    def list_topics(self, space_id: str, limit: int = 50) -> list[Topic]:
        items = [t for t in self.topics.values() if t.space_id == space_id]
        items.sort(key=lambda t: t.update_time, reverse=True)
        return items[:limit]

    # —— 决策 ——
    def put_decision(self, d: Decision) -> None:
        self.decisions[d.id] = d
        self.writes.append(
            {"node": d.id, "memory_type": PROJECT_DECISION, "space": d.space_id, "version": d.version}
        )

    def get_decision(self, decision_id: str, space_id: str = "") -> Decision | None:
        d = self.decisions.get(decision_id)
        if d and space_id and d.space_id != space_id:
            return None
        return d

    def list_decisions(self, space_id: str) -> list[Decision]:
        return [d for d in self.decisions.values() if d.space_id == space_id]

    # —— 经验 ——
    def put_experience(self, e: ExperienceCard) -> None:
        self.experiences[e.id] = e
        self.writes.append({"node": e.id, "memory_type": PROJECT_EXPERIENCE, "space": e.space_id})

    def get_experience(self, exp_id: str, space_id: str = "") -> ExperienceCard | None:
        e = self.experiences.get(exp_id)
        if e and space_id and e.space_id != space_id:
            return None
        return e

    def list_experiences(self, space_id: str) -> list[ExperienceCard]:
        return [e for e in self.experiences.values() if e.space_id == space_id]

    def delete_experience(self, exp_id: str, space_id: str = "") -> None:
        e = self.experiences.get(exp_id)
        if e and (not space_id or e.space_id == space_id):
            del self.experiences[exp_id]
            self.writes.append({"node": exp_id, "deleted": True})

    # —— 召回 ——
    def recall_decisions(self, space_id: str, text: str, top_k: int = 10) -> list[Decision]:
        q = _tokens(text)
        scored = []
        for d in self.list_decisions(space_id):
            # 索引文本 = 当前结论 + 各项不一致结论（T1 §5.2）
            body = d.content + "\n" + "\n".join(c.content for c in d.conflicts)
            scored.append((_cos(q, _tokens(body)), d))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [d for s, d in scored[:top_k] if s > 0] or [d for _, d in scored[:top_k]]

    def recall_experiences(self, space_id: str, text: str, top_k: int = 10) -> list[ExperienceCard]:
        q = _tokens(text)
        scored = [( _cos(q, _tokens(e.index_text)), e) for e in self.list_experiences(space_id)]
        scored.sort(key=lambda x: x[0], reverse=True)
        return [e for s, e in scored[:top_k] if s > 0] or [e for _, e in scored[:top_k]]

    def recall_topics(self, space_id: str, text: str, top_k: int = 9) -> list[Topic]:
        q = _tokens(text)
        scored = [( _cos(q, _tokens(t.index_text)), t) for t in self.list_topics(space_id)]
        scored.sort(key=lambda x: x[0], reverse=True)
        return [t for s, t in scored[:top_k] if s > 0] or [t for _, t in scored[:top_k]]


class GraphProjectStore(ProjectMemoryStore):
    """生产实现：一个 Memory 节点一类记忆，走 graph_db（Postgres / PolarDB 都行）。

    - `user_name` 传 space_id（= cube id），隔离与现有记忆一致；
    - 决策的历史同时写 `properties.history`（ArchivedTextualMemory 形状）与 `properties.project.history`，
      前者供通用读取，后者带 reason / change_source；
    - 召回用 `search_by_embedding` + `search_by_fulltext`，向量由 embedder 统一生成（J01）。
    """

    def __init__(self, graph_db: Any, embedder: Embedder | None = None):
        self.graph_db = graph_db
        self.embedder = embedder

    # —— 写 ——
    def _write_node(self, node_id: str, memory: str, project: dict[str, Any], memory_type: str, space_id: str, extra: dict[str, Any] | None = None) -> None:
        props: dict[str, Any] = {
            "memory_type": memory_type,
            "memory_view": MEMORY_VIEW_PROJECT,
            "user_name": space_id,
            "status": "activated",
            "project": project,
            "updated_at": now_iso(),
        }
        if extra:
            props.update(extra)
        if self.embedder:
            vec = self.embedder([memory])[0]
            props["embedding"] = vec
        self.graph_db.add_node(id=node_id, memory=memory, metadata=props, user_name=space_id)

    def put_topic(self, t: Topic) -> None:
        t.update_time = now_iso()
        self._write_node(t.id, t.summary, t.to_json(), PROJECT_TOPIC, t.space_id, extra={"tags": [t.domain]})

    def put_decision(self, d: Decision) -> None:
        archived = [
            {
                "version": d.version - 1 if d.version > 1 else 1,
                "memory": h.content,
                "update_type": "conflict",
                "created_at": h.time,
            }
            for h in d.history
        ]
        self._write_node(
            d.id,
            d.content,
            d.to_json(),
            PROJECT_DECISION,
            d.space_id,
            extra={"version": d.version, "history": archived, "sources": [h.source.to_json() for h in d.history]},
        )

    def put_experience(self, e: ExperienceCard) -> None:
        # 节点层的 status 恒为 activated：经验的 candidate / verified / disputed 是业务状态，
        # 存在 properties.project.status 里，不能用它覆盖节点状态，否则按 activated 过滤就查不到。
        self._write_node(
            e.id,
            e.principle,
            e.to_json(),
            PROJECT_EXPERIENCE,
            e.space_id,
            extra={"tags": e.anchors, "confidence": e.confidence},
        )

    def delete_experience(self, exp_id: str, space_id: str = "") -> None:
        self.graph_db.delete_node(exp_id)

    # —— 读 ——
    def _get(self, node_id: str, space_id: str) -> dict[str, Any] | None:
        rec = self.graph_db.get_node(node_id, user_name=space_id)
        if not rec:
            return None
        return rec

    def get_topic(self, topic_id: str, space_id: str = "") -> Topic | None:
        rec = self._get(topic_id, space_id)
        if not rec:
            return None
        return Topic.from_json(rec.get("metadata", {}).get("project") or {}, topic_id=topic_id)

    def get_decision(self, decision_id: str, space_id: str = "") -> Decision | None:
        rec = self._get(decision_id, space_id)
        if not rec:
            return None
        d = Decision.from_json(rec.get("metadata", {}).get("project") or {}, decision_id=decision_id)
        if not d.content:
            d.content = rec.get("memory", "")
        return d

    def get_experience(self, exp_id: str, space_id: str = "") -> ExperienceCard | None:
        rec = self._get(exp_id, space_id)
        if not rec:
            return None
        return ExperienceCard.from_json(rec.get("metadata", {}).get("project") or {}, exp_id=exp_id)

    def _list_by_type(self, memory_type: str, space_id: str) -> list[dict[str, Any]]:
        ids = self.graph_db.get_by_metadata(
            filters=[{"memory_type": memory_type}, {"user_name": space_id}], status="activated"
        )
        if not ids:
            return []
        return self.graph_db.get_nodes(ids, user_name=space_id) or []

    def list_topics(self, space_id: str, limit: int = 50) -> list[Topic]:
        recs = self._list_by_type(PROJECT_TOPIC, space_id)
        out = [Topic.from_json(r["metadata"].get("project") or {}, topic_id=r["id"]) for r in recs]
        out.sort(key=lambda t: t.update_time, reverse=True)
        return out[:limit]

    def list_decisions(self, space_id: str) -> list[Decision]:
        recs = self._list_by_type(PROJECT_DECISION, space_id)
        return [
            Decision.from_json({**(r["metadata"].get("project") or {}), "content": r.get("memory", "")}, decision_id=r["id"])
            for r in recs
        ]

    def list_experiences(self, space_id: str) -> list[ExperienceCard]:
        recs = self._list_by_type(PROJECT_EXPERIENCE, space_id)
        return [
            ExperienceCard.from_json({**(r["metadata"].get("project") or {}), "principle": r.get("memory", "")}, exp_id=r["id"])
            for r in recs
        ]

    # —— 召回 ——
    def _recall(self, space_id: str, text: str, memory_type: str, top_k: int) -> list[dict[str, Any]]:
        hits: list[dict[str, Any]] = []
        if self.embedder:
            vec = self.embedder([text])[0]
            hits = self.graph_db.search_by_embedding(
                vector=vec, top_k=top_k, scope=memory_type, user_name=space_id
            )
        if not hits:
            hits = self.graph_db.search_by_fulltext(
                query=text, top_k=top_k, scope=memory_type, user_name=space_id
            )
        return hits or []

    def recall_decisions(self, space_id: str, text: str, top_k: int = 10) -> list[Decision]:
        return [
            Decision.from_json({**(r["metadata"].get("project") or {}), "content": r.get("memory", "")}, decision_id=r["id"])
            for r in self._recall(space_id, text, PROJECT_DECISION, top_k)
        ]

    def recall_experiences(self, space_id: str, text: str, top_k: int = 10) -> list[ExperienceCard]:
        return [
            ExperienceCard.from_json({**(r["metadata"].get("project") or {}), "principle": r.get("memory", "")}, exp_id=r["id"])
            for r in self._recall(space_id, text, PROJECT_EXPERIENCE, top_k)
        ]

    def recall_topics(self, space_id: str, text: str, top_k: int = 9) -> list[Topic]:
        return [
            Topic.from_json(r["metadata"].get("project") or {}, topic_id=r["id"])
            for r in self._recall(space_id, text, PROJECT_TOPIC, top_k)
        ]
