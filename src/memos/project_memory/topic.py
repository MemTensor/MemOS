"""默认的归主题与进展（摘要、描述、演变轨迹）——冉浚枫的归类与进展抽取接入前的占位。

接口就一个：`assign(hub, store, space, episode, domains) -> Topic | None`，返回 None 表示这一段不整理
（PRD：所属领域不在本次 domains 里，或看不出说的是哪项工作）。换成正式模块时只换这个函数。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .prompts import TOPIC_ASSIGN
from .types import Episode, Space, Topic, now_iso


if TYPE_CHECKING:
    from .judge import ModelHub
    from .store import ProjectStore


MAX_TOPICS_IN_PROMPT = 30


def assign(
    hub: ModelHub, store: ProjectStore, space: Space, ep: Episode, domains: list[str], log
) -> Topic | None:
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
        return None

    names = [d.name for d in allowed]
    topic = next((t for t in topics if t.id == out.get("topic_id")), None)
    if topic is not None and topic.domain not in names:
        log(f"归主题：模型选的主题领域「{topic.domain}」不在本次范围，按新建处理")
        topic = None
    if topic is None:
        new = out.get("new_topic") or {}
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
        if out.get("summary"):
            topic.summary = str(out["summary"])[:80]
        if out.get("description"):
            topic.description = str(out["description"])[:400]
        log(f"归主题：并入「{topic.name}」")

    for item in out.get("timeline") or []:
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
