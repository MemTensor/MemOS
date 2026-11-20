"""Read the writer's original messages, preserving roles and tool arguments."""

import json

from collections.abc import Iterable
from typing import Protocol

from memos.project_memory.views import time_key


class MessageStore(Protocol):
    def list_messages(self, space_id: str, conversation_id: str) -> Iterable: ...


def read_messages(
    store: MessageStore, spaces: list[str], conversation: str, limit: int | None
) -> list[dict]:
    seen = set()
    messages = []
    for space in spaces:
        for source in store.list_messages(space, conversation):
            if isinstance(source, dict):
                msg = {
                    k: source[k]
                    for k in (
                        "message_id",
                        "role",
                        "content",
                        "chat_time",
                        "role_id",
                        "role_name",
                        "tool_name",
                        "tool_args",
                    )
                    if k in source
                }
            else:
                msg = {
                    "message_id": source.id,
                    "role": source.role,
                    "content": source.text,
                    "chat_time": source.chat_time,
                    "role_id": source.user_id,
                    "role_name": source.name,
                }
                if source.role == "tool":
                    msg.update(tool_name=source.tool_name, tool_args=source.tool_args)
            msg["role"] = {"member": "user", "agent": "assistant"}.get(msg["role"], msg["role"])
            key = (
                msg["role"],
                time_key(msg),
                msg["content"],
                json.dumps(msg.get("tool_args"), sort_keys=True, ensure_ascii=False),
            )
            if key not in seen:
                seen.add(key)
                messages.append(msg)
    messages.sort(key=time_key)
    return messages[-limit:] if limit else messages
