"""Write side of the PostgreSQL backend: the transactional change-set writer and rank refresh.

write_change_set runs inside the caller's transaction, so Add can commit topics together with
its own tables; PostgresProjectDB.apply_changes opens a transaction and calls it.
"""

import json
import uuid

from collections.abc import Generator, Iterable
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from memos.configs.project_memory_limits import LIMITS, cut_at_sentence
from memos.project_dbs.exceptions import (
    DomainNotFoundError,
    EntryNotFoundError,
    SpaceClearedError,
    SpaceNotFoundError,
    TopicNotFoundError,
    VersionConflictError,
)
from memos.project_dbs.item import (
    AnyEntry,
    ConflictCard,
    DecisionCard,
    EntryStatus,
    JsonPart,
    Source,
    TopicChangeResult,
    TopicChangeSet,
    TopicCreate,
    TopicUpdate,
)
from memos.project_dbs.postgres_rows import SCHEMA
from memos.project_dbs.ranking import RankSignals, rank_time


EXPERIENCE_SEPARATOR = "｜"
_CARD_COLUMNS = {"id", "content", "chat_time", "user_ids", "embedding"}

_INSERT_ENTRY = f"""INSERT INTO {SCHEMA}.project_entries (id, topic_id, space_id, entry_type,
        status, parent_decision_id, content, chat_time, user_ids, extra, embedding,
        create_time, update_time) VALUES %s"""
_ENTRY_TEMPLATE = "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::vector, %s, %s)"


@contextmanager
def tuple_cursor(cursor: Any) -> Generator[Any, None, None]:
    """A plain tuple cursor on the caller's connection (and so its transaction); Add hands
    in RealDictCursor cursors."""
    import psycopg2.extensions

    if type(cursor) is psycopg2.extensions.cursor:
        yield cursor
        return
    with cursor.connection.cursor(cursor_factory=psycopg2.extensions.cursor) as cur:
        yield cur


# ---------- derived columns ----------
def merge_sources(existing: Iterable[dict], added: Iterable[Source]) -> list[dict]:
    """Append sources, one item per source conversation, first-seen order.

    Items with a conversation_id merge by (conversation_id, agent_id), unioning user_id;
    items without one merge only when member list and agent are the same."""
    merged: list[dict] = []
    index: dict[str, int] = {}
    for raw in [*existing, *(s.model_dump(mode="json") for s in added)]:
        item = Source.model_validate(raw).model_dump(mode="json")
        if item["conversation_id"]:
            key = json.dumps([item["conversation_id"], item["agent_id"]])
        else:
            key = json.dumps([None, item["agent_id"], sorted(item["user_id"])])
        if key not in index:
            index[key] = len(merged)
            merged.append(item)
            continue
        kept = merged[index[key]]
        for user in item["user_id"]:
            if user not in kept["user_id"]:
                kept["user_id"].append(user)
        for name, value in item.items():
            kept.setdefault(name, value)
    return merged


def conversation_ids(sources: Iterable[dict]) -> list[str]:
    """topics.conversation_ids: non-empty conversation_id of each source, deduplicated."""
    return list(dict.fromkeys(s["conversation_id"] for s in sources if s.get("conversation_id")))


def anchor_keys(anchors: Iterable[JsonPart | dict]) -> list[str]:
    """topics.anchor_keys: each anchor's non-empty string `key`, else the anchor as canonical
    JSON (sorted keys); deduplicated, first-seen order. Placeholder until the algorithm fixes
    the anchor structure."""
    keys = []
    for anchor in anchors:
        data = anchor.model_dump(mode="json") if isinstance(anchor, JsonPart) else anchor
        key = data.get("key") if isinstance(data, dict) else None
        keys.append(
            key
            if isinstance(key, str) and key
            else json.dumps(data, sort_keys=True, ensure_ascii=False)
        )
    return list(dict.fromkeys(keys))


def experience_content(card: JsonPart) -> str:
    """content of an experience: task_intent, problem and principle joined, within the
    experience limit of memos.configs.project_memory_limits."""
    data = card.model_dump()
    parts = (str(data[k]) for k in ("task_intent", "problem", "principle") if data.get(k))
    return cut_at_sentence(EXPERIENCE_SEPARATOR.join(parts), LIMITS.experience)[0]


# ---------- entry rows ----------
def entry_status(entry: AnyEntry) -> int:
    """Status written for an upserted entry: experiences honour ARCHIVED (retired) and
    ACTIVE; everything else is written ACTIVE (decision child rows come from history /
    conflicts, never from the caller's status)."""
    if entry.entry_type == "experience" and entry.status == EntryStatus.ARCHIVED:
        return int(EntryStatus.ARCHIVED)
    return int(EntryStatus.ACTIVE)


def _overwritable(entry: AnyEntry) -> list[int]:
    """Stored statuses an upsert by id may replace: a retired experience can be
    re-activated; other types only replace ACTIVE rows."""
    if entry.entry_type == "experience":
        return [int(EntryStatus.ACTIVE), int(EntryStatus.ARCHIVED)]
    return [int(EntryStatus.ACTIVE)]


def _entry_values(entry: AnyEntry) -> tuple:
    """(entry_type, content, chat_time, user_ids, extra, embedding) of an ACTIVE row."""
    content = entry.content
    if entry.entry_type == "experience":
        content = experience_content(entry.extra.card)
    return (
        entry.entry_type,
        content,
        entry.chat_time,
        list(entry.user_ids),
        json.dumps(entry.extra.model_dump(mode="json")),
        entry.embedding,
    )


def _card_values(card: DecisionCard | ConflictCard) -> tuple:
    """(content, chat_time, user_ids, extra, embedding) of a child row."""
    extra = card.model_dump(mode="json", exclude=_CARD_COLUMNS, exclude_none=True)
    return card.content, card.chat_time, list(card.user_ids), json.dumps(extra), card.embedding


def _insert_rows(cur: Any, rows: list[tuple]) -> None:
    if rows:
        from psycopg2.extras import execute_values

        # Parents precede their children, and each page finishes before the next starts.
        execute_values(cur, _INSERT_ENTRY, rows, template=_ENTRY_TEMPLATE)


def _new_rows(
    space_id: str, topic_id: str, entries: list[AnyEntry], stamp: datetime
) -> list[tuple]:
    """Rows for new ACTIVE entries plus their decision child rows."""
    rows, children = [], []
    for entry in entries:
        entry_id = str(uuid.uuid4())
        entry_type, content, chat_time, user_ids, extra, embedding = _entry_values(entry)
        rows.append(
            (entry_id, topic_id, space_id, entry_type, entry_status(entry), None, content,
             chat_time, user_ids, extra, embedding, stamp, stamp)
        )  # fmt: skip
        if entry.entry_type == "decision":
            cards = [(EntryStatus.ARCHIVED, c) for c in entry.history]
            cards += [(EntryStatus.CONFLICT, c) for c in entry.conflicts]
            for status, card in cards:
                if card.id is not None:
                    raise EntryNotFoundError(f"Child row not found for a new decision: {card.id}")
                children.append(_child_row(space_id, topic_id, entry_id, status, card, stamp))
    return rows + children


def _child_row(
    space_id: str,
    topic_id: str,
    decision_id: str,
    status: EntryStatus,
    card: DecisionCard | ConflictCard,
    stamp: datetime,
) -> tuple:
    content, chat_time, user_ids, extra, embedding = _card_values(card)
    return (
        str(uuid.uuid4()), topic_id, space_id, "decision", int(status), decision_id, content,
        chat_time, user_ids, extra, embedding, stamp, stamp,
    )  # fmt: skip


def _replace_children(
    cur: Any, space_id: str, topic_id: str, decision: AnyEntry, stamp: datetime
) -> None:
    """history: append-only (items with an id must exist and stay untouched);
    conflicts: replace wholesale, items with an existing id keep it."""
    cur.execute(
        f"SELECT id, status FROM {SCHEMA}.project_entries WHERE parent_decision_id = %s",
        (decision.id,),
    )
    existing = dict(cur.fetchall())
    new_rows = []
    for card in decision.history:
        if card.id is None:
            new_rows.append(
                _child_row(space_id, topic_id, decision.id, EntryStatus.ARCHIVED, card, stamp)
            )
        elif existing.get(card.id) != EntryStatus.ARCHIVED:
            raise EntryNotFoundError(f"History row not found in decision {decision.id}: {card.id}")
    kept = [c for c in decision.conflicts if c.id is not None]
    for card in kept:
        if existing.get(card.id) != EntryStatus.CONFLICT:
            raise EntryNotFoundError(f"Conflict row not found in decision {decision.id}: {card.id}")
    cur.execute(
        f"""DELETE FROM {SCHEMA}.project_entries
            WHERE parent_decision_id = %s AND status = %s AND NOT (id = ANY(%s))""",
        (decision.id, int(EntryStatus.CONFLICT), [c.id for c in kept]),
    )
    for card in kept:
        cur.execute(
            f"""UPDATE {SCHEMA}.project_entries SET content = %s, chat_time = %s, user_ids = %s,
                    extra = %s::jsonb, embedding = %s::vector, version = version + 1,
                    update_time = %s
                WHERE id = %s""",
            (*_card_values(card), stamp, card.id),
        )
    for card in decision.conflicts:
        if card.id is None:
            new_rows.append(
                _child_row(space_id, topic_id, decision.id, EntryStatus.CONFLICT, card, stamp)
            )
    _insert_rows(cur, new_rows)


def _overwrite_entry(
    cur: Any, space_id: str, topic_id: str, entry: AnyEntry, stamp: datetime
) -> None:
    """Replace an entry whole (a missing embedding clears the vector); the type cannot
    change. Experiences may be retired or re-activated through status."""
    entry_type, content, chat_time, user_ids, extra, embedding = _entry_values(entry)
    cur.execute(
        f"""UPDATE {SCHEMA}.project_entries SET content = %s, chat_time = %s, user_ids = %s,
                extra = %s::jsonb, embedding = %s::vector, status = %s, version = version + 1,
                update_time = %s
            WHERE id = %s AND topic_id = %s AND status = ANY(%s) AND entry_type = %s
              AND parent_decision_id IS NULL""",
        (content, chat_time, user_ids, extra, embedding, entry_status(entry), stamp, entry.id,
         topic_id, _overwritable(entry), entry_type),
    )  # fmt: skip
    if cur.rowcount == 0:
        raise EntryNotFoundError(f"{entry_type} entry not found in topic {topic_id}: {entry.id}")
    if entry_type == "decision":
        _replace_children(cur, space_id, topic_id, entry, stamp)


# ---------- topics ----------
def _create_topic(
    cur: Any, space_id: str, domain_id: str, item: TopicCreate, stamp: datetime
) -> str:
    topic_id = f"topic_{uuid.uuid4().hex}"
    sources = merge_sources([], item.sources)
    cur.execute(
        f"""INSERT INTO {SCHEMA}.topics (id, space_id, domain_id, topic_name, topic_summary,
                topic_description, sources, conversation_ids, embedding, anchors, anchor_keys,
                create_time, update_time, commit_time)
            VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::text[], %s::vector, %s::jsonb,
                    %s::text[], %s, %s, %s)""",
        (
            topic_id,
            space_id,
            domain_id,
            item.topic_name,
            item.topic_summary,
            item.topic_description,
            json.dumps(sources),
            conversation_ids(sources),
            item.embedding,
            json.dumps([a.model_dump(mode="json") for a in item.anchors]),
            anchor_keys(item.anchors),
            item.create_time,
            item.update_time,
            stamp,
        ),
    )
    _insert_rows(cur, _new_rows(space_id, topic_id, item.entries, stamp))
    return topic_id


def _update_topic(
    cur: Any,
    space_id: str,
    domain_id: str | None,
    item: TopicUpdate,
    current_sources: list[dict],
    stamp: datetime,
) -> list[dict]:
    """Returns the merged sources now stored."""
    sources = merge_sources(current_sources, item.add_sources)
    anchors = None if item.anchors is None else [a.model_dump(mode="json") for a in item.anchors]
    cur.execute(
        f"""UPDATE {SCHEMA}.topics SET
                domain_id = COALESCE(%s, domain_id),
                topic_summary = COALESCE(%s, topic_summary),
                topic_description = COALESCE(%s, topic_description),
                embedding = CASE WHEN %s THEN %s::vector ELSE embedding END,
                anchors = COALESCE(%s::jsonb, anchors),
                anchor_keys = COALESCE(%s::text[], anchor_keys),
                sources = %s::jsonb,
                conversation_ids = %s::text[],
                update_time = COALESCE(%s, update_time),
                commit_time = %s,
                version = version + 1
            WHERE id = %s AND space_id = %s AND version = %s""",
        (
            domain_id,
            item.topic_summary,
            item.topic_description,
            item.embedding is not None,
            item.embedding,
            None if anchors is None else json.dumps(anchors),
            None if anchors is None else anchor_keys(anchors),
            json.dumps(sources),
            conversation_ids(sources),
            item.update_time,
            stamp,
            item.topic_id,
            space_id,
            item.expected_version,
        ),
    )
    if cur.rowcount == 0:
        raise VersionConflictError(
            f"Topic {item.topic_id} changed since version {item.expected_version}"
        )
    if item.delete_entry_ids:  # ACTIVE rows only; child rows cascade
        cur.execute(
            f"""DELETE FROM {SCHEMA}.project_entries
                WHERE topic_id = %s AND id = ANY(%s) AND status = %s""",
            (item.topic_id, list(item.delete_entry_ids), int(EntryStatus.ACTIVE)),
        )
    new = [e for e in item.upsert_entries if e.id is None]
    for entry in item.upsert_entries:
        if entry.id is not None:
            _overwrite_entry(cur, space_id, item.topic_id, entry, stamp)
    _insert_rows(cur, _new_rows(space_id, item.topic_id, new, stamp))
    return sources


def write_change_set(
    cursor: Any, change_set: TopicChangeSet, *, now: datetime | None = None
) -> list[TopicChangeResult]:
    """Write one change set inside the caller's transaction; raising leaves the rollback to
    the caller. Locks the space row (FOR KEY SHARE: waits for clear_space, not for domain
    writers) and the updated topics in id order. `now` stamps commit_time and entry
    create/update_time; default clock_timestamp() after the locks. Results list creates (ADD)
    then updates (UPDATE). Errors: SpaceNotFoundError, SpaceClearedError, DomainNotFoundError,
    TopicNotFoundError, VersionConflictError, EntryNotFoundError."""
    space_id = change_set.space_id
    with tuple_cursor(cursor) as cur:
        cur.execute(
            f"SELECT clear_time FROM {SCHEMA}.spaces WHERE id = %s FOR KEY SHARE", (space_id,)
        )
        row = cur.fetchone()
        if row is None:
            raise SpaceNotFoundError(f"Space not found: {space_id}")
        if row[0] is not None and change_set.accept_time <= row[0]:
            raise SpaceClearedError(
                f"Space {space_id} was cleared at {row[0]}, after the task was accepted"
            )
        cur.execute(f"SELECT domain, id FROM {SCHEMA}.domains WHERE space_id = %s", (space_id,))
        domain_ids = dict(cur.fetchall())
        current_sources: dict[str, list] = {}
        if change_set.updates:
            # Lock in id order so concurrent change sets cannot deadlock on each other.
            cur.execute(
                f"""SELECT id, sources FROM {SCHEMA}.topics WHERE id = ANY(%s) AND space_id = %s
                    ORDER BY id FOR NO KEY UPDATE""",
                (sorted({u.topic_id for u in change_set.updates}), space_id),
            )
            current_sources = dict(cur.fetchall())
        if now is None:
            cur.execute("SELECT clock_timestamp()")
            now = cur.fetchone()[0]

        def resolve(name: str) -> str:
            if name not in domain_ids:
                raise DomainNotFoundError(f"Domain not registered in space {space_id}: {name}")
            return domain_ids[name]

        results = []
        for item in change_set.creates:
            topic_id = _create_topic(cur, space_id, resolve(item.domain), item, now)
            results.append(TopicChangeResult(topic_id=topic_id, operation="ADD"))
        for item in change_set.updates:
            if item.topic_id not in current_sources:
                raise TopicNotFoundError(f"Topic not found in space {space_id}: {item.topic_id}")
            domain_id = None if item.domain is None else resolve(item.domain)
            current_sources[item.topic_id] = _update_topic(
                cur, space_id, domain_id, item, current_sources[item.topic_id], now
            )
            results.append(TopicChangeResult(topic_id=item.topic_id, operation="UPDATE"))
        refresh_topic_ranks(cur, [r.topic_id for r in results])
    return results


# ---------- ranking ----------
_RANK_SIGNALS = f"""
SELECT t.id, t.update_time,
    (SELECT count(*) FROM {SCHEMA}.project_entries e
        WHERE e.topic_id = t.id AND e.status = 2),
    (SELECT count(*) FROM {SCHEMA}.project_entries e
        WHERE e.topic_id = t.id AND e.entry_type = 'decision' AND e.status = 0),
    (SELECT count(*) FROM {SCHEMA}.project_entries e
        WHERE e.topic_id = t.id AND e.entry_type = 'experience' AND e.status = 0
          AND e.extra->>'exp_status' = 'verified'),
    (SELECT count(DISTINCT m.u) FROM (
        SELECT unnest(e.user_ids) AS u FROM {SCHEMA}.project_entries e
            WHERE e.topic_id = t.id AND e.status = 0
        UNION ALL
        SELECT jsonb_array_elements_text(CASE jsonb_typeof(s->'user_id')
                WHEN 'array' THEN s->'user_id'
                WHEN 'string' THEN jsonb_build_array(s->'user_id')
                ELSE '[]'::jsonb END)
            FROM jsonb_array_elements(t.sources) s) m
        WHERE m.u <> ''),
    cardinality(t.conversation_ids)
FROM {SCHEMA}.topics t WHERE t.id = ANY(%s)"""


def refresh_topic_ranks(cursor: Any, topic_ids: list[str], schema: str = SCHEMA) -> None:
    """Recompute topics.extra.rank_time / extra.rank (see ranking.py) for the given topics."""
    if not topic_ids:
        return
    from psycopg2.extras import execute_values

    with tuple_cursor(cursor) as cur:
        cur.execute(_RANK_SIGNALS.replace(f"{SCHEMA}.", f"{schema}."), (list(set(topic_ids)),))
        values = []
        for topic_id, update_time, *counts in cur.fetchall():
            key, bonus = rank_time(update_time, RankSignals(*counts))
            values.append((topic_id, key.astimezone(timezone.utc).isoformat(), json.dumps(bonus)))
        execute_values(
            cur,
            f"""UPDATE {schema}.topics t
                SET extra = t.extra || jsonb_build_object('rank_time', v.rank_time,
                                                          'rank', v.rank::jsonb)
                FROM (VALUES %s) AS v(id, rank_time, rank) WHERE t.id = v.id""",
            values,
        )
