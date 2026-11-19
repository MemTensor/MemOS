"""Transaction hooks for the topic writer, approved turn publisher and embedding worker."""

import json
import math
import re

from collections.abc import Iterator
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from memos.project_memory.views import ENTRY_FIELDS, experience_content


TOKEN = re.compile(r"[\u3400-\u9fff]+|[^\W_]+(?:_[^\W_]+)*", re.UNICODE)


def terms(text: str, *, index_single_characters: bool = False) -> Iterator[str]:
    # PostgreSQL's simple dictionary treats an entire unspaced Chinese phrase as one word.
    for match in TOKEN.finditer(re.sub(r"([\u3400-\u9fff]+)", r" \1 ", text.casefold())):
        word = match.group()
        if "\u3400" <= word[0] <= "\u9fff" and len(word) > 1:
            if index_single_characters:
                yield from word
            yield from (word[i : i + 2] for i in range(len(word) - 1))
        else:
            yield word[:128]


def split_turn(text: str) -> Iterator[str]:
    start = 0
    while len(text) - start > 2000:
        end = text.rfind("\n", start, start + 2000) + 1 or start + 2000
        yield text[start:end]
        start = end
    if start < len(text):
        yield text[start:]


class Statement(BaseModel):
    content: str
    time: str
    user_ids: list[str]
    reason: str | None = None
    source: dict | None = None
    change_source: dict | None = None


class Entry(Statement):
    id: str = Field(min_length=1)


class Experience(Entry):
    task_intent: str | None = None
    exp_status: str | None = None
    confidence: float | None = None
    lifecycle: str | None = None
    card: dict | None = None
    version: int | None = None
    sources: list[dict] = Field(default_factory=list)


class Decision(Entry):
    user_labels: dict[str, str] = Field(default_factory=dict)
    history: list[Statement] = Field(default_factory=list)
    conflicts: list[Statement] = Field(default_factory=list)


class Topic(BaseModel):
    id: str = Field(min_length=1)
    domain: str
    topic_name: str
    topic_summary: str
    topic_description: str
    create_time: str
    update_time: str
    sources: list[dict] = Field(default_factory=list)
    decisions: list[Decision] = Field(default_factory=list)
    experiences: list[Experience] = Field(default_factory=list)
    timeline: list[Entry] = Field(default_factory=list)


class Turn(BaseModel):
    """Only the currently approved, sanitized excerpt from the source task."""

    id: str = Field(min_length=1)
    turn_id: str
    source_task_id: str | None = None
    conversation_id: str
    message_ids: list[str]
    user_id: str
    agent_id: str | None = None
    chat_time: str
    content: str
    topic_ids: list[str] = Field(default_factory=list)
    domains: list[str] = Field(default_factory=list)
    cache_policy: Literal["live", "immutable"] = "live"


class Vector(BaseModel):
    model: str = Field(min_length=1)
    values: list[float] = Field(min_length=1)

    def sql_value(self) -> str:
        if not all(math.isfinite(x) for x in self.values) or not any(self.values):
            raise ValueError("Embedding must be finite with a non-zero norm")
        return json.dumps(self.values, allow_nan=False)


def _documents(snapshot: Topic | Turn) -> Iterator[tuple]:
    if isinstance(snapshot, Turn):
        meta = snapshot.model_dump(exclude={"content", "domains"}, exclude_none=True)
        for part, chunk in enumerate(split_turn(snapshot.content)):
            yield (
                snapshot.id,
                "trajectory",
                part,
                snapshot.domains,
                [snapshot.conversation_id],
                {**meta, "content": chunk},
                chunk,
            )
        return
    meta = snapshot.model_dump(exclude=set(ENTRY_FIELDS.values()))
    conversations = [s["conversation_id"] for s in snapshot.sources if s.get("conversation_id")]
    yield (
        snapshot.id,
        "topic",
        0,
        [snapshot.domain],
        conversations,
        meta,
        " ".join((snapshot.topic_name, snapshot.topic_summary, snapshot.topic_description)),
    )
    for kind, field in ENTRY_FIELDS.items():
        for order, entry in enumerate(getattr(snapshot, field)):
            parts = [entry.content]
            if isinstance(entry, Experience):
                parts = [experience_content(entry.content, entry.card), entry.task_intent or ""]
            if isinstance(entry, Decision):
                for statement in [*entry.history, *entry.conflicts]:
                    parts.extend((statement.content, statement.reason or ""))
            yield (
                entry.id,
                kind,
                order,
                [snapshot.domain],
                conversations,
                entry.model_dump(exclude_none=True),
                " ".join(parts),
            )


def replace_snapshot(
    cursor: Any,
    tenant_id: str,
    space_id: str,
    root_id: str,
    revision: int,
    accepted_at: datetime,
    snapshot: Topic | Turn | None,
) -> bool:
    """Join the producer's transaction. None retracts the root; stale retries cannot revive it."""
    if snapshot is not None and root_id != snapshot.id:
        raise ValueError("Snapshot ID differs from root ID")
    if accepted_at.tzinfo is None:
        raise ValueError("accepted_at must include a timezone")
    cursor.execute(
        """
        INSERT INTO memos_project.pm_retrieval_roots AS r
            (tenant_id,space_id,root_id,revision,accepted_at,immutable)
        SELECT %s,%s,%s,%s,%s,%s FROM memos_project.pm_spaces
        WHERE tenant_id=%s AND space_id=%s AND deleted_at IS NULL
          AND (cleared_at IS NULL OR cleared_at < %s)
        ON CONFLICT (tenant_id,space_id,root_id) DO UPDATE
          SET revision=excluded.revision,accepted_at=excluded.accepted_at,immutable=false
          WHERE r.revision < excluded.revision
        RETURNING immutable
    """,
        (
            tenant_id,
            space_id,
            root_id,
            revision,
            accepted_at,
            isinstance(snapshot, Turn) and snapshot.cache_policy == "immutable",
            tenant_id,
            space_id,
            accepted_at,
        ),
    )
    published = cursor.fetchone()
    if published is None:
        return False
    scope = (tenant_id, space_id, root_id)
    cursor.execute(
        """DELETE FROM memos_project.pm_retrieval_items
                   WHERE tenant_id=%s AND space_id=%s AND root_id=%s""",
        scope,
    )
    if snapshot:
        seen = set()
        rows = []
        for id_, kind, part, domains, sessions, payload, text in _documents(snapshot):
            if kind != "trajectory" and id_ in seen:
                raise ValueError("Duplicate memory ID in topic")
            seen.add(id_)
            if kind == "trajectory":
                payload["cache_policy"] = "immutable" if published[0] else "live"
            rows.append(
                (
                    *scope,
                    id_,
                    kind,
                    part if kind == "trajectory" else 0,
                    part,
                    domains,
                    sessions,
                    json.dumps(payload),
                    " ".join(terms(text, index_single_characters=True)),
                )
            )
        cursor.executemany(
            """
            INSERT INTO memos_project.pm_retrieval_items
                (tenant_id,space_id,root_id,id,kind,part,position,domains,conversations,payload,keywords)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,to_tsvector('simple', %s))
        """,
            rows,
        )
    return True


def set_embedding(
    cursor: Any,
    tenant_id: str,
    space_id: str,
    root_id: str,
    revision: int,
    memory_id: str,
    part: int,
    vector: Vector,
) -> bool:
    """The worker identifies the exact indexed revision and chunk it embedded."""
    cursor.execute(
        """
        UPDATE memos_project.pm_retrieval_items i SET embedding=%s::vector, embedding_model=%s
        FROM memos_project.pm_retrieval_roots r
        WHERE (i.tenant_id,i.space_id,i.root_id)=(r.tenant_id,r.space_id,r.root_id)
          AND r.tenant_id=%s AND r.space_id=%s AND r.root_id=%s AND r.revision=%s
          AND i.id=%s AND i.part=%s
    """,
        (vector.sql_value(), vector.model, tenant_id, space_id, root_id, revision, memory_id, part),
    )
    return cursor.rowcount == 1
