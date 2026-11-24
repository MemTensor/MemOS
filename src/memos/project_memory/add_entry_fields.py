"""Read an experience entry as the Add write-table document defines it (topics.experiences[]).

The document stores `exp_status` and derives the rest: an experience is retired when its
confidence falls below the floor, its author is the first of `user_ids`, and its conversation
is the one recorded on its evidence (`sources[].conversation_id`). Rows written before this
module kept `status`, `archived`, `user_id` and `session_id`; they are still read here, so
stored Topics need no migration.
"""

from __future__ import annotations

from typing import Any

from .experience import CONF_MIN
from .types import EXP_CANDIDATE


# Experience history items keep only these keys (ExperienceCardVersion in the shared schema).
EXPERIENCE_VERSION_FIELDS = ("version", "card", "time", "commit_key")


def experience_status(item: dict[str, Any]) -> str:
    return item.get("exp_status") or item.get("status") or EXP_CANDIDATE


def experience_retired(item: dict[str, Any]) -> bool:
    if item.get("archived"):
        return True
    confidence = item.get("confidence")
    return confidence is not None and float(confidence) < CONF_MIN


def experience_user_id(item: dict[str, Any]) -> str:
    users = item.get("user_ids") or []
    return item.get("user_id") or (users[0] if users else "")


def experience_conversation_id(item: dict[str, Any]) -> str:
    if item.get("session_id"):
        return item["session_id"]
    for source in item.get("sources") or []:
        if isinstance(source, dict) and source.get("conversation_id"):
            return source["conversation_id"]
    return ""


def experience_version(entry: dict[str, Any], **override: Any) -> dict[str, Any]:
    """One history item in the document's shape: the earlier card and when it held."""
    item = {
        "version": entry.get("version"),
        "card": entry.get("card") or {},
        "time": entry.get("time") or entry.get("created_at"),
        "commit_key": entry.get("commit_key"),
        **override,
    }
    return {key: item[key] for key in EXPERIENCE_VERSION_FIELDS if item.get(key) is not None}
