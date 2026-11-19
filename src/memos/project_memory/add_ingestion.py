"""Normalize and fingerprint trajectory input before its acceptance transaction."""

from __future__ import annotations

import hashlib
import json
import os
import re

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from memos.exceptions import MemOSError


_INJECTION_TAG = re.compile(
    r"<(memos_context|project_index)\b[^>]*>|</(memos_context|project_index)>", re.IGNORECASE
)
_TIMEZONE_OFFSET = re.compile(r"([+-])(\d{2}):(\d{2})")
_TASK_SWITCH = re.compile(
    r"^\s*(换个任务|换个话题|另一个任务|另外一件事|先放下这个|"
    r"new task\b|switch(?:ing)? (?:tasks|topics)\b|(?:a )?separate question\b)",
    re.IGNORECASE,
)
_TASK_END = re.compile(
    r"^\s*(结束|到此为止|先到这里|就到这里|任务结束|that's all|that's it|stop here)"
    r"[\s.!。！]*$",
    re.IGNORECASE,
)


class AddRequestError(MemOSError):
    """Stable request error consumed by the existing Add HTTP adapter."""

    def __init__(self, reason: str, detail: str, status_code: int = 422) -> None:
        super().__init__(detail)
        self.reason = reason
        self.status_code = status_code


def strip_injection(text: str) -> str:
    """Remove only closed, marked injection blocks, preserving adjacent original text."""
    stacks: dict[str, list[int]] = {}
    spans: list[tuple[int, int]] = []
    for match in _INJECTION_TAG.finditer(text):
        name = (match[1] or match[2]).lower()
        stack = stacks.setdefault(name, [])
        if match[1]:
            stack.append(match.start())
        elif stack:
            spans.append((stack.pop(), match.end()))
    pieces = []
    end = 0
    for start, stop in sorted(spans):
        if start >= end:
            pieces.append(text[end:start])
        end = max(end, stop)
    pieces.append(text[end:])
    return "".join(pieces)


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            part["text"]
            for part in value
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
        )
    return ""


def _timestamp(value: Any, now: datetime) -> datetime:
    if value is None or value == "":
        return now
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            offset = os.getenv("PROJECT_MEMORY_NAIVE_TZ", "+00:00").strip()
            match = _TIMEZONE_OFFSET.fullmatch(offset)
            if match is None or int(match[3]) >= 60:
                raise ValueError("invalid configured UTC offset")
            sign = -1 if match[1] == "-" else 1
            tz = timezone(sign * timedelta(hours=int(match[2]), minutes=int(match[3])))
            parsed = parsed.replace(tzinfo=tz)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError) as exc:
        raise AddRequestError("INVALID_PARAMS", "chat_time must be an ISO 8601 timestamp") from exc


def message_fingerprint(message: dict[str, Any], *, explicit_time: bool = True) -> str:
    content = {
        key: message.get(key)
        for key in (
            "role",
            "role_id",
            "role_name",
            "content",
            "tool_calls",
            "tool_call_id",
            "experience_notes",
        )
    }
    if explicit_time:
        content["chat_time"] = message["chat_time"].isoformat()
    return hashlib.sha256(
        json.dumps(content, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def _tool_calls(value: Any) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise AddRequestError("INVALID_PARAMS", "tool_calls must be a list")
    calls = []
    for call in value:
        function = call.get("function") if isinstance(call, dict) else None
        if (
            not isinstance(function, dict)
            or not isinstance(call.get("id"), str)
            or not call["id"]
            or call.get("type") != "function"
            or not isinstance(function.get("name"), str)
            or not function["name"]
            or not isinstance(function.get("arguments"), str)
        ):
            raise AddRequestError(
                "INVALID_PARAMS", "tool call requires id, name and string arguments"
            )
        calls.append(
            {**call, "function": {**function, "arguments": strip_injection(function["arguments"])}}
        )
    return calls


def normalize_turns(
    raw_messages: Any, task_id: str, user_id: str, member_map: dict[str, str], now: datetime
) -> list[list[dict[str, Any]]]:
    """Preserve submitted message ordering, grouping around user message boundaries."""
    if not isinstance(raw_messages, list):
        raise AddRequestError("INVALID_PARAMS", "messages must be a list")
    turns: list[list[dict[str, Any]]] = []
    message_ids: set[str] = set()
    for position, raw in enumerate(raw_messages):
        if not isinstance(raw, dict):
            raise AddRequestError("INVALID_PARAMS", "message must be an object")
        role = raw.get("role")
        if role == "system":
            continue
        if not isinstance(role, str) or role not in {"user", "assistant", "tool"}:
            raise AddRequestError("INVALID_PARAMS", "unsupported message role")
        message_id = (
            raw.get("message_id")
            or raw.get("id")
            or str(uuid5(NAMESPACE_URL, f"memos:project-add:{task_id}:{position}"))
        )
        if not isinstance(message_id, str) or not message_id.strip() or message_id in message_ids:
            raise AddRequestError(
                "MESSAGE_ID_CONFLICT", "message IDs must be unique in a request", 409
            )
        message_ids.add(message_id)
        role_id = raw.get("role_id") or (user_id if role == "user" else None)
        role_name = raw.get("role_name")
        mapped_id = member_map.get(role_id, role_id) if isinstance(role_id, str) else role_id
        message = {
            "message_id": message_id,
            "role": role,
            "role_id": mapped_id,
            "role_name": role_name,
            "content": _message_text(raw.get("content")),
            "tool_calls": raw.get("tool_calls"),
            "tool_call_id": raw.get("tool_call_id"),
            "experience_notes": raw.get("experience_notes"),
            "chat_time": _timestamp(raw.get("chat_time"), now),
        }
        if role == "tool" and not message["tool_call_id"]:
            raise AddRequestError("INVALID_PARAMS", "tool message requires tool_call_id")
        if not message["content"] and not message["tool_calls"] and not message["experience_notes"]:
            raise AddRequestError("INVALID_PARAMS", "message content cannot be empty")
        message["raw_sha256"] = message_fingerprint(
            message, explicit_time=bool(raw.get("chat_time"))
        )
        message["tool_calls"] = _tool_calls(message["tool_calls"])
        message["content"] = strip_injection(message["content"])
        message["content_sha256"] = message_fingerprint(
            message, explicit_time=bool(raw.get("chat_time"))
        )
        if role == "user" or not turns:
            turns.append([])
        turns[-1].append(message)
    if not turns:
        raise AddRequestError("INVALID_PARAMS", "messages must include project trajectory content")
    return turns


def task_boundary(turn: list[dict[str, Any]]) -> str | None:
    first = turn[0]
    if first["role"] == "user":
        if _TASK_SWITCH.match(first["content"]):
            return "switch"
        if _TASK_END.match(first["content"]):
            return "end"
    return None
