"""Add's view of the shared project memory schema (`memos.project_dbs`, postgres_init.sql).

Add keeps working with one in-memory Topic dict per Topic: `decisions`, `experiences` and
`timeline` lists of entry dicts, plus the Add fields `committed_at`, `last_commit_key`,
`created_by_episode_id` and `embedding_model_id`. In the shared schema an entry is one
`project_entries` row and the Add fields live in `topics.extra`; this module converts both ways.
Formation counters live in the Add-owned `add_space_state` table, so the shared tables keep the
definition owned by the storage layer.
"""

from __future__ import annotations

import re

from datetime import datetime, timezone
from typing import Any

from memos.project_dbs.postgres import INIT_SQL
from memos.project_dbs.postgres import SCHEMA as SHARED_SCHEMA

from .add_index import topic_item_content


ENTRY_FIELDS = (("decision", "decisions"), ("experience", "experiences"), ("timeline", "timeline"))
TOPIC_EXTRA_FIELDS = (
    "committed_at",
    "last_commit_key",
    "created_by_episode_id",
    "embedding_model_id",
)
# Columns of project_entries; everything else of an entry dict is kept in `extra`.
_ENTRY_COLUMNS = {"id", "content", "time", "user_ids", "history", "conflicts"}
_POSITION = "_position"

ADD_TABLES = """
CREATE TABLE IF NOT EXISTS add_space_state (
  space_id                    text PRIMARY KEY REFERENCES spaces (id) ON DELETE CASCADE,
  resource_bindings           jsonb  NOT NULL DEFAULT '[]',
  last_formation_at           timestamptz,
  staged_since_last_formation int    NOT NULL DEFAULT 0,
  formation_version           bigint NOT NULL DEFAULT 0
);
"""

# Space columns with the Add state; spaces without a state row read as defaults.
SPACE_STATE = """COALESCE(st.resource_bindings, '[]'::jsonb) AS resource_bindings,
       st.last_formation_at,
       COALESCE(st.staged_since_last_formation, 0) AS staged_since_last_formation,
       COALESCE(st.formation_version, 0) AS formation_version"""


def render_shared_ddl(schema: str, dimension: int, parser: str = "simple") -> str:
    """postgres_init.sql for `schema`, filled the same way as `PostgresProjectDB`."""
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
        raise ValueError("Project memory schema names must be lowercase identifiers")
    if parser == "zhparser":
        create = (
            f"CREATE TEXT SEARCH CONFIGURATION {schema}.zh (PARSER = zhparser); "
            f"ALTER TEXT SEARCH CONFIGURATION {schema}.zh "
            "ADD MAPPING FOR n, v, a, i, e, l WITH simple;"
        )
    elif parser == "simple":
        create = f"CREATE TEXT SEARCH CONFIGURATION {schema}.zh (COPY = simple);"
    else:
        raise ValueError("Text search parser must be zhparser or simple")
    text_search = (
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_ts_config c "
        "JOIN pg_namespace n ON n.oid = c.cfgnamespace "
        f"WHERE c.cfgname = 'zh' AND n.nspname = '{schema}') THEN {create} END IF; END $$;"
    )
    template = INIT_SQL.read_text(encoding="utf-8")
    if schema != SHARED_SCHEMA:
        template = re.sub(rf"\b{SHARED_SCHEMA}\b", schema, template)
    return template.replace("{embedding_dimension}", str(int(dimension))).replace(
        "{text_search_config}", text_search
    )


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def _timestamp(value: Any, fallback: Any) -> Any:
    """Entry time for the NOT NULL column; naive or missing times fall back to the topic time."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return fallback
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return fallback


def _null_empty_times(extra: dict) -> None:
    """Add writes "" for an unknown time; ExperienceExtra expects a datetime or null."""
    if extra.get("last_supported_at") == "":
        extra["last_supported_at"] = None
    sources = extra.get("sources")
    if isinstance(sources, list):
        extra["sources"] = [
            {**source, "chat_time": None}
            if isinstance(source, dict) and source.get("chat_time") == ""
            else source
            for source in sources
        ]


def entry_rows(topic: dict, fallback_time: Any) -> list[tuple[str, dict]]:
    """(entry_type, row) for every entry of an in-memory Topic, in list order."""
    rows = []
    for kind, field in ENTRY_FIELDS:
        for position, item in enumerate(topic.get(field) or []):
            extra = {key: value for key, value in item.items() if key not in _ENTRY_COLUMNS}
            if kind == "decision":
                history, conflicts = item.get("history") or [], item.get("conflicts") or []
            else:
                # An experience keeps its card versions in extra.history, as ExperienceExtra does.
                history, conflicts = [], []
                if item.get("history") is not None:
                    extra["history"] = item["history"]
                if kind == "experience" and "content" in item:
                    extra["content"] = item["content"]
            if kind == "experience":
                _null_empty_times(extra)
            extra[_POSITION] = position
            content = (
                topic_item_content(kind, item) or item.get("content") or ""
                if kind == "experience"
                else item.get("content") or ""
            )
            rows.append(
                (
                    kind,
                    {
                        "id": item["id"],
                        "content": content,
                        "time": _timestamp(item.get("time"), fallback_time),
                        "user_ids": list(item.get("user_ids") or []),
                        "history": history,
                        "conflicts": conflicts,
                        "extra": extra,
                    },
                )
            )
    return rows


def entry_item(row: dict) -> dict:
    """The in-memory entry dict of one project_entries row."""
    extra = dict(row.get("extra") or {})
    extra.pop(_POSITION, None)
    item = {
        "id": row["id"],
        "time": _iso(row["time"]),
        "user_ids": list(row.get("user_ids") or []),
    }
    if row["entry_type"] == "decision":
        item.update(
            content=row["content"],
            history=row.get("history") or [],
            conflicts=row.get("conflicts") or [],
        )
    elif row["entry_type"] == "timeline":
        item["content"] = row["content"]
    # An experience's column content is derived from its card; extra keeps any original content.
    item.update(extra)
    return item


def write_entries(
    cursor: Any,
    topic: dict,
    *,
    embeddings: dict[str, str] | None = None,
) -> None:
    """Make the Topic's project_entries rows match its entry lists.

    Unchanged rows keep their version; changed rows are updated in place and bump `version`;
    entries no longer present are deleted.
    """
    from .add_store import json_value

    fallback = _timestamp(topic.get("update_time"), datetime.now(timezone.utc))
    rows = entry_rows(topic, fallback)
    keep = [row["id"] for _, row in rows]
    cursor.execute(
        """DELETE FROM project_entries WHERE space_id = %s AND topic_id = %s
             AND NOT (id = ANY(%s::text[]))""",
        (topic["space_id"], topic["id"], keep),
    )
    for kind, row in rows:
        vector = (embeddings or {}).get(row["id"])
        cursor.execute(
            """INSERT INTO project_entries AS e
                   (id, topic_id, space_id, entry_type, content, time, user_ids, history,
                    conflicts, extra, embedding)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)
               ON CONFLICT (id) DO UPDATE SET
                   content = EXCLUDED.content, time = EXCLUDED.time, user_ids = EXCLUDED.user_ids,
                   history = EXCLUDED.history, conflicts = EXCLUDED.conflicts, extra = EXCLUDED.extra,
                   update_time = clock_timestamp(), version = e.version + 1
               WHERE e.topic_id = EXCLUDED.topic_id AND e.space_id = EXCLUDED.space_id
                 AND (e.content, e.time, e.user_ids, e.history, e.conflicts, e.extra)
                     IS DISTINCT FROM (EXCLUDED.content, EXCLUDED.time, EXCLUDED.user_ids,
                                       EXCLUDED.history, EXCLUDED.conflicts, EXCLUDED.extra)""",
            (
                row["id"],
                topic["id"],
                topic["space_id"],
                kind,
                row["content"],
                row["time"],
                row["user_ids"],
                json_value(row["history"]),
                json_value(row["conflicts"]),
                json_value(row["extra"]),
                vector,
            ),
        )
        if vector is not None:
            cursor.execute(
                "UPDATE project_entries SET embedding = %s::vector WHERE id = %s",
                (vector, row["id"]),
            )


def topic_extra(topic: dict, current: dict | None = None) -> dict:
    extra = dict((current or {}).get("extra") or {})
    extra.update(
        {key: _iso(topic[key]) for key in TOPIC_EXTRA_FIELDS if topic.get(key) is not None}
    )
    return extra


def load_topics(cursor: Any, where: str, params: tuple) -> list[dict[str, Any]]:
    """Topics matching `where` (over `topics t` joined with `spaces s`, `domains d`), with entries."""
    cursor.execute(
        f"""SELECT t.*, d.domain FROM topics t
              JOIN spaces s ON s.id = t.space_id
              JOIN domains d ON d.space_id = t.space_id AND d.id = t.domain_id
            WHERE {where}
            ORDER BY t.update_time DESC, t.id""",
        params,
    )
    topics = cursor.fetchall()
    if not topics:
        return []
    cursor.execute(
        """SELECT * FROM project_entries WHERE topic_id = ANY(%s::text[])
           ORDER BY topic_id, entry_type, COALESCE((extra->>'_position')::int, 0), time, id""",
        ([row["id"] for row in topics],),
    )
    entries: dict[str, dict[str, list]] = {}
    for row in cursor.fetchall():
        entries.setdefault(row["topic_id"], {}).setdefault(row["entry_type"], []).append(
            entry_item(row)
        )
    out = []
    for row in topics:
        topic = dict(row)
        extra = topic.get("extra") or {}
        for key in TOPIC_EXTRA_FIELDS:
            topic[key] = extra.get(key)
        for kind, field in ENTRY_FIELDS:
            topic[field] = entries.get(row["id"], {}).get(kind, [])
        out.append(topic)
    return out
