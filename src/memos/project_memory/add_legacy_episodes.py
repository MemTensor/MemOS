"""Recover historical Turn provenance from the legacy message and Task links."""

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


def _message(
    node: dict[str, Any],
    episode: dict[str, Any],
    turn_id: str,
    owner: dict[str, Any],
    seq: int,
) -> dict[str, Any]:
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
        "conversation_id": episode["conversation_id"],
        "message_id": message_id,
        "turn_id": turn_id,
        "msg_seq": seq,
        "role": role,
        "role_id": meta.get("role_id") or None,
        "role_name": meta.get("role_name") or None,
        "content": node["memory"],
        "tool_calls": tool_calls,
        "tool_call_id": meta.get("tool_call_id") or None,
        "experience_notes": meta.get("experience_notes") or None,
        "chat_time": recorded_time(meta.get("chat_time")),
        "accepted_at": recorded_time(owner.get("create_time"), owner.get("created_at")),
        "task_id": owner["task_id"],
        "user_id": owner["user_id"],
        "agent_id": meta.get("agent_id"),
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
    messages = []
    turn_rows = []
    for seq, group in enumerate(_turns(raw), 1):
        owner = owners[group[0]["id"]]
        if any(owners[source["id"]]["task_id"] != owner["task_id"] for source in group):
            raise ValueError("Turn sources span more than one legacy Task")
        turn_id = group[0]["metadata"].get("message_id")
        turn = [_message(record, episode, turn_id, owner, j) for j, record in enumerate(group, 1)]
        first = turn[0]
        messages.extend(turn)
        turn_rows.append(
            {
                **{key: episode[key] for key in ("project_id", "space_id", "conversation_key")},
                **{
                    key: first[key]
                    for key in (
                        "turn_id",
                        "task_id",
                        "user_id",
                        "chat_time",
                        "accepted_at",
                        "agent_id",
                    )
                },
                "episode_id": episode["id"],
                "turn_seq": seq,
                "message_count": len(turn),
            }
        )
    opened = min(message["accepted_at"] for message in messages)
    last_received = max(message["accepted_at"] for message in messages)
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
        state="open" if closed is None else "extracted",
        stage="episode_open" if closed is None else "done",
        outcome="pending" if closed is None else ("committed" if topic else "skipped"),
        opened_at=opened,
        last_turn_at=max(message["chat_time"] for message in messages),
        closed_at=closed,
        idle_due_at=last_received + timedelta(seconds=settings.idle_seconds),
        max_wait_due_at=opened + timedelta(seconds=settings.wait_seconds),
        result={"topic_ids": [topic["id"]]} if topic else None,
    )
    return episode, messages, turn_rows


def rebuild_legacy_trajectories(
    nodes: dict[str, Any],
    spaces: dict[str, dict[str, Any]],
    topics: dict[str, dict[str, Any]],
    project_id: str,
    settings: AcceptanceSettings,
    exceptions: list[dict[str, str]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    message_owners: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in nodes.values():
        meta = node["metadata"]
        if meta.get("memory_type") == PROJECT_TASK and meta.get("task_id"):
            for node_id in set(meta.get("message_ids") or []):
                message_owners[node_id].append(meta)
    episodes = []
    messages: dict[tuple[str, str], dict[str, Any]] = {}
    turn_rows: dict[tuple[str, str, str], dict[str, Any]] = {}
    open_conversations: set[tuple[str, str]] = set()
    for node in nodes.values():
        meta = node["metadata"]
        if meta.get("memory_type") != PROJECT_EPISODE or meta.get("user_name") not in spaces:
            continue
        try:
            episode, batch, turns = _episode_rows(
                node, nodes, message_owners, spaces[meta["user_name"]], topics, project_id, settings
            )
            scope = (episode["space_id"], episode["conversation_key"])
            if episode["state"] == "open" and scope in open_conversations:
                raise ValueError("more than one open legacy Episode exists for this conversation")
            source_keys = [
                (message["conversation_key"], message["message_id"]) for message in batch
            ]
            for key, message in zip(source_keys, batch, strict=True):
                stored = messages.get(key)
                if stored and any(
                    stored[k] != message[k] for k in ("turn_id", "msg_seq", "content_sha256")
                ):
                    raise ValueError("legacy message ID conflicts with another representation")
            membership_keys = [
                (turn["space_id"], turn["conversation_key"], turn["turn_id"]) for turn in turns
            ]
            if (
                len(set(membership_keys)) != len(membership_keys)
                or len(set(source_keys)) != len(source_keys)
                or any(key in turn_rows for key in membership_keys)
            ):
                raise ValueError("legacy Turn has multiple assignments in the same Space")
        except ValueError as error:
            exceptions.append({"id": node["id"], "kind": "episode", "reason": str(error)})
            continue
        episodes.append(episode)
        if episode["state"] == "open":
            open_conversations.add(scope)
        turn_rows.update(zip(membership_keys, turns, strict=True))
        for key, message in zip(source_keys, batch, strict=True):
            existing = messages.get(key)
            if not existing or message["accepted_at"] < existing["accepted_at"]:
                messages[key] = message

    previous: dict[tuple[str, str], str] = {}
    episodes.sort(key=lambda episode: (episode["opened_at"], episode["id"]))
    for episode in episodes:
        scope = (episode["space_id"], episode["conversation_key"])
        if episode["conversation_id"]:
            episode["previous_episode_id"] = previous.get(scope)
        if episode["closed_at"]:
            previous[scope] = episode["id"]
    sequences: dict[tuple[str, str], int] = {}
    conversation_counts: dict[str, int] = defaultdict(int)
    ordered_messages = sorted(
        messages.values(),
        key=lambda msg: (msg["accepted_at"], msg["chat_time"], msg["msg_seq"], msg["message_id"]),
    )
    for message in ordered_messages:
        key = (message["conversation_key"], message["turn_id"])
        if key not in sequences:
            conversation_counts[key[0]] += 1
            sequences[key] = conversation_counts[key[0]]
        message["turn_seq"] = sequences[key]
    return episodes, ordered_messages, list(turn_rows.values())
