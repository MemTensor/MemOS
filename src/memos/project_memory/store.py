"""项目记忆的存储：全部落在 MemOS 现有的 `Memory` 表（`BaseGraphDB`）里，不建新表。

| memory_type | user_name | 一行存什么 |
| --- | --- | --- |
| ProjectSpaceMemory | space_id | Space 的名称、项目指令、领域清单（节点 id = space_id） |
| ProjectTopicMemory | space_id | 主题：名称、摘要、描述、演变轨迹、来源会话 |
| ProjectDecisionMemory | space_id | 一条决策：memory = 当前结论；properties.project = 决策方案 §2.3 的结构 |
| ExperienceMemory | space_id | 一张经验卡：经验方案 §2.3 的结构；旧版本另存 status=archived 的节点 |
| ProjectMessageMemory | space_id | 一条会话消息（get/message、上下文、episode 用） |
| ProjectEpisodeMemory | space_id | 一段 episode：消息 id 列表、开 / 关、归到的主题 |
| ProjectTaskMemory | 索引命名空间 | add 返回的任务：状态、更新了哪些主题 |
| ProjectIndexMemory | 索引命名空间 | 主题 id → space、会话 → space（按 id 读时用） |

存储可以是任何一个 `BaseGraphDB` 后端（默认是项目记忆自己的 SQLite 库；
`PROJECT_MEMORY_GRAPH_DB=postgres|shared` 换成自己的 Postgres 或核心的 graph_db）。带上 `rev` 列的后端
（postgres、sqlite）会走条件更新，其余后端（neo4j 两种、polardb）退化为整行 upsert。

只调 `BaseGraphDB` 的公共方法，按开源 Postgres 后端的约定传参：
`add_node(id, memory, metadata, user_name)`、`get_node(id, user_name=)`、`get_nodes(ids, user_name=)`、
`get_by_metadata(filters=[{field, op, value}], status=, user_name=)`、`delete_node(id, user_name=)`、
`search_by_embedding(vector, top_k, scope=, user_name=, search_filter=) -> [{id, score}]`。
要过滤的字段都放在 properties 顶层（`properties->>'field'`）；嵌套在 `project` / `info` 里的只读不查。

已知限制（换新库时一并补）：`add_node` 是整行 upsert、不比版本，同一 Space 的并发写靠调度层的 Space 锁；
`search_by_fulltext` 只有 polardb / neo4j 有，这里的全文召回用进程内的二元组相似度兜底。
"""

from __future__ import annotations

import contextlib
import math
import re

from collections.abc import Callable
from typing import Any

from .types import (
    INDEX_NAMESPACE,
    MEMORY_VIEW_PROJECT,
    PROJECT_DECISION,
    PROJECT_EPISODE,
    PROJECT_EXPERIENCE,
    PROJECT_INDEX,
    PROJECT_MESSAGE,
    PROJECT_SPACE,
    PROJECT_TASK,
    PROJECT_TOPIC,
    Decision,
    Episode,
    ExperienceCard,
    Msg,
    Space,
    TaskRecord,
    Topic,
    now_iso,
    stable_uuid,
)


Embedder = Callable[[list[str]], list[list[float]]]


def bigrams(text: str) -> set[str]:
    text = (text or "").lower()
    out: set[str] = set(re.findall(r"[a-z0-9_./#-]{2,}", text))
    for seg in re.findall(r"[一-鿿]+", text):
        out.update(seg[i : i + 2] for i in range(len(seg) - 1))
        if len(seg) == 1:
            out.add(seg)
    return out


def lexical_sim(a: str, b: str) -> float:
    x, y = bigrams(a), bigrams(b)
    if not x or not y:
        return 0.0
    return len(x & y) / math.sqrt(len(x) * len(y))


def cosine(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(v * v for v in a)) or 1.0
    nb = math.sqrt(sum(v * v for v in b)) or 1.0
    return sum(x * y for x, y in zip(a, b, strict=False)) / (na * nb)


def _rev(n: dict[str, Any]) -> int | None:
    rev = n.get("rev")
    return int(rev) if isinstance(rev, int | float) else None


def _decision(n: dict[str, Any]) -> Decision:
    d = Decision.from_node(n["id"], n.get("memory", ""), n["metadata"])
    d.rev = _rev(n)
    return d


def _experience(n: dict[str, Any]) -> ExperienceCard:
    e = ExperienceCard.from_node(n["id"], n["metadata"])
    e.rev = _rev(n)
    return e


class ProjectStore:
    def __init__(self, graph_db: Any, embedder: Embedder | None = None):
        self.db = graph_db
        self.embedder = embedder

    # ── 原语 ──────────────────────────────────────────────────────────────

    def _put(
        self,
        node_id: str,
        memory: str,
        memory_type: str,
        namespace: str,
        props: dict[str, Any],
        embed_text: str | None = None,
        status: str = "activated",
        expected_rev: int | None = None,
    ) -> None:
        """写一行。`expected_rev` 不为空且库支持条件写（SQLite 的 rev）时，行被别人改过就抛
        `ConcurrentUpdateError`，由调用方重读重判（经验方案 §3.2 ⑫）。"""
        meta = {
            "memory_type": memory_type,
            "memory_view": MEMORY_VIEW_PROJECT,
            "user_name": namespace,
            "status": status,
            "updated_at": now_iso(),
            **props,
        }
        if embed_text is not None:
            meta["search_text"] = embed_text  # 全文索引文本（SQLite 的 memory_fts 用它）
            if self.embedder is not None:
                with contextlib.suppress(Exception):
                    meta["embedding"] = self.embedder([embed_text])[0]
        kwargs: dict[str, Any] = {}
        if expected_rev is not None and getattr(self.db, "supports_cas", False):
            kwargs["expected_rev"] = expected_rev
        self.db.add_node(
            id=node_id, memory=memory or "", metadata=meta, user_name=namespace, **kwargs
        )

    def _get(self, node_id: str, namespace: str) -> dict[str, Any] | None:
        node = self.db.get_node(node_id, user_name=namespace)
        if not node:
            return None
        meta = node.get("metadata") or {}
        if meta.get("user_name") not in (None, namespace):
            return None
        return node

    def _ids(
        self,
        memory_type: str,
        namespace: str,
        extra: list[dict[str, Any]] | None = None,
        status: str | None = "activated",
    ) -> list[str]:
        filters = [{"field": "memory_type", "op": "=", "value": memory_type}, *list(extra or [])]
        return list(
            self.db.get_by_metadata(filters=filters, status=status, user_name=namespace) or []
        )

    def _nodes(
        self,
        memory_type: str,
        namespace: str,
        extra: list[dict[str, Any]] | None = None,
        status: str | None = "activated",
    ) -> list[dict[str, Any]]:
        ids = self._ids(memory_type, namespace, extra, status)
        if not ids:
            return []
        return list(self.db.get_nodes(ids, user_name=namespace) or [])

    def _delete(self, node_id: str, namespace: str) -> None:
        self.db.delete_node(node_id, user_name=namespace)

    def _recall(
        self,
        memory_type: str,
        namespace: str,
        text: str,
        top_k: int,
        candidates: list[dict[str, Any]],
        search_filter: dict[str, Any] | None = None,
        index_text: Callable[[dict[str, Any]], str] | None = None,
    ) -> list[tuple[float, dict[str, Any]]]:
        """向量召回 + 二元组相似度，合并取前 top_k。candidates 是已按范围过滤过的节点。"""
        by_id = {n["id"]: n for n in candidates}
        scores: dict[str, float] = {}
        if self.embedder is not None and by_id:
            try:
                vec = self.embedder([text])[0]
                hits = (
                    self.db.search_by_embedding(
                        vector=vec,
                        top_k=max(top_k * 3, 20),
                        scope=memory_type,
                        user_name=namespace,
                        search_filter=search_filter,
                    )
                    or []
                )
                for h in hits:
                    if h.get("id") in by_id:
                        scores[h["id"]] = max(scores.get(h["id"], 0.0), float(h.get("score", 0.0)))
            except Exception:
                pass
        if by_id and hasattr(self.db, "search_by_fulltext"):
            with contextlib.suppress(Exception):
                for h in (
                    self.db.search_by_fulltext(
                        query_words=[text],
                        top_k=max(top_k * 3, 20),
                        scope=memory_type,
                        user_name=namespace,
                        search_filter=search_filter,
                    )
                    or []
                ):
                    if h.get("id") in by_id:
                        # 全文分数按 0.8 折算后和向量分数取大（两路合并，照 Hindsight）
                        s_ft = 0.8 * float(h.get("score", 0.0))
                        scores[h["id"]] = max(scores.get(h["id"], 0.0), s_ft)
        get_text = index_text or (lambda n: n.get("memory", ""))
        for nid, n in by_id.items():
            lex = lexical_sim(text, get_text(n))
            scores[nid] = max(scores.get(nid, 0.0), lex)
        ranked = sorted(
            ((s, by_id[i]) for i, s in scores.items()), key=lambda x: x[0], reverse=True
        )
        return ranked[:top_k]

    # ── Space ─────────────────────────────────────────────────────────────

    def put_space(self, space: Space) -> None:
        space.update_time = now_iso()
        self._put(space.space_id, space.space_name, PROJECT_SPACE, space.space_id, space.to_props())

    def get_space(self, space_id: str) -> Space | None:
        node = self._get(space_id, space_id)
        if not node or (node.get("metadata") or {}).get("memory_type") != PROJECT_SPACE:
            return None
        return Space.from_props(node["metadata"])

    def delete_space_nodes(self, space_id: str) -> int:
        n = 0
        for mt in (
            PROJECT_TOPIC,
            PROJECT_DECISION,
            PROJECT_EXPERIENCE,
            PROJECT_MESSAGE,
            PROJECT_EPISODE,
        ):
            for nid in self._ids(mt, space_id, status=None):
                self._delete(nid, space_id)
                n += 1
        self._delete(space_id, space_id)
        return n

    # ── 索引（按 id 读主题、按会话找 space）─────────────────────────────────

    def put_index(self, key: str, value: dict[str, Any]) -> None:
        self._put(
            stable_uuid(key),
            key,
            PROJECT_INDEX,
            INDEX_NAMESPACE,
            {"index_key": key, "value": value},
        )

    def get_index(self, key: str) -> dict[str, Any] | None:
        node = self._get(stable_uuid(key), INDEX_NAMESPACE)
        return (node or {}).get("metadata", {}).get("value") if node else None

    def delete_index(self, key: str) -> None:
        self._delete(stable_uuid(key), INDEX_NAMESPACE)

    # ── 任务 ──────────────────────────────────────────────────────────────

    def put_task(self, t: TaskRecord) -> None:
        t.update_time = now_iso()
        self._put(t.task_id, t.status, PROJECT_TASK, INDEX_NAMESPACE, t.to_props())

    def get_task(self, task_id: str) -> TaskRecord | None:
        node = self._get(task_id, INDEX_NAMESPACE)
        if not node or node["metadata"].get("memory_type") != PROJECT_TASK:
            return None
        return TaskRecord.from_props(node["metadata"])

    # ── 会话消息 ───────────────────────────────────────────────────────────

    def put_message(
        self, space_id: str, conversation_id: str, m: Msg, extra: dict[str, Any]
    ) -> str:
        node_id = m.node_id or stable_uuid(f"msg:{space_id}:{conversation_id}:{m.id}")
        m.node_id = node_id
        props = {
            "conversation_id": conversation_id,
            "message_id": m.id,
            "role": m.role,
            "chat_time": m.chat_time,
            "role_id": m.user_id,
            "role_name": m.name,
            "seq": m.seq,
            "tool_name": m.tool_name,
            "tool_args": m.tool_args,
            "tool_call_id": m.tool_call_id,
            "experience_notes": m.notes,
            **extra,
        }
        self._put(node_id, m.text, PROJECT_MESSAGE, space_id, props)
        return node_id

    def list_messages(self, space_id: str, conversation_id: str) -> list[Msg]:
        nodes = self._nodes(
            PROJECT_MESSAGE,
            space_id,
            [{"field": "conversation_id", "op": "=", "value": conversation_id}],
        )
        msgs = [self._to_msg(n) for n in nodes]
        msgs.sort(key=lambda m: (m.seq, m.chat_time))
        return msgs

    def get_messages(self, space_id: str, node_ids: list[str]) -> list[Msg]:
        if not node_ids:
            return []
        nodes = self.db.get_nodes(list(node_ids), user_name=space_id) or []
        by_id = {n["id"]: self._to_msg(n) for n in nodes}
        return [by_id[i] for i in node_ids if i in by_id]

    @staticmethod
    def _to_msg(n: dict[str, Any]) -> Msg:
        p = n.get("metadata") or {}
        return Msg(
            id=p.get("message_id", ""),
            role=p.get("role", ""),
            text=n.get("memory", ""),
            chat_time=p.get("chat_time", ""),
            user_id=p.get("role_id", ""),
            name=p.get("role_name", ""),
            tool_name=p.get("tool_name", ""),
            tool_args=p.get("tool_args", ""),
            tool_call_id=p.get("tool_call_id", ""),
            notes=list(p.get("experience_notes") or []),
            seq=int(p.get("seq", 0) or 0),
            node_id=n["id"],
        )

    # ── episode ───────────────────────────────────────────────────────────

    def put_episode(self, ep: Episode) -> None:
        self._put(ep.id, ep.conversation_id, PROJECT_EPISODE, ep.space_id, ep.to_props())

    def open_episodes(self, space_id: str) -> list[Episode]:
        nodes = self._nodes(
            PROJECT_EPISODE, space_id, [{"field": "episode_state", "op": "=", "value": "open"}]
        )
        nodes.sort(key=lambda n: (n.get("metadata") or {}).get("create_time", ""))
        return [Episode.from_node(n["id"], space_id, n["metadata"]) for n in nodes]

    def open_episode(self, space_id: str, conversation_id: str) -> Episode | None:
        nodes = self._nodes(
            PROJECT_EPISODE,
            space_id,
            [
                {"field": "conversation_id", "op": "=", "value": conversation_id},
                {"field": "episode_state", "op": "=", "value": "open"},
            ],
        )
        if not nodes:
            return None
        nodes.sort(key=lambda n: (n.get("metadata") or {}).get("create_time", ""))
        n = nodes[-1]
        return Episode.from_node(n["id"], space_id, n["metadata"])

    # ── 主题 ──────────────────────────────────────────────────────────────

    def put_topic(self, t: Topic) -> None:
        t.update_time = now_iso()
        self._put(
            t.id,
            t.summary or t.name,
            PROJECT_TOPIC,
            t.space_id,
            t.to_props(),
            embed_text=t.index_text,
        )
        self.put_index(f"topic:{t.id}", {"space_id": t.space_id})

    def get_topic(self, topic_id: str, space_id: str | None = None) -> Topic | None:
        if space_id is None:
            space_id = (self.get_index(f"topic:{topic_id}") or {}).get("space_id")
            if not space_id:
                return None
        node = self._get(topic_id, space_id)
        if not node or node["metadata"].get("memory_type") != PROJECT_TOPIC:
            return None
        return Topic.from_node(node["id"], node["metadata"])

    def list_topics(self, space_id: str) -> list[Topic]:
        topics = [
            Topic.from_node(n["id"], n["metadata"]) for n in self._nodes(PROJECT_TOPIC, space_id)
        ]
        topics.sort(key=lambda t: t.update_time, reverse=True)
        return topics

    def delete_topic(self, topic: Topic) -> None:
        for d in self.list_decisions(topic.space_id, topic.id):
            self._delete(d.id, topic.space_id)
        for e in self.list_experiences(topic.space_id, include_archived=True):
            if topic.id in e.topic_ids:
                e.topic_ids = [x for x in e.topic_ids if x != topic.id]
                self.put_experience(e)
        self._delete(topic.id, topic.space_id)
        self.delete_index(f"topic:{topic.id}")

    def recall_topics(
        self, space_id: str, text: str, top_k: int, domains: list[str] | None = None
    ) -> list[tuple[float, Topic]]:
        nodes = self._nodes(PROJECT_TOPIC, space_id)
        if domains:
            nodes = [n for n in nodes if n["metadata"].get("domain") in domains]
        ranked = self._recall(
            PROJECT_TOPIC,
            space_id,
            text,
            top_k,
            nodes,
            index_text=lambda n: "\n".join(
                str(n["metadata"].get(k, ""))
                for k in ("topic_name", "topic_summary", "topic_description")
            ),
        )
        return [(s, Topic.from_node(n["id"], n["metadata"])) for s, n in ranked]

    # ── 决策 ──────────────────────────────────────────────────────────────

    def put_decision(self, d: Decision, expected_rev: int | None = None) -> None:
        archived = [
            {
                "version": max(1, d.version - 1),
                "memory": h.content,
                "update_type": "conflict",
                "created_at": h.time,
            }
            for h in d.history
        ]
        props = {
            "topic_id": d.topic_id,  # 顶层冗余一份，按主题读决策时过滤用
            "project": d.to_project(),
            "version": d.version,
            "history": archived,
            "sources": [d.source.to_json()] + [h.source.to_json() for h in d.history],
        }
        self._put(
            d.id,
            d.content,
            PROJECT_DECISION,
            d.space_id,
            props,
            embed_text=d.index_text,
            expected_rev=expected_rev,
        )

    def get_decision(self, decision_id: str, space_id: str) -> Decision | None:
        node = self._get(decision_id, space_id)
        if not node or node["metadata"].get("memory_type") != PROJECT_DECISION:
            return None
        return _decision(node)

    def list_decisions(self, space_id: str, topic_id: str | None = None) -> list[Decision]:
        extra = [{"field": "topic_id", "op": "=", "value": topic_id}] if topic_id else []
        return [_decision(n) for n in self._nodes(PROJECT_DECISION, space_id, extra)]

    # ── 经验 ──────────────────────────────────────────────────────────────

    def put_experience(self, e: ExperienceCard, expected_rev: int | None = None) -> None:
        self._put(
            e.id,
            e.memory_text,
            PROJECT_EXPERIENCE,
            e.space_id,
            e.to_props(),
            embed_text=e.index_text,
            status=e.node_status,
            expected_rev=expected_rev,
        )

    def get_experience(self, exp_id: str, space_id: str) -> ExperienceCard | None:
        node = self._get(exp_id, space_id)
        if not node or node["metadata"].get("memory_type") != PROJECT_EXPERIENCE:
            return None
        return _experience(node)

    def list_experiences(
        self, space_id: str, include_archived: bool = False
    ) -> list[ExperienceCard]:
        nodes = self._nodes(
            PROJECT_EXPERIENCE, space_id, status=None if include_archived else "activated"
        )
        return [_experience(n) for n in nodes]

    def recall_experiences(
        self, space_id: str, text: str, top_k: int = 10
    ) -> list[tuple[float, ExperienceCard]]:
        nodes = self._nodes(PROJECT_EXPERIENCE, space_id)
        ranked = self._recall(
            PROJECT_EXPERIENCE,
            space_id,
            text,
            top_k,
            nodes,
            index_text=lambda n: f"{(n['metadata'].get('info') or {}).get('task_intent', '')}\n{(n['metadata'].get('info') or {}).get('problem', '')}",
        )
        return [(s, _experience(n)) for s, n in ranked]
