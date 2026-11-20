"""Public search and detail projections of a writer's committed topic snapshot."""

import os

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


ENTRY_FIELDS = {"decision": "decisions", "experience": "experiences", "timeline": "timeline"}
ITEM_TYPES = ("topic", *ENTRY_FIELDS)


def budget(seconds: float) -> float:
    """Scale a retrieval time budget. MEMOS_PROJECT_RETRIEVAL_TIME_SCALE defaults to 1 (production
    budgets); a remote database or embedding service in tests and evaluations may need more."""
    return seconds * float(os.getenv("MEMOS_PROJECT_RETRIEVAL_TIME_SCALE") or 1)


def default_timezone() -> ZoneInfo:
    return ZoneInfo(os.getenv("PROJECT_MEMORY_NAIVE_TZ", "Asia/Shanghai"))


def timestamp(value: str) -> datetime:
    when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return when if when.tzinfo else when.replace(tzinfo=default_timezone())


def time_key(row: dict) -> tuple:
    value = row.get("time") or row.get("chat_time") or ""
    try:
        return 1, timestamp(value)
    except ValueError:
        return 0, value


def experience_content(content: str, card: dict | None) -> str:
    parts = ("task_intent", "problem", "principle")
    if card and all(card.get(k) for k in parts):
        content = "｜".join(card[k] for k in parts)
    return content[:200]


def entry_view(kind: str, payload: dict, full: bool) -> dict:
    common = ("id", "content", "time", "user_ids")
    data = {k: payload[k] for k in common if k in payload}
    if kind == "decision":
        for k in ("user_labels", "source") if full else ("user_labels",):
            if k in payload:
                data[k] = payload[k]
        for key in ("history", "conflicts"):
            versions = payload.get(key, [])
            if versions:
                fields = {"content", "time", "user_ids"}
                if full:
                    fields.add("source")
                if key == "history":
                    fields.add("reason")
                    if full:
                        fields.add("change_source")
                data[key] = [
                    {k: v for k, v in version.items() if k in fields}
                    for version in sorted(versions, key=time_key)
                ]
    elif kind == "experience":
        data.update(
            {
                k: payload[k]
                for k in (
                    "task_intent",
                    "lifecycle",
                    "exp_status",
                    "confidence",
                    "card",
                    "version",
                    "sources",
                )
                if k in payload
            }
        )
        data["content"] = experience_content(data["content"], data.get("card"))
        evidence = [
            s
            for s in data.get("sources", [])
            if s.get("signal") not in (None, "", "none") and s.get("chat_time")
        ]
        if "exp_status" in data or data.get("lifecycle") in {"active", "stale"}:
            last_support = max((time_key(row) for row in evidence), default=(0, ""))
            stale = last_support[0] and last_support[1] < datetime.now(timezone.utc) - timedelta(
                days=90
            )
            data["lifecycle"] = "stale" if stale else "active"
        if not full:
            for field in ("card", "sources", "version"):
                data.pop(field, None)
    return data


def component(kind: str, payload: dict, header: dict, space: str, full: bool) -> dict:
    if kind == "topic":
        members = {u for source in header.get("sources", []) for u in source.get("user_id", [])}
        data = {
            "id": header["id"],
            "content": header["topic_summary"],
            "time": header["update_time"],
            "topic_description": header["topic_description"],
            "user_ids": sorted(members),
        }
        if full:
            data.update(sources=header["sources"], create_time=header["create_time"])
    else:
        data = entry_view(kind, payload, full)
    return {
        **data,
        "topic_id": header["id"],
        "space_id": space,
        "domain": header["domain"],
        "topic_name": header["topic_name"],
    }


def topic_detail(header: dict, space: str, entries: list[tuple], full: bool) -> dict:
    data = {k: v for k, v in header.items() if full or k not in ("sources", "create_time")}
    data.update(space_id=space)
    for kind, field in ENTRY_FIELDS.items():
        values = [entry_view(k, v, full) for k, v in entries if k == kind]
        data[field] = sorted(values, key=time_key) if kind == "timeline" else values
    return data
