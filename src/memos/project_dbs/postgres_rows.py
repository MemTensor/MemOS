"""Read side of the PostgreSQL backend: column lists, filters, ordering and row assembly.

Shared by PostgresProjectDB and the writer; everything here runs on a plain tuple cursor.
"""

from typing import Any

from memos.project_dbs.item import (
    AnyEntry,
    ConflictCard,
    Decision,
    DecisionCard,
    EntryStatus,
    Experience,
    Timeline,
    Topic,
    TopicFilter,
)


SCHEMA = "project_memory"

_TOPIC_COLS = (
    "t.id, t.space_id, d.domain, t.topic_name, t.topic_summary, t.topic_description, "
    "t.sources, t.create_time, t.update_time, t.version, t.anchors"
)
_TOPIC_NAMES = (
    "id",
    "space_id",
    "domain",
    "topic_name",
    "topic_summary",
    "topic_description",
    "sources",
    "create_time",
    "update_time",
    "version",
    "anchors",
)
_ENTRY_COLS = (
    "e.id, e.topic_id, e.space_id, e.entry_type, e.status, e.parent_decision_id, e.content, "
    "e.chat_time, e.user_ids, e.extra, e.version, e.create_time, e.update_time"
)
_ENTRY_NAMES = (
    "id",
    "topic_id",
    "space_id",
    "entry_type",
    "status",
    "parent_decision_id",
    "content",
    "chat_time",
    "user_ids",
    "extra",
    "version",
    "create_time",
    "update_time",
)
ENTRY_TYPES = {"decision": Decision, "experience": Experience, "timeline": Timeline}
TOPIC_FIELDS = {"decision": "decisions", "experience": "experiences", "timeline": "timeline"}
_RANGE_OPS = (("gt", ">"), ("gte", ">="), ("lt", "<"), ("lte", "<="))

# Topic order of get/memory: importance key first (see ranking.py), stable for paging.
TOPIC_ORDER = (
    "(t.extra->>'rank_time')::timestamptz DESC NULLS LAST, t.update_time DESC, t.id COLLATE \"C\""
)

# Per-type entry order. k1/k2 are 0 for timeline, so it falls through to chat_time.
_HAS_OPEN_CONFLICT = (
    f"EXISTS (SELECT 1 FROM {SCHEMA}.project_entries c "
    f"WHERE c.parent_decision_id = e.id AND c.status = {int(EntryStatus.CONFLICT)})"
)
_K1 = (  # decisions with open conflicts first; verified experiences first
    f"CASE e.entry_type WHEN 'decision' THEN ({_HAS_OPEN_CONFLICT})::int "
    "WHEN 'experience' THEN COALESCE(e.extra->>'exp_status' = 'verified', false)::int ELSE 0 END"
)
_K2 = (  # more members first; higher confidence first
    "CASE e.entry_type WHEN 'decision' THEN cardinality(e.user_ids)::float8 "
    "WHEN 'experience' THEN COALESCE((e.extra->>'confidence')::float8, 0) ELSE 0 END"
)
# Picks the preview rows: timeline takes the newest ones.
PREVIEW_ORDER = f'{_K1} DESC, {_K2} DESC, e.chat_time DESC, e.id COLLATE "C"'
# Display order: like PREVIEW_ORDER, except timeline runs oldest first.
DISPLAY_ORDER = (
    f"{_K1} DESC, {_K2} DESC, "
    "CASE WHEN e.entry_type = 'timeline' THEN e.chat_time END ASC, "
    'e.chat_time DESC, e.id COLLATE "C"'
)


def filters_sql(
    filters: list[TopicFilter] | None, params: list[Any], columns: dict[str, str]
) -> str:
    """' AND (OR of AND groups)' over the mapped columns; '' when unfiltered.
    columns maps the filter fields create_time / update_time to SQL expressions."""
    groups = []
    for group in filters or []:
        conditions = []
        for field in ("create_time", "update_time"):
            time_range = getattr(group, field)
            if time_range is None:
                continue
            for op, sql_op in _RANGE_OPS:
                value = getattr(time_range, op)
                if value is not None:
                    conditions.append(f"{columns[field]} {sql_op} %s")
                    params.append(value)
        groups.append("(" + " AND ".join(conditions) + ")" if conditions else "TRUE")
    return " AND (" + " OR ".join(groups) + ")" if groups else ""


TOPIC_TIME_COLUMNS = {"create_time": "t.create_time", "update_time": "t.update_time"}
ENTRY_TIME_COLUMNS = {"create_time": "e.chat_time", "update_time": "e.chat_time"}


def topic_from_row(row: tuple) -> Topic:
    return Topic.model_validate(dict(zip(_TOPIC_NAMES, row, strict=True)))


def _entry_data(row: tuple) -> dict:
    data = dict(zip(_ENTRY_NAMES, row, strict=True))
    data["user_ids"] = list(data["user_ids"])
    return data


def entry_from_row(
    row: tuple, children: tuple[list[DecisionCard], list[ConflictCard]] | None = None
) -> AnyEntry:
    """Build the entry model; children are (history, conflicts) for decisions."""
    data = _entry_data(row)
    data.pop("parent_decision_id")
    entry_type = data.pop("entry_type")
    if entry_type == "decision" and children is not None:
        data["history"], data["conflicts"] = children
    return ENTRY_TYPES[entry_type].model_validate(data)


def load_children(
    cur: Any, decision_ids: list[str]
) -> dict[str, tuple[list[DecisionCard], list[ConflictCard]]]:
    """history (ARCHIVED) and conflicts (CONFLICT) per decision, oldest chat_time first."""
    children: dict[str, tuple[list, list]] = {d: ([], []) for d in decision_ids}
    if not decision_ids:
        return children
    cur.execute(
        f"""SELECT {_ENTRY_COLS} FROM {SCHEMA}.project_entries e
            WHERE e.parent_decision_id = ANY(%s)
            ORDER BY e.chat_time, e.id COLLATE "C" """,
        (list(decision_ids),),
    )
    for row in cur.fetchall():
        data = _entry_data(row)
        card = {
            "id": data["id"],
            "content": data["content"],
            "chat_time": data["chat_time"],
            "user_ids": data["user_ids"],
            **data["extra"],
        }
        history, conflicts = children[data["parent_decision_id"]]
        if data["status"] == EntryStatus.CONFLICT:
            conflicts.append(ConflictCard.model_validate(card))
        else:
            history.append(DecisionCard.model_validate(card))
    return children


def entries_from_rows(cur: Any, rows: list[tuple], with_children: bool) -> list[AnyEntry]:
    """Entry models in row order; decisions get their child rows when with_children."""
    if not with_children:
        return [entry_from_row(row) for row in rows]
    data = [dict(zip(_ENTRY_NAMES, row, strict=True)) for row in rows]
    decision_ids = [d["id"] for d in data if d["entry_type"] == "decision"]
    children = load_children(cur, decision_ids)
    return [entry_from_row(row, children.get(d["id"])) for row, d in zip(rows, data, strict=True)]


def attach_entries(topics: dict[str, Topic], entries: list[AnyEntry]) -> None:
    for entry in entries:
        getattr(topics[entry.topic_id], TOPIC_FIELDS[entry.entry_type]).append(entry)


def load_entries_by_id(cur: Any, entry_ids: list[str]) -> dict[str, AnyEntry]:
    """Entries with children, keyed by id; unknown ids are skipped."""
    if not entry_ids:
        return {}
    cur.execute(
        f"SELECT {_ENTRY_COLS} FROM {SCHEMA}.project_entries e WHERE e.id = ANY(%s)",
        (list(entry_ids),),
    )
    return {e.id: e for e in entries_from_rows(cur, cur.fetchall(), with_children=True)}
