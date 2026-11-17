"""项目记忆（memory view `project`）的数据结构。

口径（11/16–11/17 定）：
- Space 就是一个 mem_cube：`space_id` 即 cube id，隔离沿用 `user_name = space_id`，不新造 tenant_id。
- Space 的名称、项目指令、领域清单也放在这个 cube 里：一条 `ProjectSpaceMemory` 节点。
- 主题、决策、经验、会话消息、episode 都是 `Memory` 表里的一行，靠 `properties.memory_type` 区分。
- 决策一行的样子照《决策抽取 · 维护 · 冲突处理 模块方案评审》§2.3；
  经验一行的样子照《经验抽取 · 验证 · 维护 模块方案评审》§2.3。
- 节点 id 一律 UUID：`Memory.id` 是全表主键，核心读节点时还会按 UUID 校验。
"""

from __future__ import annotations

import copy
import uuid

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


# ── memory_type ────────────────────────────────────────────────────────────

MEMORY_VIEW_PROJECT = "project"
PROJECT_SPACE = "ProjectSpaceMemory"
PROJECT_TOPIC = "ProjectTopicMemory"
PROJECT_DECISION = "ProjectDecisionMemory"
PROJECT_EXPERIENCE = "ExperienceMemory"
PROJECT_MESSAGE = "ProjectMessageMemory"
PROJECT_EPISODE = "ProjectEpisodeMemory"
PROJECT_TASK = "ProjectTaskMemory"
PROJECT_INDEX = "ProjectIndexMemory"

# 不属于任何 Space 的辅助节点（任务、id → space 的索引）放在这个命名空间
INDEX_NAMESPACE = "__project_memory_index__"

ROLE_MEMBER = "member"
ROLE_AGENT = "agent"
ROLE_TOOL = "tool"

# 决策动作（决策方案 §5.2）
OP_ADD = "add"
OP_JOIN = "join"
OP_CONFLICT = "conflict"
OP_REWRITE = "rewrite"
OP_RESOLVE = "resolve"
DECISION_ACTIONS = (OP_ADD, OP_RESOLVE, OP_REWRITE, OP_JOIN, OP_CONFLICT)

# 经验动作（经验方案 §5.2）
EXP_ADD = "add"
EXP_UPDATE = "update"
EXP_CONFIRM = "confirm"
EXP_REFUTE = "refute"
EXP_ACTIONS = (EXP_ADD, EXP_UPDATE, EXP_CONFIRM, EXP_REFUTE)

EXP_VERIFIED = "verified"
EXP_CANDIDATE = "candidate"
EXP_FAILED = "failed_attempt"

# episode 与段关系（每轮一次判别）
TURN_FOLLOW_UP = "follow_up"
TURN_NEW_TASK = "new_task"
TURN_END_TOPIC = "end_topic"


def new_uuid() -> str:
    return str(uuid.uuid4())


def stable_uuid(key: str) -> str:
    """同一个键永远得到同一个 UUID（索引节点、去重用）。"""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"memos-project-memory:{key}"))


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ── Space ──────────────────────────────────────────────────────────────────


@dataclass
class Domain:
    name: str
    description: str = ""


@dataclass
class Space:
    space_id: str
    space_name: str
    instructions: str = ""
    domains: list[Domain] = field(default_factory=list)
    create_time: str = field(default_factory=now_iso)
    update_time: str = field(default_factory=now_iso)

    def domain_names(self) -> list[str]:
        return [d.name for d in self.domains]

    def to_props(self) -> dict[str, Any]:
        return {
            "space_id": self.space_id,
            "space_name": self.space_name,
            "instructions": self.instructions,
            "domains": [asdict(d) for d in self.domains],
            "create_time": self.create_time,
            "update_time": self.update_time,
        }

    @classmethod
    def from_props(cls, p: dict[str, Any]) -> Space:
        return cls(
            space_id=p.get("space_id", ""),
            space_name=p.get("space_name", ""),
            instructions=p.get("instructions", "") or "",
            domains=[Domain(**d) for d in p.get("domains") or []],
            create_time=p.get("create_time") or now_iso(),
            update_time=p.get("update_time") or now_iso(),
        )

    def to_api(self) -> dict[str, Any]:
        return {
            "space_id": self.space_id,
            "space_name": self.space_name,
            "instructions": self.instructions,
            "domains": [asdict(d) for d in self.domains],
            "create_time": self.create_time,
            "update_time": self.update_time,
        }


# ── 会话 ───────────────────────────────────────────────────────────────────


@dataclass
class Msg:
    """一条会话消息。成员的话、Agent 回复、工具返回分三类（决策只读前两类，经验三类都读）。"""

    id: str
    role: str  # member | agent | tool
    text: str
    chat_time: str
    user_id: str = ""
    name: str = ""
    tool_name: str = ""
    tool_args: str = ""
    tool_call_id: str = ""
    notes: list[dict[str, Any]] = field(default_factory=list)  # Agent 当场写的经验稿
    seq: int = 0
    node_id: str = ""

    @property
    def is_member(self) -> bool:
        return self.role == ROLE_MEMBER

    @property
    def speaker(self) -> str:
        return self.name or self.user_id


@dataclass
class Source:
    """一项结论出自哪里：哪个会话、哪条消息、哪句原话。"""

    conversation_id: str = ""
    message_id: str = ""
    quote: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "message_id": self.message_id,
            "quote": self.quote,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any] | None) -> Source:
        d = d or {}
        return cls(d.get("conversation_id", ""), d.get("message_id", ""), d.get("quote", ""))


@dataclass
class Episode:
    """同一会话里连续做一件事的一段。决策与经验共用。"""

    id: str
    space_id: str
    conversation_id: str
    message_ids: list[str] = field(default_factory=list)
    state: str = "open"  # open | closed
    closed_reason: str = ""
    topic_id: str = ""
    prev_message_ids: list[str] = field(default_factory=list)  # 上一段最后一轮
    domains: list[str] = field(default_factory=list)
    task_ids: list[str] = field(default_factory=list)
    agent_id: str = ""
    create_time: str = field(default_factory=now_iso)
    # 运行时填充
    messages: list[Msg] = field(default_factory=list)
    prev: list[Msg] = field(default_factory=list)

    @property
    def members(self) -> list[Msg]:
        return [m for m in self.messages if m.is_member]

    @property
    def agents(self) -> list[Msg]:
        return [m for m in self.messages if m.role == ROLE_AGENT]

    @property
    def tools(self) -> list[Msg]:
        return [m for m in self.messages if m.role == ROLE_TOOL]

    def member_names(self) -> list[str]:
        seen: list[str] = []
        for m in self.prev + self.messages:
            if m.is_member and m.speaker and m.speaker not in seen:
                seen.append(m.speaker)
        return seen

    def to_props(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "message_ids": list(self.message_ids),
            "episode_state": self.state,
            "closed_reason": self.closed_reason,
            "topic_id": self.topic_id,
            "prev_message_ids": list(self.prev_message_ids),
            "domains": list(self.domains),
            "task_ids": list(self.task_ids),
            "agent_id": self.agent_id,
            "create_time": self.create_time,
        }

    @classmethod
    def from_node(cls, node_id: str, space_id: str, p: dict[str, Any]) -> Episode:
        return cls(
            id=node_id,
            space_id=space_id,
            conversation_id=p.get("conversation_id", ""),
            message_ids=list(p.get("message_ids") or []),
            state=p.get("episode_state", "open"),
            closed_reason=p.get("closed_reason", ""),
            topic_id=p.get("topic_id", ""),
            prev_message_ids=list(p.get("prev_message_ids") or []),
            domains=list(p.get("domains") or []),
            task_ids=list(p.get("task_ids") or []),
            agent_id=p.get("agent_id", "") or "",
            create_time=p.get("create_time") or now_iso(),
        )


# ── 主题 ───────────────────────────────────────────────────────────────────


@dataclass
class Topic:
    id: str = field(default_factory=new_uuid)
    space_id: str = ""
    domain: str = ""
    name: str = ""
    summary: str = ""
    description: str = ""
    timeline: list[dict[str, Any]] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    create_time: str = field(default_factory=now_iso)
    update_time: str = field(default_factory=now_iso)

    @property
    def index_text(self) -> str:
        return f"{self.name}\n{self.summary}\n{self.description}"

    def related_user_ids(self) -> set[str]:
        out: set[str] = set()
        for s in self.sources:
            uid = s.get("user_id")
            if isinstance(uid, list):
                out.update(uid)
            elif uid:
                out.add(uid)
        return out

    def to_props(self) -> dict[str, Any]:
        return {
            "space_id": self.space_id,
            "domain": self.domain,
            "topic_name": self.name,
            "topic_summary": self.summary,
            "topic_description": self.description,
            "timeline": copy.deepcopy(self.timeline),
            "topic_sources": copy.deepcopy(self.sources),
            "create_time": self.create_time,
            "update_time": self.update_time,
        }

    @classmethod
    def from_node(cls, node_id: str, p: dict[str, Any]) -> Topic:
        return cls(
            id=node_id,
            space_id=p.get("space_id", ""),
            domain=p.get("domain", ""),
            name=p.get("topic_name", ""),
            summary=p.get("topic_summary", ""),
            description=p.get("topic_description", ""),
            timeline=list(p.get("timeline") or []),
            sources=list(p.get("topic_sources") or []),
            create_time=p.get("create_time") or now_iso(),
            update_time=p.get("update_time") or now_iso(),
        )


# ── 决策 ───────────────────────────────────────────────────────────────────


@dataclass
class DecisionDraft:
    """第一次调用（判定 + 抽取）的一条输出，9 个字段 + 代码从消息元数据补的说话人与时间。"""

    message_id: str
    quote: str
    content: str | None
    category: str = ""
    change_reason: str | None = None
    sure: bool = True
    final: bool = False
    approved_by: list[str] = field(default_factory=list)
    listed: list[str] = field(default_factory=list)
    # 代码补
    user_id: str = ""
    name: str = ""
    time: str = ""


@dataclass
class ConflictItem:
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
    def from_json(cls, d: dict[str, Any]) -> ConflictItem:
        return cls(
            seq=int(d.get("seq", 0)),
            content=d.get("content", ""),
            time=d.get("time", ""),
            user_ids=list(d.get("user_ids") or []),
            source=Source.from_json(d.get("source")),
        )


@dataclass
class HistoryItem:
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
    def from_json(cls, d: dict[str, Any]) -> HistoryItem:
        return cls(
            seq=int(d.get("seq", 0)),
            content=d.get("content", ""),
            time=d.get("time", ""),
            user_ids=list(d.get("user_ids") or []),
            source=Source.from_json(d.get("source")),
            reason=d.get("reason", "") or "",
            change_source=Source.from_json(d.get("change_source")),
        )


class InvariantError(AssertionError):
    """三条不变式之一被破坏。写入前自检，不通过就不写。"""


@dataclass
class Decision:
    """一条决策 = 一条 Memory 节点。`memory` = 当前结论。"""

    id: str = field(default_factory=new_uuid)
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
    user_labels: dict[str, str] = field(default_factory=dict)

    def items(self) -> dict[str, ConflictItem]:
        """在用的各项 I(D)：current、c1、c2……（给第二次调用、也给代码护栏用）。"""
        out = {
            "current": ConflictItem(0, self.content, self.time, list(self.user_ids), self.source)
        }
        for c in self.conflicts:
            out[f"c{c.seq}"] = c
        return out

    def item_of(self, user_id: str) -> str | None:
        if user_id in self.user_ids:
            return "current"
        for c in self.conflicts:
            if user_id in c.user_ids:
                return f"c{c.seq}"
        return None

    def conflict(self, key: str) -> ConflictItem:
        for c in self.conflicts:
            if f"c{c.seq}" == key:
                return c
        raise KeyError(key)

    def check(self) -> None:
        seen: set[str] = set()
        for grp in [self.user_ids] + [c.user_ids for c in self.conflicts]:
            for u in grp:
                if u in seen:
                    raise InvariantError(f"不变式 1：成员 {u} 同时属于两项结论")
                seen.add(u)
        if not self.user_ids:
            raise InvariantError("不变式 3：当前结论的负责人不能为空")

    def to_project(self) -> dict[str, Any]:
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
    def from_node(cls, node_id: str, memory: str, p: dict[str, Any]) -> Decision:
        d = p.get("project") or {}
        return cls(
            id=node_id,
            space_id=d.get("space_id", ""),
            topic_id=d.get("topic_id", "") or p.get("topic_id", ""),
            content=d.get("content") or memory,
            time=d.get("time", ""),
            user_ids=list(d.get("user_ids") or []),
            source=Source.from_json(d.get("source")),
            conflicts=[ConflictItem.from_json(c) for c in d.get("conflicts") or []],
            history=[HistoryItem.from_json(h) for h in d.get("history") or []],
            version=int(d.get("version", 1)),
            category=d.get("category", ""),
            reason=d.get("reason", "") or "",
            user_labels=dict(d.get("user_labels") or {}),
        )

    @property
    def index_text(self) -> str:
        """索引文本 = 当前结论 + 各项不一致结论（决策方案 §5.2）。"""
        return "\n".join([self.content] + [c.content for c in self.conflicts])


# ── 经验 ───────────────────────────────────────────────────────────────────


CARD_FIELDS = (
    "task_intent",
    "problem",
    "technical_context",
    "failed_shape",
    "principle",
    "validation",
    "anchors",
)


@dataclass
class ExperienceCard:
    """经验卡片。一行的样子照经验方案 §2.3：卡片字段在 `info`，检索键在顶层。"""

    id: str = field(default_factory=new_uuid)
    space_id: str = ""
    task_intent: str = ""
    problem: str = ""
    technical_context: str | None = None
    failed_shape: str | None = None
    principle: str = ""
    validation: str | None = None
    anchors: list[str] = field(default_factory=list)
    exp_status: str = EXP_CANDIDATE  # verified | candidate | failed_attempt
    signal: str = "none"  # test | build | review | user | none
    quality_score: float | None = None
    confidence: float = 0.5
    version: int = 1
    user_id: str = ""
    session_id: str = ""
    author_ids: list[str] = field(default_factory=list)
    use_count: int = 0
    topic_ids: list[str] = field(default_factory=list)
    time: str = ""
    last_supported_at: str = ""
    merged_into: str = ""
    node_status: str = "activated"  # activated | archived
    sources: list[dict[str, Any]] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)

    @property
    def memory_text(self) -> str:
        return "｜".join(x for x in (self.task_intent, self.problem, self.principle) if x)

    @property
    def index_text(self) -> str:
        return f"{self.task_intent}\n{self.problem}"

    @property
    def visibility(self) -> str:
        return "private" if self.exp_status == EXP_CANDIDATE else "public"

    def card(self) -> dict[str, Any]:
        return {k: copy.deepcopy(getattr(self, k)) for k in CARD_FIELDS}

    def to_props(self) -> dict[str, Any]:
        return {
            "user_id": self.user_id,
            "session_id": self.session_id,
            "visibility": self.visibility,
            "key": self.task_intent,
            "confidence": round(self.confidence, 4),
            "version": self.version,
            "topic_ids": list(self.topic_ids),
            "anchors": list(self.anchors),
            "info": {
                "task_intent": self.task_intent,
                "problem": self.problem,
                "technical_context": self.technical_context,
                "failed_shape": self.failed_shape,
                "principle": self.principle,
                "validation": self.validation,
                "exp_status": self.exp_status,
                "signal": self.signal,
                "quality_score": self.quality_score,
                "author_ids": list(self.author_ids),
                "use_count": self.use_count,
                "time": self.time,
                "last_supported_at": self.last_supported_at,
                "merged_into": self.merged_into,
            },
            "sources": copy.deepcopy(self.sources),
            "history": copy.deepcopy(self.history),
        }

    @classmethod
    def from_node(cls, node_id: str, p: dict[str, Any]) -> ExperienceCard:
        info = p.get("info") or {}
        return cls(
            id=node_id,
            space_id=p.get("user_name", ""),
            task_intent=info.get("task_intent") or p.get("key", ""),
            problem=info.get("problem", ""),
            technical_context=info.get("technical_context"),
            failed_shape=info.get("failed_shape"),
            principle=info.get("principle", ""),
            validation=info.get("validation"),
            anchors=list(p.get("anchors") or []),
            exp_status=info.get("exp_status", EXP_CANDIDATE),
            signal=info.get("signal", "none") or "none",
            quality_score=info.get("quality_score"),
            confidence=float(p.get("confidence", 0.5)),
            version=int(p.get("version", 1)),
            user_id=p.get("user_id", ""),
            session_id=p.get("session_id", ""),
            author_ids=list(info.get("author_ids") or []),
            use_count=int(info.get("use_count", 0)),
            topic_ids=list(p.get("topic_ids") or []),
            time=info.get("time", ""),
            last_supported_at=info.get("last_supported_at", ""),
            merged_into=info.get("merged_into", ""),
            node_status=p.get("status", "activated"),
            sources=list(p.get("sources") or []),
            history=list(p.get("history") or []),
        )

    def has_evidence(self) -> bool:
        """ev(k)：verified，或带作证来源的 failed_attempt（经验方案 §5.2）。"""
        return self.exp_status == EXP_VERIFIED or (
            self.exp_status == EXP_FAILED and self.signal not in ("", "none", None)
        )


# ── 任务 ───────────────────────────────────────────────────────────────────


@dataclass
class TaskRecord:
    task_id: str
    user_id: str = ""
    space_ids: list[str] = field(default_factory=list)
    status: str = "in_progress"  # in_progress | completed | failed
    memory_ids: list[str] = field(default_factory=list)
    pending_spaces: list[str] = field(default_factory=list)
    open_episode_messages: int = 0
    error: str = ""
    create_time: str = field(default_factory=now_iso)
    update_time: str = field(default_factory=now_iso)

    def to_props(self) -> dict[str, Any]:
        return {k: copy.deepcopy(v) for k, v in asdict(self).items()}

    @classmethod
    def from_props(cls, p: dict[str, Any]) -> TaskRecord:
        keys = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in p.items() if k in keys})

    def to_api(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "status": self.status,
            "memory_views": {
                "added": 0,
                "updated": len(self.memory_ids),
                "deleted": 0,
                "project": {
                    "memory_ids": list(self.memory_ids),
                    "open_episode_messages": self.open_episode_messages,
                },
            },
        }


# ── 一次整理的结果（trace 给人看链路）────────────────────────────────────────


@dataclass
class OrganizeResult:
    topic_ids: list[str] = field(default_factory=list)
    decision_ops: list[dict[str, Any]] = field(default_factory=list)
    experience_ops: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[dict[str, Any]] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)

    def log(self, line: str) -> None:
        self.trace.append(line)

    def merge(self, other: OrganizeResult) -> None:
        for t in other.topic_ids:
            if t not in self.topic_ids:
                self.topic_ids.append(t)
        self.decision_ops += other.decision_ops
        self.experience_ops += other.experience_ops
        self.dropped += other.dropped
        self.trace += other.trace
