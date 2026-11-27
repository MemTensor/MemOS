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


def _project_messages(raw_messages):
    """A tool result owns its invocation. Preserve the caller's result ID and input order."""
    pending = {}
    matched = set()
    inputs = {}
    for pos, msg in enumerate(raw_messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "user":
            pending.clear()
        elif msg.get("role") == "assistant" and msg.get("tool_calls"):
            _tool_calls(msg["tool_calls"])
            for call in msg["tool_calls"]:
                pending[call["id"]] = (pos, call)
        elif (
            msg.get("role") == "tool"
            and isinstance(cid := msg.get("tool_call_id"), str)
            and cid in pending
        ):
            owner, inputs[pos] = pending.pop(cid)
            matched.add((owner, cid))

    for position, raw in enumerate(raw_messages):
        if isinstance(raw, dict) and raw.get("role") == "assistant" and raw.get("tool_calls"):
            if raw.get("content") or raw.get("experience_notes"):
                yield position, {**raw, "tool_calls": None}
            for index, call in enumerate(raw["tool_calls"]):
                if (position, call["id"]) in matched:
                    continue
                # Calls without an output still constitute a tool message with empty content.
                single = (
                    len(raw["tool_calls"]) == 1
                    and not raw.get("content")
                    and not raw.get("experience_notes")
                )
                yield (
                    f"{position}:tool:{index}",
                    {
                        **raw,
                        "role": "tool",
                        "id": None,
                        "message_id": (raw.get("message_id") or raw.get("id")) if single else None,
                        "content": "",
                        "tool_calls": [call],
                        "tool_call_id": call["id"],
                    },
                )
            continue
        elif isinstance(raw, dict) and raw.get("role") == "tool":
            cid = raw.get("tool_call_id")
            if position in inputs and not raw.get("tool_calls"):
                raw = {**raw, "tool_calls": [inputs[position]]}
            if not raw.get("tool_calls"):
                raise AddRequestError(
                    "INVALID_PARAMS", "tool message requires the invocation name and arguments"
                )
            own = _tool_calls(raw["tool_calls"])
            if len(own) != 1 or own[0]["id"] != cid:
                raise AddRequestError(
                    "INVALID_PARAMS", "tool message must contain its own single invocation"
                )
        yield position, raw


def normalize_turns(
    raw_messages: Any, task_id: str, user_id: str, member_map: dict[str, str], now: datetime
) -> list[list[dict[str, Any]]]:
    """Preserve submitted message ordering, grouping around user message boundaries."""
    if not isinstance(raw_messages, list):
        raise AddRequestError("INVALID_PARAMS", "messages must be a list")
    turns: list[list[dict[str, Any]]] = []
    leading_system: list[dict[str, Any]] = []
    message_ids: set[str] = set()
    for position, raw in _project_messages(raw_messages):
        if not isinstance(raw, dict):
            raise AddRequestError("INVALID_PARAMS", "message must be an object")
        role = raw.get("role")
        if not isinstance(role, str) or role not in {"user", "assistant", "tool", "system"}:
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
        if role == "system" and not turns:
            leading_system.append(message)
            continue
        if not turns:
            turns.append(leading_system)
        elif role == "user":
            turns.append([])
        turns[-1].append(message)
    if not turns:
        raise AddRequestError("INVALID_PARAMS", "messages must include project trajectory content")
    return turns


def turn_source(turn: list[dict[str, Any]]) -> dict[str, Any]:
    """Ignore raw system context when determining the Turn identity and boundary."""
    return next(message for message in turn if message["role"] != "system")
