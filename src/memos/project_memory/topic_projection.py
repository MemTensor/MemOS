"""Project committed topic and entry rows into the public read format."""

from datetime import datetime
from typing import Any

from .add_entry_fields import experience_retired, experience_status
from .index import Topic
from .types import time_key


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "")


def _statement(item: dict, *keys: str) -> dict:
    data = {
        "content": item.get("content") or "",
        "time": _iso(item.get("time")),
        "user_ids": list(item.get("user_ids") or []),
    }
    data.update({key: item[key] for key in keys if item.get(key) is not None})
    return data


def _decision_order(item: dict) -> tuple:
    """Decisions with open conflicts first, then more members, then the newest."""
    return (
        not item.get("conflicts"),
        -len(item.get("user_ids") or []),
        -time_key(item.get("time")),
    )


def _experience_order(item: dict) -> tuple:
    """Verified experiences first, then higher confidence, then the newest."""
    return (
        experience_status(item) != "verified",
        -float(item.get("confidence") or 0),
        -time_key(item.get("time")),
    )


def topic_snapshot(row: dict) -> Topic:
    """The public Topic view of one committed Topic (an add_layout Topic dict); entries are
    in Topic-page order and `rank_time` is the storage ranking key."""
    from .add_index import topic_item_content

    decisions = [
        {
            "id": item["id"],
            **_statement(item, "source"),
            "user_labels": item.get("user_labels") or {},
            "history": [
                _statement(h, "reason", "source", "change_source")
                for h in item.get("history") or []
            ],
            "conflicts": [_statement(c, "source") for c in item.get("conflicts") or []],
        }
        for item in sorted(row["decisions"] or [], key=_decision_order)
    ]
    experiences = []
    for item in sorted(row["experiences"] or [], key=_experience_order):
        if experience_retired(item):
            continue
        card = item.get("card") or {}
        experiences.append(
            {
                "id": item["id"],
                "content": topic_item_content("experience", item) or item.get("content") or "",
                "time": _iso(item.get("time")),
                "user_ids": list(item.get("user_ids") or []),
                "task_intent": card.get("task_intent"),
                "exp_status": experience_status(item),
                "confidence": item.get("confidence"),
                "card": card,
                "version": item.get("version"),
                "sources": item.get("sources") or [],
            }
        )
    timeline = [
        {"id": item["id"], **_statement(item)}
        for item in sorted(row["timeline"] or [], key=lambda item: time_key(item.get("time")))
        if item.get("id")
    ]
    return Topic.model_validate(
        {
            "id": row["id"],
            "domain": row["domain"],
            "topic_name": row["topic_name"],
            "topic_summary": row["topic_summary"] or "",
            "topic_description": row["topic_description"] or "",
            "create_time": _iso(row["create_time"]),
            "update_time": _iso(row["update_time"]),
            "rank_time": row.get("rank_time"),
            "sources": row["sources"] or [],
            "decisions": decisions,
            "experiences": experiences,
            "timeline": timeline,
        }
    )
