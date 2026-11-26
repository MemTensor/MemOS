"""Recover historical Turn provenance from the legacy message and Task links.

Legacy Episodes become spec rows: each message once per conversation with a `msg_seq`
assigned Episode by Episode in acceptance order (so an Episode's new messages are
contiguous), each Episode a msg_seq range of its Space and conversation, and its `add_jobs`
row with the Tasks that sent its messages (`task_ids`, `organize_result.task_ranges` /
`task_owners`) and its outcome.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from .add_ingestion import message_fingerprint
from .types import PROJECT_EPISODE, PROJECT_MESSAGE, PROJECT_TASK


if TYPE_CHECKING:
    from .add_acceptance import AcceptanceSettings


def recorded_time(*values: str | None) -> datetime:
    for value in values:
        if value:
            try:
                date = datetime.fromisoformat(value)
            except ValueError:
                continue
            if date.tzinfo is not None:
                return date.astimezone(timezone.utc)
    raise ValueError("original timestamp with an explicit time zone is unavailable")


def _turns(message_nodes: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    for node in message_nodes:
        if not groups or node["metadata"].get("role") in ("member", "user"):
            groups.append([])
        groups[-1].append(node)
    return groups


def _first(value: Any) -> str | None:
    if isinstance(value, list):
        value = next((item for item in value if isinstance(item, str) and item), None)
    return value if isinstance(value, str) and value else None


def _message(node: dict[str, Any], episode: dict[str, Any], owner: dict[str, Any]) -> dict:
    meta = node["metadata"]
    message_id = meta.get("message_id")
    role = {"member": "user", "agent": "assistant"}.get(meta.get("role"), meta.get("role"))
    if not message_id or role not in ("user", "assistant", "tool", "system"):
        raise ValueError("source message identity or role is missing")
    # Legacy persisted some tool calls and output in one record. Preserve its known arguments.
    tool_calls = None
    if meta.get("tool_name"):
        tool_calls = [
            {
                "id": meta.get("tool_call_id"),
                "type": "function",
                "function": {"name": meta["tool_name"], "arguments": meta.get("tool_args") or ""},
            }
        ]
    message = {
        "project_id": episode["project_id"],
        "conversation_key": episode["conversation_key"],
        "message_id": message_id,
        "role": role,
        "role_id": meta.get("role_id") or None,
        "role_name": meta.get("role_name") or None,
        "agent_id": _first(meta.get("agent_id")),
        "content": node["memory"],
        "tool_calls": tool_calls,
        "tool_call_id": meta.get("tool_call_id") or None,
        "experience_notes": meta.get("experience_notes") or None,
        "chat_time": recorded_time(meta.get("chat_time")),
        "accept_time": recorded_time(owner.get("create_time"), owner.get("created_at")),
        "task_id": owner["task_id"],
    }
    message["content_sha256"] = message_fingerprint(message)
    return message


def _episode_rows(
    node: dict[str, Any],
    nodes: dict[str, Any],
    message_owners: dict[str, list[dict[str, Any]]],
    space: dict[str, Any],
    topics: dict[str, dict[str, Any]],
    project_id: str,
    settings: AcceptanceSettings,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """The Episode (with its add_jobs fields), its messages in order, and their owners."""
    meta = node["metadata"]
    legacy_state = meta.get("episode_state")
    if legacy_state not in ("open", "closed") or (meta.get("epoch") or 0) < space["legacy_epoch"]:
        raise ValueError("older or partially processed Episode retained in archive")
    if not meta.get("message_ids"):
        raise ValueError("Episode source links are unavailable")
    ids = meta["message_ids"]
    if len(ids) != len(set(ids)):
        raise ValueError("Episode repeats a legacy source node")
    space_id = space["id"]
    conversation = meta.get("conversation_id") or None
    raw = [nodes.get(node_id) for node_id in ids]
    if any(
        not item
        or item["metadata"].get("memory_type") != PROJECT_MESSAGE
        or item["metadata"].get("user_name") != space_id
        or (item["metadata"].get("conversation_id") or None) != conversation
        for item in raw
    ):
        raise ValueError("Episode has missing or out-of-scope source links")
    if any(len(message_owners[node_id]) != 1 for node_id in ids):
        raise ValueError("Episode message does not identify a unique legacy Task")
    owners = {node_id: message_owners[node_id][0] for node_id in ids}
    if any(
        not owner.get("user_id") or space_id not in owner["space_ids"] for owner in owners.values()
    ):
        raise ValueError("Episode source Task has no provable owner in this Space")
    if not conversation and len({owner["task_id"] for owner in owners.values()}) != 1:
        raise ValueError("no-conversation Episode spans multiple legacy Tasks")
    episode = {
        "id": node["id"],
        "project_id": project_id,
        "space_id": space_id,
        "conversation_id": conversation,
        "conversation_key": conversation or f"task:{owners[ids[0]]['task_id']}",
        "user_id": owners[ids[0]]["user_id"],
        "domains": meta.get("domains") or list(space["domain_names"]),
        "previous_episode_id": None,
    }
    if set(episode["domains"]) - set(space["domain_names"]):
        raise ValueError("Episode references an unavailable domain")
    messages, message_owner = [], []
    for group in _turns(raw):
        owner = owners[group[0]["id"]]
        if any(owners[source["id"]]["task_id"] != owner["task_id"] for source in group):
            raise ValueError("Turn sources span more than one legacy Task")
        for record in group:
            messages.append(_message(record, episode, owner))
            message_owner.append(owner)
    opened = min(message["accept_time"] for message in messages)
    last_received = max(message["accept_time"] for message in messages)
    topic = topics.get(meta.get("topic_id"))
    if topic is not None and topic["space_id"] != space_id:
        raise ValueError("Episode receipt is associated with another Space")
    if legacy_state == "open" and topic is not None:
        raise ValueError("open legacy Episode already has a Topic receipt")
    closed = (
        max(last_received, recorded_time(meta.get("updated_at"), meta.get("create_time")))
        if legacy_state == "closed"
        else None
    )
    episode.update(
        open=closed is None,
        accept_time=opened,
        closed_at=closed,
        first_chat_time=min(message["chat_time"] for message in messages),
        last_chat_time=max(message["chat_time"] for message in messages),
        close_due_time=None
        if closed
        else min(
            last_received + timedelta(seconds=settings.idle_seconds),
            opened + timedelta(seconds=settings.wait_seconds),
        ),
        outcome="pending" if closed is None else ("committed" if topic else "skipped"),
        topic_id=topic["id"] if topic else None,
    )
    return episode, messages, message_owner


def rebuild_legacy_trajectories(
    nodes: dict[str, Any],
    spaces: dict[str, dict[str, Any]],
    topics: dict[str, dict[str, Any]],
    project_id: str,
    settings: AcceptanceSettings,
    exceptions: list[dict[str, str]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """(episodes rows, messages rows, add_jobs rows) of the legacy Episodes that can be proven;
    the rest are reported in `exceptions` and stay in the archive."""
    message_owners: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in nodes.values():
        meta = node["metadata"]
        if meta.get("memory_type") == PROJECT_TASK and meta.get("task_id"):
            for node_id in set(meta.get("message_ids") or []):
                message_owners[node_id].append(meta)
    candidates = []
    for node in nodes.values():
        meta = node["metadata"]
        if meta.get("memory_type") != PROJECT_EPISODE or meta.get("user_name") not in spaces:
            continue
        try:
            candidates.append(
                _episode_rows(
                    node,
                    nodes,
                    message_owners,
                    spaces[meta["user_name"]],
                    topics,
                    project_id,
                    settings,
                )
            )
        except ValueError as error:
            exceptions.append({"id": node["id"], "kind": "episode", "reason": str(error)})
    candidates.sort(key=lambda row: (row[0]["accept_time"], row[0]["id"]))

    messages: dict[tuple[str, str], dict[str, Any]] = {}
    next_seq: dict[str, int] = defaultdict(int)
    ranges: dict[tuple[str, str], list[tuple[int, int]]] = defaultdict(list)
    open_conversations: set[tuple[str, str]] = set()
    previous: dict[tuple[str, str], str] = {}
    episodes, jobs = [], []
    for episode, batch, owners in candidates:
        scope = (episode["space_id"], episode["conversation_key"])
        try:
            if episode["open"] and scope in open_conversations:
                raise ValueError("more than one open legacy Episode exists for this conversation")
            keys = [(message["conversation_key"], message["message_id"]) for message in batch]
            if len(set(keys)) != len(keys):
                raise ValueError("legacy Turn has multiple assignments in the same Space")
            for key, message in zip(keys, batch, strict=True):
                stored = messages.get(key)
                if stored and stored["content_sha256"] != message["content_sha256"]:
                    raise ValueError("legacy message ID conflicts with another representation")
            # Messages new to the conversation take the next seqs, in the Episode's order.
            seqs, assigned = [], next_seq[episode["conversation_key"]]
            for key in keys:
                if key in messages:
                    seqs.append(messages[key]["msg_seq"])
                else:
                    assigned += 1
                    seqs.append(assigned)
            start, end = min(seqs), max(seqs)
            if any(lo <= end and start <= hi for lo, hi in ranges[scope]):
                raise ValueError("legacy Turn has multiple assignments in the same Space")
        except ValueError as error:
            exceptions.append({"id": episode["id"], "kind": "episode", "reason": str(error)})
            continue
        next_seq[episode["conversation_key"]] = assigned
        for key, message, seq in zip(keys, batch, seqs, strict=True):
            messages.setdefault(key, {**message, "msg_seq": seq})
        ranges[scope].append((start, end))
        if episode["open"]:
            open_conversations.add(scope)
        task_ranges: dict[str, list[int]] = {}
        task_owners: dict[str, dict] = {}
        for seq, owner in zip(seqs, owners, strict=True):
            lo, hi = task_ranges.get(owner["task_id"], [seq, seq])
            task_ranges[owner["task_id"]] = [min(lo, seq), max(hi, seq)]
            task_owners[owner["task_id"]] = {
                "user_id": owner["user_id"],
                "accepted_at": recorded_time(
                    owner.get("create_time"), owner.get("created_at")
                ).isoformat(),
            }
        prior = previous.get(scope) if episode["conversation_id"] else None
        if not episode["open"]:
            previous[scope] = episode["id"]
        episodes.append(
            {
                "id": episode["id"],
                "space_id": episode["space_id"],
                "conversation_key": episode["conversation_key"],
                "message_seq_start": start,
                "message_seq_end": end,
                "previous_episode_id": prior,
                "topic_id": episode["topic_id"],
                "first_chat_time": episode["first_chat_time"],
                "last_chat_time": episode["last_chat_time"],
                "create_time": episode["accept_time"],
            }
        )
        organize = {"task_ranges": task_ranges, "task_owners": task_owners}
        if episode["closed_at"]:
            organize["close"] = {"reason": "legacy", "at": episode["closed_at"].isoformat()}
            organize["extraction"] = {"at": episode["closed_at"].isoformat(), "status": "legacy"}
        jobs.append(
            {
                "episode_id": episode["id"],
                "project_id": episode["project_id"],
                "space_id": episode["space_id"],
                "conversation_key": episode["conversation_key"],
                "user_id": episode["user_id"],
                "task_ids": list(task_ranges),
                "domains": episode["domains"],
                "stage": "episode_open" if episode["open"] else "done",
                "outcome": episode["outcome"],
                "accept_time": episode["accept_time"],
                "close_due_time": episode["close_due_time"],
                "organize_result": organize,
                "topic_ids": [episode["topic_id"]] if episode["topic_id"] else [],
            }
        )
    ordered = sorted(messages.values(), key=lambda m: (m["conversation_key"], m["msg_seq"]))
    return episodes, ordered, jobs
