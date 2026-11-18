"""默认的归主题与进展（摘要、描述、演变轨迹）——冉浚枫的归类与进展抽取接入前的占位。

接口分两步，便于同一 Space 里多个段并行整理：
- `choose(hub, store, space, ep, domains, log) -> TopicChoice`：召回已有主题 + 一次模型调用，
  只读不写，不需要加锁；
- `apply(store, space, ep, choice, domains, log) -> Topic | None`：把选择落到主题上（并入已有主题时
  重读最新的主题再改摘要、描述、时间线、来源；新建时生成主题）。调用方负责加锁：
  并入已有主题拿这个主题的锁，新建主题拿这个 Space 主题列表的锁并先用 `changed_since` 复核。
`assign()` 是两步顺序执行的旧接口，不加锁，单线程时用。返回 None 表示这一段不整理
（PRD：所属领域不在本次 domains 里，或看不出说的是哪项工作）。换成正式模块时换这几个函数。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .prompts import TOPIC_ASSIGN
from .types import Episode, Space, Topic, now_iso


if TYPE_CHECKING:
    from .judge import ModelHub
    from .store import ProjectStore


MAX_TOPICS_IN_PROMPT = 30


@dataclass
class TopicChoice:
    """一次归主题的模型结论（还没写库）。"""

    skip: bool = False
    topic_id: str | None = None  # 并入的已有主题；None 表示新建
    new_topic: dict[str, Any] = field(default_factory=dict)
    summary: str | None = None
    description: str | None = None
    timeline: list[Any] = field(default_factory=list)
    seen_ids: set[str] = field(default_factory=set)  # 判断时这个 Space 里已有的全部主题


def changed_since(store: ProjectStore, space_id: str, choice: TopicChoice) -> bool:
    """判断之后这个 Space 有没有别的段新建了主题（新建前复核用）。"""
    return bool({t.id for t in store.list_topics(space_id)} - choice.seen_ids)


def choose(
    hub: ModelHub, store: ProjectStore, space: Space, ep: Episode, domains: list[str], log
) -> TopicChoice:
    seen = {t.id for t in store.list_topics(space.space_id)}
    text = "\n".join(m.text for m in ep.messages if m.role != "tool")
    ranked = store.recall_topics(space.space_id, text, MAX_TOPICS_IN_PROMPT, domains=None)
    topics = [t for _, t in ranked]
    allowed = [d for d in space.domains if d.name in domains] or space.domains
    inputs = {
        "instructions": space.instructions,
        "domains": [{"name": d.name, "description": d.description} for d in allowed],
        "topics": [
            {
                "id": t.id,
                "domain": t.domain,
                "name": t.name,
                "summary": t.summary,
                "description": t.description,
            }
            for t in topics
        ],
        "episode": [
            {
                "id": m.id,
                "role": m.role,
                "text": m.text,
                **({"name": m.speaker} if m.is_member else {}),
            }
            for m in ep.messages
            if m.role != "tool"
        ],
    }
    out = hub.write("topic.assign", TOPIC_ASSIGN, inputs)
    if out.get("skip"):
        log("归主题：skip（领域不在范围内或看不出是哪项工作），这一段不整理")
        return TopicChoice(skip=True, seen_ids=seen)

    names = [d.name for d in allowed]
    picked = next((t for t in topics if t.id == out.get("topic_id")), None)
    if picked is not None and picked.domain not in names:
        log(f"归主题：模型选的主题领域「{picked.domain}」不在本次范围，按新建处理")
        picked = None
    return TopicChoice(
        topic_id=picked.id if picked is not None else None,
        new_topic=out.get("new_topic") or {},
        summary=str(out["summary"]) if out.get("summary") else None,
        description=str(out["description"]) if out.get("description") else None,
        timeline=list(out.get("timeline") or []),
        seen_ids=seen,
    )


def apply(
    store: ProjectStore, space: Space, ep: Episode, choice: TopicChoice, domains: list[str], log
) -> Topic | None:
    if choice.skip:
        return None
    allowed = [d for d in space.domains if d.name in domains] or space.domains
    names = [d.name for d in allowed]
    topic = store.get_topic(choice.topic_id) if choice.topic_id else None  # 重读最新的
    if topic is None:
        new = choice.new_topic
        domain = new.get("domain") if new.get("domain") in names else names[0]
        topic = Topic(
            space_id=space.space_id,
            domain=domain,
            name=(new.get("name") or _fallback_name(ep))[:20],
            summary=(new.get("summary") or "")[:80],
            description=(new.get("description") or "")[:400],
        )
        log(f"归主题：新建「{topic.name}」（{topic.domain}）")
    else:
        if choice.summary:
            topic.summary = choice.summary[:80]
        if choice.description:
            topic.description = choice.description[:400]
        log(f"归主题：并入「{topic.name}」")

    for item in choice.timeline:
        content = item if isinstance(item, str) else (item or {}).get("content")
        if content:
            topic.timeline.append(
                {
                    "content": str(content)[:100],
                    "time": ep.messages[-1].chat_time if ep.messages else now_iso(),
                    "user_ids": _member_ids(ep),
                }
            )
    _add_source(topic, ep)
    store.put_topic(topic)
    return topic


def assign(
    hub: ModelHub, store: ProjectStore, space: Space, ep: Episode, domains: list[str], log
) -> Topic | None:
    """两步顺序执行（不加锁，单线程用）。"""
    return apply(store, space, ep, choose(hub, store, space, ep, domains, log), domains, log)


def _member_ids(ep: Episode) -> list[str]:
    out: list[str] = []
    for m in ep.members:
        uid = m.user_id or m.name
        if uid and uid not in out:
            out.append(uid)
    return out


def _add_source(topic: Topic, ep: Episode) -> None:
    conv = ep.conversation_id or None
    uids = _member_ids(ep)
    for s in topic.sources:
        if s.get("conversation_id") == conv and conv is not None:
            have = s.get("user_id") if isinstance(s.get("user_id"), list) else [s.get("user_id")]
            s["user_id"] = sorted({*[u for u in have if u], *uids})
            return
    topic.sources.append(
        {"conversation_id": conv, "user_id": uids, "agent_id": ep.agent_id or None}
    )


def _fallback_name(ep: Episode) -> str:
    first = next((m.text for m in ep.members if m.text), "未命名主题")
    return first[:20]


def topic_entry(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": item.get("content", ""),
        "time": item.get("time", ""),
        "user_ids": item.get("user_ids", []),
    }
