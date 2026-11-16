# -*- coding: utf-8 -*-
"""项目记忆（Project Memory）的数据结构。

口径（11/16 定）：
- Space 就是一个 mem_cube，隔离沿用 `user_name = cube_id`，不新造 tenant_id。
- 决策、经验、主题都存成一条 Memory 节点（`memories/textual/item.py` 的 TextualMemoryItem），
  种类靠 `properties.memory_type` 区分，见下面的三个常量。
- 一条决策的当前结论 = 节点的 `memory` 字段；不一致结论与历史放 `properties.project` 里，
  与 v4 §5.4 / T1 §5.1 的三张表一一对应，只是不另起关系表。

只依赖标准库，方便脱离完整 MemOS 依赖单独跑（见 demo_mock_add.py）。
"""

from __future__ import annotations

import copy
import uuid

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


# ── memory_type：与 EventMemory / SkillMemory 等并列的一种 view ─────────────────
MEMORY_VIEW_PROJECT = "project"
PROJECT_TOPIC = "ProjectTopicMemory"
PROJECT_DECISION = "ProjectDecisionMemory"
PROJECT_EXPERIENCE = "ProjectExperienceMemory"

ROLE_MEMBER = "member"
ROLE_AGENT = "agent"
ROLE_TOOL = "tool"

# 决策动作，T1 §5.1 的六种
OP_ADD = "add"
OP_JOIN = "join"
OP_CONFLICT_APPEND = "conflict_append"
OP_CONFLICT_UPDATE = "conflict_update"
OP_REWRITE = "rewrite"
OP_RESOLVE = "resolve"

# 经验动作，经验方案 §3.2
EXP_CREATE = "create"
EXP_UPDATE = "update"
EXP_DELETE = "delete"


def new_id(prefix: str) -> str:
    """生成带前缀的 ID。落库时转成 uuid（Memory 节点要求 uuid 主键）。"""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ── 输入侧 ─────────────────────────────────────────────────────────────────


@dataclass
class Msg:
    """一条会话消息。成员的话与 Agent 的最终回复分开，工具返回单独一类（经验要读，决策不读）。"""

    id: str
    role: str  # member | agent | tool
    text: str
    chat_time: str
    user_id: str = ""
    name: str = ""
    tool_name: str = ""
    tool_args: str = ""
    tool_output: str = ""

    @property
    def is_member(self) -> bool:
        return self.role == ROLE_MEMBER


@dataclass
class Source:
    """一项结论出自哪里：哪个会话、哪条消息、哪句原话（T1 §1，代码逐字核对用）。"""

    conversation_id: str = ""
    message_id: str = ""
    quote: str = ""

    def to_json(self) -> dict[str, Any]:
        return {"conversation_id": self.conversation_id, "message_id": self.message_id, "quote": self.quote}

    @classmethod
    def from_json(cls, d: dict[str, Any] | None) -> "Source":
        d = d or {}
        return cls(
            conversation_id=d.get("conversation_id", ""),
            message_id=d.get("message_id", ""),
            quote=d.get("quote", ""),
        )


@dataclass
class Episode:
    """一段连续做一件事的会话。与经验模块共用同一套切分（经验方案 §1.3）。"""

    id: str
    space_id: str
    conversation_id: str
    messages: list[Msg] = field(default_factory=list)
    topic_id: str = ""
    prev: list[Msg] = field(default_factory=list)  # 上一段最后一轮，看懂「就按方案二」
    closed_reason: str = ""

    @property
    def members(self) -> list[Msg]:
        return [m for m in self.messages if m.is_member]

    @property
    def agents(self) -> list[Msg]:
        return [m for m in self.messages if m.role == ROLE_AGENT]

    def member_names(self) -> list[str]:
        seen: list[str] = []
        for m in self.members:
            n = m.name or m.user_id
            if n and n not in seen:
                seen.append(n)
        return seen


# ── 决策 ───────────────────────────────────────────────────────────────────


@dataclass
class DecisionDraft:
    """抽取模型一次调用产出的一条草稿（T1 §2.2 的 10 个字段里，落库要用的都在）。"""

    message_id: str
    quote: str
    content: str
    user_name: str = ""
    user_id: str = ""
    chat_time: str = ""
    category: str = ""  # 范围 / 对外约定 / 共同约定
    change_reason: str = ""
    origin: str = "member"  # member | agent_proposed
    sure: bool = True  # 拿不准 → 只进丢弃清单
    resolve: bool = False  # 是不是定案的表态
    approved_by: list[str] = field(default_factory=list)  # 已和谁确认
    listed: list[str] = field(default_factory=list)  # Agent 此前说过的已有结论（逐字片段）
    dropped_reason: str = ""


@dataclass
class ConflictItem:
    """还没人拍板的不一致结论，一项一行（对应 decision_conflicts 表）。"""

    seq: int
    content: str
    time: str
    user_ids: list[str] = field(default_factory=list)
    source: Source = field(default_factory=Source)

    def to_json(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "content": self.content,
            "time": self.time,
            "user_ids": list(self.user_ids),
            "source": self.source.to_json(),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "ConflictItem":
        return cls(
            seq=int(d.get("seq", 0)),
            content=d.get("content", ""),
            time=d.get("time", ""),
            user_ids=list(d.get("user_ids") or []),
            source=Source.from_json(d.get("source")),
        )


@dataclass
class HistoryItem:
    """被替换下来的历次结论，只追加（对应 decision_history 表）。"""

    seq: int
    content: str
    time: str
    user_ids: list[str] = field(default_factory=list)
    source: Source = field(default_factory=Source)
    reason: str = ""
    change_source: Source = field(default_factory=Source)

    def to_json(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "content": self.content,
            "time": self.time,
            "user_ids": list(self.user_ids),
            "source": self.source.to_json(),
            "reason": self.reason,
            "change_source": self.change_source.to_json(),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "HistoryItem":
        return cls(
            seq=int(d.get("seq", 0)),
            content=d.get("content", ""),
            time=d.get("time", ""),
            user_ids=list(d.get("user_ids") or []),
            source=Source.from_json(d.get("source")),
            reason=d.get("reason", ""),
            change_source=Source.from_json(d.get("change_source")),
        )


class InvariantError(AssertionError):
    """三条不变式之一被破坏。写入前自检，不通过就不写。"""


@dataclass
class Decision:
    """一条决策 = 一条 Memory 节点。`memory` 存当前结论。"""

    id: str = field(default_factory=lambda: new_id("dec"))
    space_id: str = ""
    topic_id: str = ""
    content: str = ""
    time: str = ""
    user_ids: list[str] = field(default_factory=list)
    source: Source = field(default_factory=Source)
    conflicts: list[ConflictItem] = field(default_factory=list)
    history: list[HistoryItem] = field(default_factory=list)
    version: int = 1
    category: str = ""
    reason: str = ""
    user_labels: dict[str, str] = field(default_factory=dict)  # user_id → 显示名，注入时用

    # —— 查表，不是模型判断（T1 §4.3）——
    def item_of(self, user_id: str) -> str | None:
        """这个成员现在占哪一项：`content` / `conflict:<seq>` / None。"""
        if user_id in self.user_ids:
            return "content"
        for c in self.conflicts:
            if user_id in c.user_ids:
                return f"conflict:{c.seq}"
        return None

    def conflict(self, target: str) -> ConflictItem:
        for c in self.conflicts:
            if f"conflict:{c.seq}" == target:
                return c
        raise KeyError(target)

    def as_item(self) -> ConflictItem:
        return ConflictItem(
            seq=0, content=self.content, time=self.time, user_ids=list(self.user_ids), source=self.source
        )

    # —— 三条不变式（T1 §0 / v0.12 §3.1 约束 ①）——
    def check(self) -> None:
        seen: set[str] = set()
        for grp in [self.user_ids] + [c.user_ids for c in self.conflicts]:
            for u in grp:
                if u in seen:
                    raise InvariantError(f"不变式 1：成员 {u} 同时出现在两项结论里")
                seen.add(u)
        if not self.user_ids:
            raise InvariantError("不变式 3：当前结论的负责人不能为空")
        if any(c.content == self.content for c in self.conflicts):
            raise InvariantError("不变式 2：不一致结论不能与当前结论相同")

    def to_json(self) -> dict[str, Any]:
        return {
            "topic_id": self.topic_id,
            "space_id": self.space_id,
            "content": self.content,
            "time": self.time,
            "user_ids": list(self.user_ids),
            "source": self.source.to_json(),
            "conflicts": [c.to_json() for c in self.conflicts],
            "history": [h.to_json() for h in self.history],
            "version": self.version,
            "category": self.category,
            "reason": self.reason,
            "user_labels": dict(self.user_labels),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any], decision_id: str = "") -> "Decision":
        return cls(
            id=decision_id or d.get("id", "") or new_id("dec"),
            space_id=d.get("space_id", ""),
            topic_id=d.get("topic_id", ""),
            content=d.get("content", ""),
            time=d.get("time", ""),
            user_ids=list(d.get("user_ids") or []),
            source=Source.from_json(d.get("source")),
            conflicts=[ConflictItem.from_json(c) for c in d.get("conflicts") or []],
            history=[HistoryItem.from_json(h) for h in d.get("history") or []],
            version=int(d.get("version", 1)),
            category=d.get("category", ""),
            reason=d.get("reason", ""),
            user_labels=dict(d.get("user_labels") or {}),
        )


@dataclass
class DecisionAction:
    """合并环节的输出：动作 + 落库需要的全部字段，存储层只照写不重判。"""

    op: str
    user_ids: list[str] = field(default_factory=list)
    content: str = ""
    time: str = ""
    source: Source = field(default_factory=Source)
    target: str = ""  # join / conflict_update / resolve 时指向哪一项
    reason: str = ""
    merge_with: str = ""  # rewrite 时可并进某一项不一致结论
    decision_id: str = ""  # 落到哪条决策
    dropped_old_conflicts: int = 0


# ── 经验 ───────────────────────────────────────────────────────────────────


@dataclass
class ExperienceCard:
    """经验卡片。字段照 MemoraX，验证与合并照 EverOS / Hindsight（经验方案 §2.3）。"""

    id: str = field(default_factory=lambda: new_id("exp"))
    space_id: str = ""
    topic_id: str = ""
    form: str = "insight"  # principle | insight | failed_attempt
    task_intent: str = ""
    problem: str = ""
    principle: str = ""
    technical_context: str = ""
    failed_shape: str = ""
    expected_outcome: str = ""
    validation: str = ""
    exclusions: str = ""
    anchors: list[str] = field(default_factory=list)
    confidence: float = 0.5
    status: str = "candidate"  # candidate | verified | disputed | revoked
    signal: str = ""  # 依据：test / doc_check / member_accept
    user_ids: list[str] = field(default_factory=list)
    time: str = ""
    use_count: int = 0
    sources: list[dict[str, Any]] = field(default_factory=list)
    user_labels: dict[str, str] = field(default_factory=dict)

    @property
    def index_text(self) -> str:
        return f"{self.task_intent}\n{self.problem}"

    def to_json(self) -> dict[str, Any]:
        return {
            "topic_id": self.topic_id,
            "space_id": self.space_id,
            "form": self.form,
            "task_intent": self.task_intent,
            "problem": self.problem,
            "principle": self.principle,
            "technical_context": self.technical_context,
            "failed_shape": self.failed_shape,
            "expected_outcome": self.expected_outcome,
            "validation": self.validation,
            "exclusions": self.exclusions,
            "anchors": list(self.anchors),
            "confidence": self.confidence,
            "status": self.status,
            "signal": self.signal,
            "user_ids": list(self.user_ids),
            "time": self.time,
            "use_count": self.use_count,
            "sources": copy.deepcopy(self.sources),
            "user_labels": dict(self.user_labels),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any], exp_id: str = "") -> "ExperienceCard":
        return cls(
            id=exp_id or d.get("id", "") or new_id("exp"),
            space_id=d.get("space_id", ""),
            topic_id=d.get("topic_id", ""),
            form=d.get("form", "insight"),
            task_intent=d.get("task_intent", ""),
            problem=d.get("problem", ""),
            principle=d.get("principle", ""),
            technical_context=d.get("technical_context", ""),
            failed_shape=d.get("failed_shape", ""),
            expected_outcome=d.get("expected_outcome", ""),
            validation=d.get("validation", ""),
            exclusions=d.get("exclusions", ""),
            anchors=list(d.get("anchors") or []),
            confidence=float(d.get("confidence", 0.5)),
            status=d.get("status", "candidate"),
            signal=d.get("signal", ""),
            user_ids=list(d.get("user_ids") or []),
            time=d.get("time", ""),
            use_count=int(d.get("use_count", 0)),
            sources=list(d.get("sources") or []),
            user_labels=dict(d.get("user_labels") or {}),
        )


# ── 主题 ───────────────────────────────────────────────────────────────────


@dataclass
class Topic:
    id: str = field(default_factory=lambda: new_id("topic"))
    space_id: str = ""
    domain: str = ""
    name: str = ""
    summary: str = ""
    description: str = ""
    create_time: str = field(default_factory=now_iso)
    update_time: str = field(default_factory=now_iso)
    sources: list[dict[str, Any]] = field(default_factory=list)

    @property
    def index_text(self) -> str:
        return f"{self.name}\n{self.summary}\n{self.description}"

    def to_json(self) -> dict[str, Any]:
        return {
            "space_id": self.space_id,
            "domain": self.domain,
            "name": self.name,
            "summary": self.summary,
            "description": self.description,
            "create_time": self.create_time,
            "update_time": self.update_time,
            "sources": copy.deepcopy(self.sources),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any], topic_id: str = "") -> "Topic":
        return cls(
            id=topic_id or d.get("id", "") or new_id("topic"),
            space_id=d.get("space_id", ""),
            domain=d.get("domain", ""),
            name=d.get("name", ""),
            summary=d.get("summary", ""),
            description=d.get("description", ""),
            create_time=d.get("create_time", now_iso()),
            update_time=d.get("update_time", now_iso()),
            sources=list(d.get("sources") or []),
        )


# ── 结果 ───────────────────────────────────────────────────────────────────


@dataclass
class IngestResult:
    """一次 add/message 的结果，对应 get/status 的 memory_views.project。"""

    task_id: str = field(default_factory=lambda: new_id("task"))
    status: str = "completed"
    topic_ids: list[str] = field(default_factory=list)
    decision_ops: list[dict[str, Any]] = field(default_factory=list)
    experience_ops: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[dict[str, Any]] = field(default_factory=list)  # 丢弃清单，供统计判据
    trace: list[str] = field(default_factory=list)  # 主干每一步，给人看链路

    def log(self, line: str) -> None:
        self.trace.append(line)

    def memory_views(self) -> dict[str, Any]:
        return {
            "added": len(self.decision_ops) + len(self.experience_ops),
            "updated": 0,
            "deleted": 0,
            "project": {"memory_ids": list(self.topic_ids)},
        }


EpisodeClosedReason = Literal[
    "topic_boundary", "max_tokens", "max_messages", "idle_timeout", "experience_note", "end_of_input"
]
