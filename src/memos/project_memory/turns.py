"""Prepare semantic Turn and Episode documents outside the Add write transaction."""

from collections.abc import Callable
from dataclasses import dataclass
from itertools import groupby

from .add_index import _vectors
from .judge import ModelError


@dataclass
class TurnSkeleton:
    turn_id: str
    msg_ids: list[str]
    content: str


def turn_skeletons(messages: list[dict]) -> list[TurnSkeleton]:
    turns = []
    for turn_id, members in groupby(messages, key=lambda m: m["turn_id"]):
        group = [m for m in members if m["role"] != "system"]
        if not group:
            continue
        user = next((m["content"] for m in group if m["role"] == "user"), "")
        reply = next(
            (m["content"] for m in reversed(group) if m["role"] == "assistant" and m["content"]), ""
        )
        names = dict.fromkeys(
            call["function"]["name"] for m in group for call in m.get("tool_calls") or []
        )
        content = "\n".join(filter(None, (user, ", ".join(names), reply)))
        if not content:
            continue
        ids = [m["message_id"] for m in group]
        turns.append(TurnSkeleton(turn_id, ids, content))
    return turns


def evidence_vectors(
    messages: list[dict], summary: str | None, embedder: Callable | None, dimension: int
) -> tuple[str | None, list[tuple]]:
    turns = turn_skeletons(messages)
    if embedder is None:
        return None, [(t.turn_id, t.msg_ids, t.content, None) for t in turns]
    texts = [turn.content for turn in turns]
    if summary:
        texts.append(summary)
    if not texts:
        return None, []
    try:
        vectors = _vectors(embedder, texts, dimension)
    except Exception as exc:
        raise ModelError("Project evidence embedding unavailable") from exc
    episode_vector = vectors.pop() if summary else None
    rows = [
        (turn.turn_id, turn.msg_ids, turn.content, vec)
        for turn, vec in zip(turns, vectors, strict=True)
    ]
    return episode_vector, rows
