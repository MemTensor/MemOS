"""Add's view of the shared project memory tables (`memos.project_dbs`, postgres_init.sql).

The organize algorithm keeps working with one in-memory Topic dict per Topic: `decisions`,
`experiences` and `timeline` lists of entry dicts plus the Add fields `committed_at`,
`last_commit_key`, `created_by_episode_id` and `embedding_model_id` (kept in `topics.extra`).
This module is the adapter between that representation and the storage layer:

- read: topic and entry rows are assembled into the item models of `memos.project_dbs.item`
  (decision history / conflicts from their ARCHIVED / CONFLICT child rows) and converted to Add
  dicts. History and conflict items carry their child-row `id` and a `seq` label (1..n in
  chat-time order); the decision module shows conflicts as `c1..cn` and keeps the item, and so
  its `id`, through its changes;
- write: the committed base snapshot is diffed against the proposed snapshot and turned into a
  `TopicCreate` / `TopicUpdate` (only new or changed entries are upserted) for
  `postgres_writer.write_change_set`, which runs in the caller's transaction. Rows Add creates
  get their ids from storage; ids the algorithm gave new entries and Topics are placeholders.

Field mapping (spec item.py): entry `time` <-> `chat_time`; a decision's `source` is the first
of `extra.sources`; experience evidence `content` / `segment_id` <-> `quote` / `episode_id`; a
retired experience (confidence below the floor) is stored ARCHIVED with its confidence clamped
to the model's range. Keys the models do not declare stay in `extra` (JsonPart keeps them);
Add's own entry counter (`version` in the dicts) is `extra.item_version`.
"""

from __future__ import annotations

import json
import uuid

from datetime import datetime, timezone
from typing import Any

from memos.project_dbs.item import (
    ConflictCard,
    Decision,
    DecisionCard,
    EntrySource,
    EntryStatus,
    Experience,
    ExperienceCard,
    ExperienceSource,
    JsonPart,
    Source,
    Timeline,
    TopicCreate,
    TopicUpdate,
)
from memos.project_dbs.postgres_rows import _ENTRY_COLS, TOPIC_ORDER, entries_from_rows
from memos.project_dbs.postgres_writer import (
    _card_values,
    _entry_values,
    _insert_rows,
    conversation_ids,
    entry_status,
    merge_sources,
    refresh_topic_ranks,
    tuple_cursor,
)
from memos.project_dbs.postgres_writer import anchor_keys as storage_anchor_keys

from .add_entry_fields import experience_retired, experience_status
from .add_evidence import anchor_keys
from .experience import CONF_MAX, CONF_MIN
from .types import as_list, time_key


ENTRY_FIELDS = (("decision", "decisions"), ("experience", "experiences"), ("timeline", "timeline"))
TOPIC_EXTRA_FIELDS = (
    "committed_at",
    "last_commit_key",
    "created_by_episode_id",
    "embedding_model_id",
)
ITEM_VERSION = "item_version"

ADD_TABLES = """
-- One row per Episode on its way through the Add stages (the spec's add_jobs proposal).
CREATE TABLE IF NOT EXISTS add_jobs (
  episode_id        text PRIMARY KEY REFERENCES episodes (id) ON DELETE CASCADE,
  project_id        text NOT NULL,
  space_id          text NOT NULL,
  conversation_key  text NOT NULL,
  user_id           text NOT NULL,
  task_ids          text[] NOT NULL,
  domains           text[] NOT NULL,
  stage             text NOT NULL CHECK (stage IN ('episode_open', 'extracting', 'organizing',
                                                   'awaiting_merge', 'committing', 'done')),
  outcome           text NOT NULL DEFAULT 'pending'
                    CHECK (outcome IN ('pending', 'committed', 'staged', 'skipped', 'failed')),
  attempt           int NOT NULL DEFAULT 0,
  accept_time       timestamptz NOT NULL,
  close_due_time    timestamptz,
  next_retry_time   timestamptz,
  drafts            jsonb NOT NULL DEFAULT '[]'::jsonb,
  organize_result   jsonb,
  topic_ids         text[] NOT NULL DEFAULT '{}',
  error             jsonb,
  update_time       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((stage = 'episode_open') = (close_due_time IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_add_jobs_open ON add_jobs (space_id, conversation_key)
  WHERE stage = 'episode_open';
CREATE INDEX IF NOT EXISTS idx_add_jobs_tasks ON add_jobs USING gin (task_ids);
CREATE INDEX IF NOT EXISTS idx_add_jobs_close_due ON add_jobs (close_due_time)
  WHERE stage = 'episode_open';
CREATE INDEX IF NOT EXISTS idx_add_jobs_retry ON add_jobs (next_retry_time)
  WHERE next_retry_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_add_jobs_stalled ON add_jobs (update_time)
  WHERE stage NOT IN ('episode_open', 'done');
CREATE INDEX IF NOT EXISTS idx_add_jobs_staged ON add_jobs (space_id, update_time)
  WHERE outcome = 'staged';
-- One row per Episode lifecycle step: opened, turn, closed, published, claimed, stage_done,
-- finished. stage_done carries the stage's run time and provider-reported usage, so Add timing
-- and token cost can be derived per Episode and attributed to the Turns of each Add request.
CREATE TABLE IF NOT EXISTS add_episode_events (
  id          bigserial PRIMARY KEY,
  project_id  text NOT NULL,
  episode_id  text NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  event       text NOT NULL,
  at          timestamptz NOT NULL,
  stage       text,
  attempt     int,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS add_episode_events_episode ON add_episode_events (episode_id, at, id);
"""


# ---------- values ----------
def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def aware_time(value: Any, fallback: datetime | None = None) -> datetime | None:
    """A timezone-aware datetime; naive values are UTC, unparsable ones give the fallback."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return fallback
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return fallback


def vector_values(value: Any) -> list[float] | None:
    """A pgvector literal ("[0.1,0.2]") or a sequence as floats; None stays None."""
    if value is None:
        return None
    if isinstance(value, str):
        value = json.loads(value)
    return [float(part) for part in value]


def current_schema(cursor: Any) -> str:
    """The Add schema on the transaction's search path."""
    cursor.execute("SELECT current_schema()")
    row = cursor.fetchone()
    return next(iter(row.values())) if isinstance(row, dict) else row[0]


# ---------- read: models -> Add dicts ----------
def _source_dict(source: EntrySource | None) -> dict:
    return source.model_dump(mode="json") if source is not None else {}


def _decision_item(entry: Decision) -> dict:
    extra = entry.extra.model_dump(mode="json")
    sources = extra.pop("sources", [])
    labels = extra.pop("user_labels", {})
    version = extra.pop(ITEM_VERSION, None) or 1
    return {
        **extra,
        "id": entry.id,
        "content": entry.content,
        "time": _iso(entry.chat_time),
        "user_ids": list(entry.user_ids),
        "source": sources[0] if sources else {},
        "sources": sources,
        "user_labels": labels,
        "version": version,
        "history": [
            {
                "id": card.id,
                "seq": seq,
                "content": card.content,
                "time": _iso(card.chat_time),
                "user_ids": list(card.user_ids),
                "reason": card.reason or "",
                "source": _source_dict(card.source),
                "change_source": _source_dict(card.change_source),
            }
            for seq, card in enumerate(entry.history, 1)
        ],
        "conflicts": [
            {
                "id": card.id,
                "seq": seq,
                "content": card.content,
                "time": _iso(card.chat_time),
                "user_ids": list(card.user_ids),
                "source": _source_dict(card.source),
            }
            for seq, card in enumerate(entry.conflicts, 1)
        ],
    }


def _experience_evidence(source: dict) -> dict:
    """An evidence item in Add's shape: the quote is `content`, the Episode is `segment_id`."""
    item = dict(source)
    item["content"] = item.pop("quote", None) or ""
    item["segment_id"] = item.pop("episode_id", None)
    return item


def _experience_item(entry: Experience) -> dict:
    extra = entry.extra.model_dump(mode="json")
    version = extra.pop(ITEM_VERSION, None) or 1
    item = {
        **extra,
        "id": entry.id,
        "time": _iso(entry.chat_time),
        "user_ids": list(entry.user_ids),
        "sources": [_experience_evidence(s) for s in extra.get("sources") or []],
        "version": version,
    }
    if entry.status == EntryStatus.ARCHIVED:
        item["archived"] = True
    return item


def _timeline_item(entry: Timeline) -> dict:
    return {
        **entry.extra.model_dump(mode="json"),
        "id": entry.id,
        "content": entry.content,
        "time": _iso(entry.chat_time),
        "user_ids": list(entry.user_ids),
    }


def entry_item(entry: Any) -> dict:
    """The Add dict of one entry model."""
    if entry.entry_type == "decision":
        return _decision_item(entry)
    if entry.entry_type == "experience":
        return _experience_item(entry)
    return _timeline_item(entry)


_TOPIC_SELECT = """SELECT t.id, t.space_id, t.domain_id, d.domain, t.topic_name, t.topic_summary,
       t.topic_description, t.sources, t.anchors, t.extra, t.embedding::text AS embedding,
       t.version, t.create_time, t.update_time, t.commit_time
  FROM topics t
  JOIN spaces s ON s.id = t.space_id
  JOIN domains d ON d.space_id = t.space_id AND d.id = t.domain_id"""


def load_topics(
    cursor: Any, where: str, params: tuple, *, entry_ids: list[str] | None = None
) -> list[dict[str, Any]]:
    """Topics matching `where` (over `topics t`, `spaces s`, `domains d`) as Add dicts.

    Entries are the ACTIVE rows plus retired (ARCHIVED) experiences in chat-time order;
    decisions carry their history and conflicts. Retrieval can restrict entries to matched IDs.
    Topics use the shared get/memory importance order."""
    cursor.execute(f"{_TOPIC_SELECT} WHERE {where} ORDER BY {TOPIC_ORDER}", params)
    topics = cursor.fetchall()
    if not topics:
        return []
    schema = current_schema(cursor)
    by_id: dict[str, dict[str, Any]] = {}
    for row in topics:
        extra = row["extra"] or {}
        anchors = row["anchors"] or []
        by_id[row["id"]] = {
            **row,
            "sources": row["sources"] or [],
            "anchors": anchors,
            # Add's recall keys (path:, symbol:, api:, anchor:), derived from the anchors.
            "anchor_keys": anchor_keys(anchors),
            "rank_time": extra.get("rank_time"),
            **{key: extra.get(key) for key in TOPIC_EXTRA_FIELDS},
            **{field: [] for _, field in ENTRY_FIELDS},
        }
    if entry_ids == []:
        return list(by_id.values())
    entry_filter = "AND e.id = ANY(%s)" if entry_ids is not None else ""
    with tuple_cursor(cursor) as cur:
        cur.execute(
            f"""SELECT {_ENTRY_COLS} FROM project_entries e
                WHERE e.topic_id = ANY(%s) AND e.parent_decision_id IS NULL
                  AND (e.status = %s OR (e.entry_type = 'experience' AND e.status = %s))
                {entry_filter} ORDER BY e.chat_time, e.id COLLATE "C" """,
            (list(by_id), int(EntryStatus.ACTIVE), int(EntryStatus.ARCHIVED))
            + ((entry_ids,) if entry_ids is not None else ()),
        )
        entries = entries_from_rows(cur, cur.fetchall(), with_children=True, schema=schema)
    fields = dict(ENTRY_FIELDS)
    for entry in entries:
        by_id[entry.topic_id][fields[entry.entry_type]].append(entry_item(entry))
    return [by_id[row["id"]] for row in topics]


# ---------- write: Add dicts -> models ----------
_SOURCE_KEYS = ("conversation_id", "message_id", "episode_id", "quote")


def _entry_source(raw: Any) -> EntrySource | None:
    """A source with at least one known field; "" reads as missing."""
    if not isinstance(raw, dict):
        return None
    data = {key: value for key, value in raw.items() if key not in _SOURCE_KEYS}
    data.update({key: raw.get(key) or None for key in _SOURCE_KEYS})
    if not any(data[key] for key in _SOURCE_KEYS):
        return None
    return EntrySource.model_validate(data)


def _decision_sources(item: dict) -> list[EntrySource]:
    """`extra.sources`: the stored list while its first item is still the current source, else
    the current source alone (a rewrite replaces them; a resolution sets them explicitly)."""
    current = _entry_source(item.get("source"))
    listed = [s for s in (_entry_source(raw) for raw in item.get("sources") or []) if s]
    if listed and current and _same_quote(listed[0], current):
        return listed
    return [current] if current else []


def _same_quote(left: EntrySource, right: EntrySource) -> bool:
    return all(getattr(left, key) == getattr(right, key) for key in ("message_id", "quote"))


def child_key(decision_id: str, kind: str, seq: int) -> str:
    """Key of a decision child row's vector in a changeset's `item_embeddings`."""
    return f"{decision_id}#{kind}{seq}"


def _vector(vectors: dict[str, Any], key: str) -> list[float] | None:
    return vector_values(vectors.get(key))


def _cards(
    item: dict, fallback: datetime, vectors: dict[str, Any], *, new: bool
) -> tuple[list[DecisionCard], list[ConflictCard]]:
    decision_id = item.get("id") or ""
    history = []
    for seq, raw in enumerate(item.get("history") or [], 1):
        card_id = None if new else raw.get("id")
        history.append(
            DecisionCard(
                id=card_id,
                content=raw.get("content") or "",
                chat_time=aware_time(raw.get("time"), fallback),
                user_ids=list(raw.get("user_ids") or []),
                reason=raw.get("reason") or None,
                source=_entry_source(raw.get("source")),
                change_source=_entry_source(raw.get("change_source")),
                # History is append-only: only a new child row takes a vector.
                embedding=None if card_id else _vector(vectors, child_key(decision_id, "h", seq)),
            )
        )
    conflicts = [
        ConflictCard(
            id=None if new else raw.get("id"),
            content=raw.get("content") or "",
            chat_time=aware_time(raw.get("time"), fallback),
            user_ids=list(raw.get("user_ids") or []),
            source=_entry_source(raw.get("source")),
            # Conflicts are rewritten wholesale, so every item takes its vector.
            embedding=_vector(vectors, child_key(decision_id, "c", raw.get("seq") or seq)),
        )
        for seq, raw in enumerate(item.get("conflicts") or [], 1)
    ]
    return history, conflicts


_DECISION_KEYS = {
    "id",
    "content",
    "time",
    "user_ids",
    "source",
    "sources",
    "user_labels",
    "history",
    "conflicts",
    "version",
    "topic_id",
    "space_id",
    "rev",
}


def _decision_model(item: dict, fallback: datetime, vectors: dict, *, new: bool) -> Decision:
    extra = {key: value for key, value in item.items() if key not in _DECISION_KEYS}
    extra.update(
        sources=_decision_sources(item),
        user_labels=dict(item.get("user_labels") or {}),
        **{ITEM_VERSION: item.get("version") or 1},
    )
    history, conflicts = _cards(item, fallback, vectors, new=new)
    return Decision(
        content=item.get("content") or "",
        chat_time=aware_time(item.get("time"), fallback),
        user_ids=list(item.get("user_ids") or []),
        extra=extra,
        history=history,
        conflicts=conflicts,
    )


_EXPERIENCE_KEYS = {
    "id",
    "card",
    "exp_status",
    "status",
    "confidence",
    "time",
    "user_ids",
    "sources",
    "archived",
    "version",
    "content",
    "topic_id",
    "space_id",
}
_SIGNALS = {"test", "build", "review", "user", "none"}
_ACTIONS = {"add", "confirm", "update", "refute"}
_CARD_TEXT = ("task_intent", "problem", "principle")
_EVIDENCE_MAPPED = {"content", "segment_id", *_SOURCE_KEYS, "chat_time", "signal", "action"}


def _evidence(raw: dict) -> ExperienceSource:
    data = {key: value for key, value in raw.items() if key not in _EVIDENCE_MAPPED}
    data.update(
        conversation_id=raw.get("conversation_id") or None,
        message_id=raw.get("message_id") or None,
        episode_id=raw.get("episode_id") or raw.get("segment_id") or None,
        quote=raw.get("quote") or raw.get("content") or None,
        chat_time=aware_time(raw.get("chat_time")),
        signal=raw.get("signal") if raw.get("signal") in _SIGNALS else None,
        action=raw.get("action") if raw.get("action") in _ACTIONS else None,
    )
    return ExperienceSource.model_validate(data)


def _experience_model(item: dict, fallback: datetime) -> Experience:
    card = dict(item.get("card") or {})
    card.update({key: str(card.get(key) or "") for key in _CARD_TEXT})
    card["anchors"] = [str(anchor) for anchor in card.get("anchors") or []]
    confidence = item.get("confidence")
    confidence = 0.5 if confidence is None else float(confidence)
    status = experience_status(item)
    extra = {key: value for key, value in item.items() if key not in _EXPERIENCE_KEYS}
    if extra.get("last_supported_at") == "":
        extra["last_supported_at"] = None
    extra.update(
        card=ExperienceCard.model_validate(card),
        exp_status=status if status in ("verified", "candidate", "failed_attempt") else "candidate",
        confidence=min(CONF_MAX, max(CONF_MIN, confidence)),
        sources=[_evidence(raw) for raw in item.get("sources") or [] if isinstance(raw, dict)],
        **{ITEM_VERSION: item.get("version") or 1},
    )
    return Experience(
        # Retirement is the ARCHIVED status, not a confidence below the model's floor.
        status=EntryStatus.ARCHIVED if experience_retired(item) else EntryStatus.ACTIVE,
        content="",  # built from the card by the writer
        chat_time=aware_time(item.get("time"), fallback),
        user_ids=list(item.get("user_ids") or []),
        extra=extra,
    )


_TIMELINE_KEYS = {"id", "content", "time", "user_ids", "topic_id", "space_id"}


def _timeline_model(item: dict, fallback: datetime) -> Timeline:
    extra = {key: value for key, value in item.items() if key not in _TIMELINE_KEYS}
    users = list(item.get("user_ids") or [])
    refs = [ref.get("message_id") for ref in item.get("source_refs") or [] if isinstance(ref, dict)]
    extra.update(
        conversation_id=item.get("conversation_id") or None,
        message_ids=list(item.get("message_ids") or dict.fromkeys(r for r in refs if r)),
        episode_id=item.get("episode_id") or None,
        role_id=item.get("role_id") or (users[0] if users else None),
    )
    return Timeline(
        content=item.get("content") or "",
        chat_time=aware_time(item.get("time"), fallback),
        user_ids=users,
        extra=extra,
    )


def entry_model(
    kind: str,
    item: dict,
    fallback: datetime,
    vectors: dict[str, Any] | None = None,
    *,
    new: bool = False,
) -> Any:
    """The storage model of one Add entry dict; `new` drops every id (rows get storage ids).
    `vectors` maps entry ids (and `child_key`s) to the vectors prepared by add_index."""
    vectors = vectors or {}
    if kind == "decision":
        model = _decision_model(item, fallback, vectors, new=new)
    elif kind == "experience":
        model = _experience_model(item, fallback)
    else:
        model = _timeline_model(item, fallback)
    if not new:
        model.id = item.get("id")
    model.embedding = _vector(vectors, item.get("id") or "")
    return model


def _comparable(model: Any) -> str:
    data = model.model_dump(
        mode="json", exclude={"version", "create_time", "update_time", "topic_id", "space_id"}
    )
    return json.dumps(data, sort_keys=True, ensure_ascii=False)


def topic_sources(topic: dict) -> list[Source]:
    """`sources` items: {conversation_id, user_id: [role ids], agent_id: first agent or None}."""
    sources = []
    for raw in topic.get("sources") or []:
        if not isinstance(raw, dict):
            continue
        agents = as_list(raw.get("agent_id"))
        data = {k: v for k, v in raw.items() if k not in ("conversation_id", "user_id", "agent_id")}
        data.update(
            conversation_id=raw.get("conversation_id") or None,
            user_id=list(dict.fromkeys(as_list(raw.get("user_id")))),
            agent_id=agents[0] if agents else None,
        )
        sources.append(Source.model_validate(data))
    return sources


def topic_anchors(topic: dict) -> list[JsonPart]:
    """Anchors with a `key` (the first of Add's recall keys), so the storage-derived
    `anchor_keys` column indexes them."""
    anchors = []
    for raw in topic.get("anchors") or []:
        if isinstance(raw, dict):
            key = raw.get("key") or next(iter(anchor_keys([raw])), None)
            anchors.append(JsonPart.model_validate({**raw, "key": key}))
    return anchors


def _fallback_time(topic: dict) -> datetime:
    return (
        aware_time(topic.get("update_time"))
        or aware_time(topic.get("create_time"))
        or datetime.now(timezone.utc)
    )


def topic_create(
    topic: dict,
    *,
    vectors: dict[str, Any] | None = None,
    embedding: list[float] | str | None = None,
) -> TopicCreate:
    """A new Topic from the proposed snapshot; every entry is new and gets a storage id."""
    fallback = _fallback_time(topic)
    return TopicCreate(
        domain=topic["domain"],
        topic_name=topic["topic_name"],
        topic_summary=topic.get("topic_summary") or "",
        topic_description=topic.get("topic_description") or "",
        entries=[
            entry_model(kind, item, fallback, vectors, new=True)
            for kind, field in ENTRY_FIELDS
            for item in topic.get(field) or []
        ],
        sources=topic_sources(topic),
        create_time=aware_time(topic.get("create_time"), fallback),
        update_time=aware_time(topic.get("update_time"), fallback),
        embedding=vector_values(embedding),
        anchors=topic_anchors(topic),
    )


def topic_update(
    base: dict,
    proposed: dict,
    *,
    vectors: dict[str, Any] | None = None,
    embedding: list[float] | str | None = None,
) -> TopicUpdate:
    """The change from the committed `base` snapshot to `proposed`, guarded by its version:
    entries whose id storage does not hold are new, entries that differ are replaced by id,
    ACTIVE entries no longer proposed are deleted; sources are appended (storage merges them);
    header fields are sent only when they differ."""
    fallback = _fallback_time(proposed)
    base_fallback = _fallback_time(base)
    upserts, keep = [], set()
    for kind, field in ENTRY_FIELDS:
        stored = {item["id"]: item for item in base.get(field) or [] if item.get("id")}
        for item in proposed.get(field) or []:
            current = stored.get(item.get("id"))
            if current is None:
                upserts.append(entry_model(kind, item, fallback, vectors, new=True))
                continue
            keep.add(item["id"])
            model = entry_model(kind, item, fallback, vectors)
            if _comparable(model) != _comparable(entry_model(kind, current, base_fallback)):
                upserts.append(model)
    deleted = [
        item["id"]
        for _, field in ENTRY_FIELDS
        for item in base.get(field) or []
        if item.get("id") and item["id"] not in keep and not item.get("archived")
    ]
    update_time = None
    if time_key(proposed.get("update_time")) > time_key(base.get("update_time")):
        update_time = aware_time(proposed["update_time"])
    anchors = None
    if (proposed.get("anchors") or []) != (base.get("anchors") or []):
        anchors = topic_anchors(proposed)

    def changed(key: str) -> Any:
        value = proposed.get(key)
        return value if value is not None and value != base.get(key) else None

    return TopicUpdate(
        topic_id=base["id"],
        expected_version=int(base["version"]),
        domain=changed("domain"),
        topic_summary=changed("topic_summary"),
        topic_description=changed("topic_description"),
        upsert_entries=upserts,
        delete_entry_ids=deleted,
        add_sources=topic_sources(proposed),
        update_time=update_time,
        embedding=vector_values(embedding),
        anchors=anchors,
    )


def mark_topics(cursor: Any, topic_ids: list[str], marks: dict[str, Any]) -> None:
    """Merge Add's own fields into topics.extra; committed_at is the database clock."""
    if not topic_ids:
        return
    from psycopg2.extras import Json

    cursor.execute(
        """UPDATE topics SET extra = extra || %s::jsonb
                                   || jsonb_build_object('committed_at', clock_timestamp())
           WHERE id = ANY(%s::text[])""",
        (Json({key: value for key, value in marks.items() if value is not None}), topic_ids),
    )


def import_topics(cursor: Any, topics: list[dict]) -> None:
    """Insert Topics with the ids they already have (legacy import), in the caller's transaction.

    Organize writes go through `write_change_set`, which generates ids; an import keeps the
    source ids that Tasks and clients already hold, so it converts the dicts with the same
    models and row serialization as the writer and inserts them under their ids."""
    if not topics:
        return
    with tuple_cursor(cursor) as cur:
        schema = current_schema(cur)
        for topic in topics:
            sources = merge_sources([], topic_sources(topic))
            anchors = [anchor.model_dump(mode="json") for anchor in topic_anchors(topic)]
            fallback = _fallback_time(topic)
            cur.execute(
                """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                       topic_description, sources, conversation_ids, anchors, anchor_keys,
                       create_time, update_time)
                   VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::text[], %s::jsonb, %s::text[],
                           %s, %s)""",
                (
                    topic["id"],
                    topic["space_id"],
                    topic["domain_id"],
                    topic["topic_name"],
                    topic.get("topic_summary") or "",
                    topic.get("topic_description") or "",
                    json.dumps(sources),
                    conversation_ids(sources),
                    json.dumps(anchors),
                    storage_anchor_keys(anchors),
                    aware_time(topic.get("create_time"), fallback),
                    aware_time(topic.get("update_time"), fallback),
                ),
            )
            rows: list[tuple] = []
            children: list[tuple] = []
            for kind, field in ENTRY_FIELDS:
                for item in topic.get(field) or []:
                    model = entry_model(kind, item, fallback, new=True)
                    entry_type, content, chat_time, users, extra, vector = _entry_values(model)
                    rows.append(
                        (item["id"], topic["id"], topic["space_id"], entry_type,
                         entry_status(model), None, content, chat_time, users, extra, vector,
                         fallback, fallback)
                    )  # fmt: skip
                    if kind != "decision":
                        continue
                    cards = [(EntryStatus.ARCHIVED, card) for card in model.history]
                    cards += [(EntryStatus.CONFLICT, card) for card in model.conflicts]
                    for status, card in cards:
                        children.append(
                            (str(uuid.uuid4()), topic["id"], topic["space_id"], "decision",
                             int(status), item["id"], *_card_values(card), fallback, fallback)
                        )  # fmt: skip
            _insert_rows(cur, rows + children, schema)
        refresh_topic_ranks(cur, [topic["id"] for topic in topics], schema)
