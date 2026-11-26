"""In-place migration of the pre-spec project memory layout (same schema name).

The legacy layout (git 9e5b2f26, tests/project_dbs/fixtures/legacy_postgres_init_v1.sql) is
recognised by project_entries.time or project_entries.history, or an episode_turns table.
migrate_legacy_layout runs in the caller's transaction (install_schema, under the init lock):

* spaces: cleared_at -> clear_time; resource_bindings / last_formation_time /
  formation_version added and copied from Add's add_space_state when present (that table
  is left to Add).
* topics: sources normalised to the Source shape (user_id list, agent_id string; an agent
  list keeps its first item and the full list under agent_ids); conversation_ids derived;
  commit_time from extra.committed_at, else update_time; chat-time defaults dropped.
* project_entries: time -> chat_time; history / conflicts JSON exploded into ARCHIVED /
  CONFLICT child rows (new ids; content, time, user_ids in columns, the rest in extra);
  a decision's extra.source becomes extra.sources; experience extras normalised to
  ExperienceExtra and experiences with confidence < 0.1 retired (status 1).
* messages / episodes / episode_turns are renamed to legacy_*_v1 and kept as a backup of
  the Add-only data the spec has no place for. New messages get msg_seq renumbered per
  (project_id, conversation_key) in (turn_seq, msg_seq) order; new episodes become msg_seq
  ranges of their turns, filed under moved_to_topic_id or result.topic_ids[0]. Episodes
  without messages, or overlapping an earlier one of the same conversation, stay only in the
  backup. Foreign keys of other tables (Add's add_episode_events) are re-pointed NOT VALID.
* Topic rank keys are computed; old ids keep their values.
"""

import json

from typing import Any

from pydantic import ValidationError

from memos.log import get_logger
from memos.project_dbs.exceptions import ProjectDBError
from memos.project_dbs.item import ExperienceExtra, ExperienceSource
from memos.project_dbs.postgres_rows import SCHEMA
from memos.project_dbs.postgres_writer import refresh_topic_ranks, tuple_cursor


logger = get_logger(__name__)

LEGACY_TABLES = ("messages", "episodes", "episode_turns")
_EXP_STATUSES = ("verified", "candidate", "failed_attempt")
_RETIRE_BELOW = 0.1
_CONFIDENCE_MAX = 0.95


def legacy_name(table: str) -> str:
    return f"legacy_{table}_v1"


def _exists(cur: Any, schema: str, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s)", (f"{schema}.{table}",))
    return cur.fetchone()[0] is not None


def _columns(cur: Any, schema: str, table: str) -> set[str]:
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s",
        (schema, table),
    )
    return {row[0] for row in cur.fetchall()}


def is_legacy_layout(cursor: Any, schema: str = SCHEMA) -> bool:
    with tuple_cursor(cursor) as cur:
        if _exists(cur, schema, "episode_turns"):
            return True
        return bool({"time", "history"} & _columns(cur, schema, "project_entries"))


def migrate_legacy_layout(cursor: Any, ddl: str, schema: str = SCHEMA) -> dict[str, int]:
    """Convert the legacy layout in place; `ddl` is postgres_init.sql rendered for `schema`.
    Returns row counts for logging."""
    with tuple_cursor(cursor) as cur:
        _check_dimension(cur, ddl, schema)
        renamed = _rename_legacy_tables(cur, schema)
        _migrate_spaces(cur, schema)
        _migrate_topics(cur, schema)
        counts = _migrate_entries(cur, schema)
        cur.execute(ddl)  # new messages / episodes tables and the spec indexes
        if "messages" in renamed:
            counts["messages"] = _migrate_messages(cur, schema)
        if {"episodes", "episode_turns"} <= renamed and "messages" in renamed:
            counts["episodes"] = _migrate_episodes(cur, schema)
        _repoint_foreign_keys(cur, schema, renamed)
        cur.execute(f"SELECT id FROM {schema}.topics")
        refresh_topic_ranks(cur, [row[0] for row in cur.fetchall()], schema=schema)
    logger.info(f"Migrated legacy project memory layout in {schema}: {counts}")
    return counts


def _check_dimension(cur: Any, ddl: str, schema: str) -> None:
    cur.execute(
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = to_regclass(%s) AND attname = 'embedding'",
        (f"{schema}.topics",),
    )
    row = cur.fetchone()
    if row and row[0] not in ddl:
        raise ProjectDBError(
            f"{schema}.topics.embedding is {row[0]}; the configured dimension differs"
        )


def _rename_legacy_tables(cur: Any, schema: str) -> set[str]:
    """Rename the tables the spec rebuilds, and their indexes (index names are per schema)."""
    renamed = set()
    for table in LEGACY_TABLES:
        if not _exists(cur, schema, table):
            continue
        backup = legacy_name(table)
        cur.execute(f"ALTER TABLE {schema}.{table} RENAME TO {backup}")
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname = %s AND tablename = %s",
            (schema, backup),
        )
        for (index,) in cur.fetchall():
            cur.execute(f'ALTER INDEX {schema}."{index}" RENAME TO "{("legacy_v1_" + index)[:63]}"')
        renamed.add(table)
    return renamed


def _migrate_spaces(cur: Any, schema: str) -> None:
    if "cleared_at" in _columns(cur, schema, "spaces"):
        cur.execute(f"ALTER TABLE {schema}.spaces RENAME COLUMN cleared_at TO clear_time")
    cur.execute(
        f"""ALTER TABLE {schema}.spaces
            ADD COLUMN IF NOT EXISTS resource_bindings JSONB NOT NULL DEFAULT '[]'::JSONB,
            ADD COLUMN IF NOT EXISTS last_formation_time TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS formation_version BIGINT NOT NULL DEFAULT 0"""
    )
    if _exists(cur, schema, "add_space_state"):
        cur.execute(
            f"""UPDATE {schema}.spaces s SET resource_bindings = st.resource_bindings,
                    last_formation_time = st.last_formation_at,
                    formation_version = st.formation_version
                FROM {schema}.add_space_state st WHERE st.space_id = s.id"""
        )


# Source items: user_id as a list, agent_id as a string (an agent list keeps its first item).
_NORMALISED_SOURCE = """(x.s - 'user_id' - 'agent_id') || jsonb_build_object(
    'user_id', CASE jsonb_typeof(x.s->'user_id') WHEN 'array' THEN x.s->'user_id'
                    WHEN 'string' THEN jsonb_build_array(x.s->'user_id') ELSE '[]'::jsonb END,
    'agent_id', CASE jsonb_typeof(x.s->'agent_id') WHEN 'array' THEN x.s->'agent_id'->0
                     ELSE x.s->'agent_id' END)
 || CASE WHEN jsonb_typeof(x.s->'agent_id') = 'array'
         THEN jsonb_build_object('agent_ids', x.s->'agent_id') ELSE '{}'::jsonb END"""
_TIMESTAMP_TEXT = r"'^\d{4}-\d{2}-\d{2}'"


def _migrate_topics(cur: Any, schema: str) -> None:
    cur.execute(
        f"""ALTER TABLE {schema}.topics
            ADD COLUMN IF NOT EXISTS conversation_ids TEXT[] NOT NULL DEFAULT '{{}}',
            ADD COLUMN IF NOT EXISTS commit_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ALTER COLUMN create_time DROP DEFAULT,
            ALTER COLUMN update_time DROP DEFAULT"""
    )
    cur.execute(
        f"""UPDATE {schema}.topics t SET sources = COALESCE((
                SELECT jsonb_agg({_NORMALISED_SOURCE} ORDER BY x.o)
                FROM jsonb_array_elements(t.sources) WITH ORDINALITY x(s, o)
                WHERE jsonb_typeof(x.s) = 'object'), '[]'::jsonb)"""
    )
    cur.execute(
        f"""UPDATE {schema}.topics t SET
                conversation_ids = ARRAY(
                    SELECT y.c FROM (
                        SELECT x.s->>'conversation_id' AS c, min(x.o) AS o
                        FROM jsonb_array_elements(t.sources) WITH ORDINALITY x(s, o)
                        WHERE COALESCE(x.s->>'conversation_id', '') <> '' GROUP BY 1) y
                    ORDER BY y.o),
                commit_time = CASE WHEN t.extra->>'committed_at' ~ {_TIMESTAMP_TEXT}
                                   THEN (t.extra->>'committed_at')::timestamptz
                                   ELSE t.update_time END"""
    )


def _child_rows_sql(schema: str, column: str, status: int) -> str:
    return f"""
INSERT INTO {schema}.project_entries (id, topic_id, space_id, entry_type, status,
    parent_decision_id, content, chat_time, user_ids, extra, create_time, update_time)
SELECT gen_random_uuid()::text, e.topic_id, e.space_id, 'decision', {status}, e.id,
    COALESCE(x.h->>'content', ''),
    CASE WHEN x.h->>'time' ~ {_TIMESTAMP_TEXT} THEN (x.h->>'time')::timestamptz
         ELSE e.chat_time END,
    ARRAY(SELECT jsonb_array_elements_text(CASE jsonb_typeof(x.h->'user_ids')
                                           WHEN 'array' THEN x.h->'user_ids'
                                           ELSE '[]'::jsonb END)),
    jsonb_strip_nulls(x.h - 'id' - 'content' - 'time' - 'user_ids' - 'embedding'),
    e.create_time, e.update_time
FROM {schema}.project_entries e
CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(e.{column})
                                        WHEN 'array' THEN e.{column} ELSE '[]'::jsonb END) x(h)
WHERE e.entry_type = 'decision' AND jsonb_typeof(x.h) = 'object'"""


def _migrate_entries(cur: Any, schema: str) -> dict[str, int]:
    table = f"{schema}.project_entries"
    columns = _columns(cur, schema, "project_entries")
    if "time" in columns:
        cur.execute(f"ALTER TABLE {table} RENAME COLUMN time TO chat_time")
    cur.execute(
        f"""ALTER TABLE {table}
            ADD COLUMN IF NOT EXISTS status SMALLINT NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS parent_decision_id TEXT"""
    )
    counts = {"history_rows": 0, "conflict_rows": 0}
    for column, status, key in (("history", 1, "history_rows"), ("conflicts", 2, "conflict_rows")):
        if column in columns:
            cur.execute(_child_rows_sql(schema, column, status))
            counts[key] = cur.rowcount
            cur.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
    counts["retired_experiences"] = _normalise_entry_extras(cur, schema)
    # The old index definitions name the same indexes; the spec DDL recreates them.
    cur.execute(f"DROP INDEX IF EXISTS {schema}.idx_entries_topic, {schema}.idx_entries_space_type")
    cur.execute(
        f"""ALTER TABLE {table}
            ADD CONSTRAINT project_entries_entry_type_check
                CHECK (entry_type IN ('decision', 'experience', 'timeline')),
            ADD CONSTRAINT project_entries_status_check CHECK (status IN (0, 1, 2)),
            ADD CONSTRAINT project_entries_topic_id_id_key UNIQUE (topic_id, id),
            ADD CONSTRAINT project_entries_topic_id_parent_decision_id_fkey
                FOREIGN KEY (topic_id, parent_decision_id)
                REFERENCES {table} (topic_id, id) ON DELETE CASCADE,
            ADD CONSTRAINT project_entries_check CHECK (status <> 2 OR entry_type = 'decision'),
            ADD CONSTRAINT project_entries_check1
                CHECK ((entry_type = 'decision' AND status <> 0) = (parent_decision_id IS NOT NULL))"""
    )
    return counts


def _normalise_entry_extras(cur: Any, schema: str) -> int:
    """Decision extra.source -> extra.sources; experience extras to ExperienceExtra.
    Returns the number of retired experiences."""
    from psycopg2.extras import execute_values

    cur.execute(
        f"""SELECT id, entry_type, content, extra FROM {schema}.project_entries
            WHERE parent_decision_id IS NULL AND entry_type IN ('decision', 'experience')"""
    )
    updates, retired = [], 0
    for entry_id, entry_type, content, extra in cur.fetchall():
        status = 0
        if entry_type == "decision":
            new = _decision_extra(extra)
        else:
            new, status = _experience_extra(extra, content)
            retired += status
        if new != extra or status:
            updates.append((entry_id, json.dumps(new), status))
    if updates:
        execute_values(
            cur,
            f"""UPDATE {schema}.project_entries e SET extra = v.extra::jsonb,
                    status = v.status::smallint
                FROM (VALUES %s) AS v(id, extra, status) WHERE e.id = v.id""",
            updates,
        )
    return retired


def _decision_extra(extra: dict) -> dict:
    extra = dict(extra or {})
    if "source" in extra and "sources" not in extra:
        source = extra.pop("source")
        extra["sources"] = [source] if isinstance(source, dict) else []
    return extra


def _experience_source(raw: Any) -> dict:
    """One evidence item in the ExperienceSource shape; unusable values move to legacy_*."""
    source = dict(raw) if isinstance(raw, dict) else {"legacy_value": raw}
    if source.get("segment_id") and not source.get("episode_id"):
        source["episode_id"] = source["segment_id"]
    for field in ExperienceSource.model_fields:
        if field not in source:
            continue
        try:
            ExperienceSource.model_validate({field: source[field]})
        except ValidationError:
            source[f"legacy_{field}"] = source.pop(field)
            if source[f"legacy_{field}"] in ("", None):
                del source[f"legacy_{field}"]
    return source


def _experience_extra(extra: dict, content: str) -> tuple[dict, int]:
    """(ExperienceExtra-shaped extra, status); confidence < 0.1 retires the experience."""
    extra = dict(extra or {})
    status_value = extra.get("exp_status") or extra.get("status")
    extra["exp_status"] = status_value if status_value in _EXP_STATUSES else "candidate"
    try:
        confidence = float(extra.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    retired = int(confidence < _RETIRE_BELOW)
    if not _RETIRE_BELOW <= confidence <= _CONFIDENCE_MAX:
        extra["legacy_confidence"] = confidence
        confidence = min(max(confidence, _RETIRE_BELOW), _CONFIDENCE_MAX)
    extra["confidence"] = confidence
    card = extra.get("card") or extra.get("info") or {}
    card = dict(card) if isinstance(card, dict) else {}
    for key, fallback in (("task_intent", content), ("problem", ""), ("principle", "")):
        card[key] = str(card.get(key) or fallback)
    for key in ("technical_context", "failed_shape", "validation"):
        if card.get(key) is not None and not isinstance(card[key], str):
            card[key] = json.dumps(card[key], ensure_ascii=False)
    anchors = card.get("anchors")
    card["anchors"] = [str(a) for a in anchors] if isinstance(anchors, list) else []
    extra["card"] = card
    sources = extra.get("sources")
    extra["sources"] = [_experience_source(s) for s in sources] if isinstance(sources, list) else []
    try:
        ExperienceExtra.model_validate(extra)
    except ValidationError as e:  # keep the row; reads of it will fail loudly
        logger.warning(f"Migrated experience extra still invalid: {e}")
    return extra, retired


def _migrate_messages(cur: Any, schema: str) -> int:
    cur.execute(
        f"""INSERT INTO {schema}.messages (project_id, conversation_key, message_id, msg_seq,
                role, role_id, role_name, agent_id, content, tool_calls, tool_call_id,
                chat_time, accept_time, task_id, experience_notes, content_sha256)
            SELECT project_id, conversation_key, message_id,
                row_number() OVER (PARTITION BY project_id, conversation_key
                                   ORDER BY turn_seq, msg_seq, accepted_at, message_id),
                role, COALESCE(role_id, CASE WHEN role = 'user' THEN user_id END), role_name,
                CASE jsonb_typeof(agent_id) WHEN 'string' THEN agent_id #>> '{{}}'
                                            WHEN 'array' THEN agent_id->>0 END,
                content, tool_calls, tool_call_id, chat_time, accepted_at, task_id,
                experience_notes, content_sha256
            FROM {schema}.{legacy_name("messages")}"""
    )
    return cur.rowcount


def _migrate_episodes(cur: Any, schema: str) -> int:
    s = schema
    cur.execute(
        f"""WITH spans AS (
                SELECT et.episode_id, min(m.msg_seq) AS seq_start, max(m.msg_seq) AS seq_end,
                       min(et.accepted_at) AS accepted,
                       (array_agg(m.chat_time ORDER BY m.msg_seq))[1] AS first_chat,
                       (array_agg(m.chat_time ORDER BY m.msg_seq DESC))[1] AS last_chat
                FROM {s}.{legacy_name("episode_turns")} et
                JOIN {s}.{legacy_name("messages")} lm
                  ON lm.project_id = et.project_id AND lm.conversation_key = et.conversation_key
                 AND lm.turn_id = et.turn_id
                JOIN {s}.messages m
                  ON m.project_id = lm.project_id AND m.conversation_key = lm.conversation_key
                 AND m.message_id = lm.message_id
                GROUP BY et.episode_id),
            candidates AS (
                SELECT le.*, sp.seq_start, sp.seq_end, sp.accepted, sp.first_chat, sp.last_chat,
                       max(sp.seq_end) OVER (
                           PARTITION BY le.space_id, le.conversation_key
                           ORDER BY sp.seq_start, le.id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end
                FROM {s}.{legacy_name("episodes")} le JOIN spans sp ON sp.episode_id = le.id),
            kept AS (
                SELECT * FROM candidates
                WHERE previous_end IS NULL OR previous_end < seq_start)
            INSERT INTO {s}.episodes (id, space_id, conversation_key, message_seq_start,
                message_seq_end, previous_episode_id, topic_id, episode_summary,
                first_chat_time, last_chat_time, embedding, create_time)
            SELECT k.id, k.space_id, k.conversation_key, k.seq_start, k.seq_end,
                CASE WHEN k.previous_episode_id IN (SELECT id FROM kept)
                     THEN k.previous_episode_id END,
                (SELECT t.id FROM {s}.topics t
                 WHERE t.id = COALESCE(k.moved_to_topic_id, k.result->'topic_ids'->>0)),
                k.episode_summary, k.first_chat, k.last_chat, k.staged_embedding,
                COALESCE(k.accepted, k.opened_at)
            FROM kept k"""
    )
    return cur.rowcount


def _repoint_foreign_keys(cur: Any, schema: str, renamed: set[str]) -> None:
    """Foreign keys of other tables that followed a renamed table now point at the new one."""
    if not renamed:
        return
    backups = {legacy_name(t): t for t in renamed}
    cur.execute(
        """SELECT c.conname, c.conrelid::regclass::text, r.relname,
                  pg_get_constraintdef(c.oid)
           FROM pg_constraint c
           JOIN pg_class r ON r.oid = c.confrelid
           JOIN pg_namespace n ON n.oid = r.relnamespace
           JOIN pg_class o ON o.oid = c.conrelid
           WHERE c.contype = 'f' AND n.nspname = %s AND r.relname = ANY(%s)
             AND NOT (o.relname = ANY(%s))""",
        (schema, list(backups), list(backups)),
    )
    for name, owner, backup, definition in cur.fetchall():
        new_definition = definition.replace(f"{backup}(", f"{backups[backup]}(")
        cur.execute("SAVEPOINT repoint_fk")
        try:
            cur.execute(f'ALTER TABLE {owner} DROP CONSTRAINT "{name}"')
            cur.execute(f'ALTER TABLE {owner} ADD CONSTRAINT "{name}" {new_definition} NOT VALID')
            cur.execute("RELEASE SAVEPOINT repoint_fk")
        except Exception as e:
            cur.execute("ROLLBACK TO SAVEPOINT repoint_fk")
            logger.warning(f"Could not re-point {owner}.{name} from {backup}: {e}")
