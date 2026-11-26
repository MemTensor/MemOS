"""Shared PostgreSQL storage for project memory and its Add stages.

Add reads and writes the shared tables of `memos.project_dbs` (spaces, domains, topics,
project_entries, messages, episodes) plus its own `add_jobs` and `add_episode_events`. An Episode
is a `messages.msg_seq` range of one conversation in one Space (`episodes`); its progress
through the stages is its `add_jobs` row. `load_episode` / `read_staged` return one dict per
Episode joining both rows, with Add's state from `add_jobs.organize_result` lifted to
top-level keys (see `episode_view`).

organize_result keys kept across stage hand-offs (PERSISTENT_KEYS); every other key is the
transient hand-off of the current stage (work lease, plan, changeset, retry counters, the
`queued` flag of an Episode waiting for an organize worker, `dispatched_at`):

- task_ranges   {task_id: [seq_start, seq_end]}: the messages each Add request (Task) put in
                this Episode; per-Task ownership for status, metrics, witnesses and replays;
- task_owners   {task_id: {"user_id", "accepted_at"}}: the caller and acceptance time of each;
- close         {"reason", "at"}: why and when the Episode was closed;
- extraction    {"at", "status", "anchors", "anchor_keys"}: the extraction result besides the
                drafts (add_jobs.drafts) and the summary (episodes.episode_summary);
- boundary      {"starts", "continues_previous", "judged", "reasons"}: the boundary judgment;
- receipt       {"commit_key", "outcome", "topic_ids", "created_topic_ids", "warnings"}: the
                commit receipt; add_jobs.topic_ids holds the same topic ids;
- staged        {"status", "domain", "reason", "at", "attempts", "moved_to"}: Default Topic
                state; status active (outcome staged), moved (outcome committed,
                episodes.topic_id set), archived / long_unassigned (outcome skipped);
- last_error    the last retryable error (PipelineError shape); add_jobs.error is the final one;
- warnings      warnings raised before the commit (e.g. BOUNDARY_MODEL_UNAVAILABLE).
"""

from __future__ import annotations

from contextlib import contextmanager
from itertools import pairwise
from typing import TYPE_CHECKING, Any

from memos.project_dbs.postgres import _INIT_LOCK_KEY as INIT_LOCK_KEY
from memos.project_dbs.postgres import install_schema, render_ddl

from .add_layout import ADD_TABLES, aware_time, load_topics


if TYPE_CHECKING:
    from collections.abc import Iterator, Sequence
    from datetime import datetime


PERSISTENT_KEYS = (
    "task_ranges",
    "task_owners",
    "close",
    "extraction",
    "boundary",
    "receipt",
    "staged",
    "last_error",
    "warnings",
)
# organize_result reduced to its persistent keys; bind list(PERSISTENT_KEYS) as the parameter.
KEEP_PERSISTENT = """(SELECT COALESCE(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
    FROM jsonb_each(COALESCE(organize_result, '{}'::jsonb)) kv WHERE kv.key = ANY(%s::text[]))"""

EPISODE_COLUMNS = """e.id, e.space_id, e.conversation_key, e.message_seq_start, e.message_seq_end,
       e.previous_episode_id, e.topic_id, e.episode_summary, e.first_chat_time, e.last_chat_time,
       e.create_time, j.project_id, j.user_id, j.task_ids, j.domains, j.stage, j.outcome,
       j.attempt, j.accept_time, j.close_due_time, j.next_retry_time, j.drafts,
       j.organize_result, j.topic_ids, j.error, j.update_time"""
EPISODE_FROM = "episodes e JOIN add_jobs j ON j.episode_id = e.id"


def json_value(value: Any) -> Any:
    """Bind a Python value as JSONB through the optional PostgreSQL driver."""
    from psycopg2.extras import Json

    return Json(value)


def _parsed(value: Any) -> datetime | None:
    return aware_time(value) if value else None


def conversation_id_of(conversation_key: str) -> str | None:
    """The caller's conversation id; requests without one use a `task:` key."""
    return None if conversation_key.startswith("task:") else conversation_key


def episode_view(row: dict[str, Any]) -> dict[str, Any]:
    """One Episode as the Add stages read it: the episodes and add_jobs columns plus the
    persistent organize_result keys lifted to the top level, under their historical names."""
    data = dict(row.get("organize_result") or {})
    kept = {key: data.pop(key) for key in PERSISTENT_KEYS if key in data}
    close = kept.get("close") or {}
    extraction = kept.get("extraction") or {}
    receipt = kept.get("receipt") or {}
    staged = kept.get("staged") or {}
    if row["stage"] == "episode_open":
        state = "open"
    elif extraction.get("at"):
        state = "extracted"
    else:
        state = "closed"
    return {
        **row,
        "organize_result": data,
        "conversation_id": conversation_id_of(row["conversation_key"]),
        "state": state,
        "opened_at": row["create_time"],
        "last_turn_at": row["last_chat_time"],
        "next_retry_at": row["next_retry_time"],
        "updated_at": row["update_time"],
        "task_ranges": kept.get("task_ranges") or {},
        "task_owners": kept.get("task_owners") or {},
        "close_reason": close.get("reason"),
        "closed_at": _parsed(close.get("at")),
        "extracted_at": _parsed(extraction.get("at")),
        "extract_status": extraction.get("status"),
        "anchors": extraction.get("anchors") or [],
        "anchor_keys": extraction.get("anchor_keys") or [],
        "boundary": kept.get("boundary"),
        "commit_key": receipt.get("commit_key"),
        "result": {**receipt, "topic_ids": list(row["topic_ids"] or [])},
        "created_topic_ids": receipt.get("created_topic_ids") or [],
        "warnings": kept.get("warnings") or [],
        "last_error": kept.get("last_error"),
        "staged_status": staged.get("status"),
        "staged_domain": staged.get("domain"),
        "staged_reason": staged.get("reason"),
        "staged_at": _parsed(staged.get("at")),
        "staged_attempts": int(staged.get("attempts") or 0),
        "moved_to_topic_id": staged.get("moved_to"),
    }


def task_at(task_ranges: dict[str, list[int]], seq: int) -> str | None:
    """The Task whose range in this Episode holds message `seq`."""
    for task_id, (start, end) in task_ranges.items():
        if start <= seq <= end:
            return task_id
    return None


def turn_starts(messages: list[dict[str, Any]]) -> list[int]:
    """Indexes where a Turn starts: a user message (or the first message) begins a Turn and the
    following non-user messages belong to it; system messages never start one."""
    starts: list[int] = []
    has_content = False
    for index, message in enumerate(messages):
        if not starts:
            starts.append(index)
        elif message["role"] == "user" and has_content:
            starts.append(index)
            has_content = False
        has_content = has_content or message["role"] != "system"
    return starts


def annotate_messages(episode: dict[str, Any], messages: list[dict[str, Any]]) -> list[dict]:
    """Messages in msg_seq order with their Turn, owning Task and the Task's caller."""
    out = [dict(message) for message in messages]
    bounds = [*turn_starts(out), len(out)]
    ranges = episode.get("task_ranges") or {}
    owners = episode.get("task_owners") or {}
    fallback = (episode.get("task_ids") or [None])[0]
    for begin, end in pairwise(bounds):
        group = out[begin:end]
        source = next((m for m in group if m["role"] != "system"), group[0])
        for message in group:
            task = task_at(ranges, message["msg_seq"]) or fallback
            owner = owners.get(task) or {}
            message.update(
                turn_id=source["message_id"],
                origin_task_id=task,
                origin_user_id=owner.get("user_id") or episode.get("user_id"),
                accepted_at=message["accept_time"],
                conversation_id=conversation_id_of(message["conversation_key"]),
            )
    return out


def episode_turns(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The Turns of annotated messages: id, owning Task and caller, message count and range."""
    turns: dict[str, dict[str, Any]] = {}
    for message in messages:
        turn = turns.get(message["turn_id"])
        if turn is None:
            turn = turns[message["turn_id"]] = {
                "turn_id": message["turn_id"],
                "task_id": message["origin_task_id"],
                "user_id": message["origin_user_id"],
                "agent_id": message.get("agent_id"),
                "chat_time": message["chat_time"],
                "accepted_at": message["accept_time"],
                "seq_start": message["msg_seq"],
                "message_count": 0,
            }
        turn["message_count"] += 1
        turn["seq_end"] = message["msg_seq"]
        if message["message_id"] == message["turn_id"]:
            turn.update(task_id=message["origin_task_id"], chat_time=message["chat_time"])
    return list(turns.values())


def record_event(
    cursor: Any,
    project_id: str | None,
    episode_id: str,
    event: str,
    at: Any | None = None,
    *,
    stage: str | None = None,
    attempt: int | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append one Episode lifecycle event in the caller's transaction (database clock if no time).

    Without a project the Episode's own project is used; the store serves every project.
    """
    cursor.execute(
        """INSERT INTO add_episode_events (project_id, episode_id, event, at, stage, attempt, detail)
           SELECT COALESCE(%s, j.project_id), j.episode_id, %s, COALESCE(%s, clock_timestamp()),
                  %s, %s, %s
           FROM add_jobs j WHERE j.episode_id = %s""",
        (project_id, event, at, stage, attempt, json_value(detail or {}), episode_id),
    )


def read_space(cursor: Any, space_id: str, *, lock: bool = False) -> dict[str, Any] | None:
    """A Space row with Add's Formation state under its historical names, and the database
    clock. `staged_since_last_formation` counts the Episodes staged after the last Formation
    (Formation stamps its own changes and spaces.last_formation_time with one clock)."""
    cursor.execute(
        f"""SELECT s.*, s.clear_time AS cleared_at, s.last_formation_time AS last_formation_at,
                   (SELECT COUNT(*) FROM add_jobs j
                     WHERE j.space_id = s.id AND j.outcome = 'staged'
                       AND (s.last_formation_time IS NULL
                            OR j.update_time > s.last_formation_time))
                   AS staged_since_last_formation,
                   clock_timestamp() AS commit_clock
            FROM spaces s WHERE s.id = %s {"FOR UPDATE OF s" if lock else ""}""",
        (space_id,),
    )
    return cursor.fetchone()


class PostgresAddStore:
    """A connection pool over the shared project memory schema.

    The store serves every project: a row's project comes from the request or from the Space
    that owns it, never from the process environment."""

    def __init__(self, config: dict[str, Any], *, pool: Any | None = None) -> None:
        try:
            from psycopg2 import sql
            from psycopg2.extras import RealDictCursor
            from psycopg2.pool import ThreadedConnectionPool
        except ImportError as exc:
            raise ImportError("Project memory Add requires the psycopg2 PostgreSQL driver") from exc

        self.schema_name = config.get("schema_name") or "project_memory"
        self.dim = int(config.get("embedding_dimension") or 1024)
        self.retrieval_index = bool(config.get("retrieval_index"))
        # The shared schema's full-text configuration; zhparser in production, simple in tests.
        self.text_search_parser = config.get("text_search_parser") or "simple"
        if self.text_search_parser not in ("simple", "zhparser"):
            raise ValueError("Text search parser must be zhparser or simple")
        self.text_search_config = f"{self.schema_name}.zh"
        if not 1 <= self.dim <= 16000:
            raise ValueError("Project memory embedding dimension must be between 1 and 16000")
        self._search_path = sql.SQL("SET LOCAL search_path TO {}, public").format(
            sql.Identifier(self.schema_name)
        )
        self._cursor_factory = RealDictCursor
        dsn = config.get("dsn")
        parameters = (
            {"dsn": dsn}
            if dsn
            else {
                "host": config.get("host", "localhost"),
                "port": int(config.get("port", 5432)),
                "user": config.get("user", "postgres"),
                "password": config.get("password", ""),
                "dbname": config.get("db_name", "postgres"),
            }
        )
        self._owns_pool = pool is None
        self.pool = (
            pool
            if pool is not None
            else ThreadedConnectionPool(1, int(config.get("max_connections", 10)), **parameters)
        )
        try:
            with self.transaction() as cursor:
                # Same lock as memos.project_dbs, so the two installers never race.
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", (INIT_LOCK_KEY,))
                self._install(cursor, sql)
        except Exception:
            self.close()
            raise

    def _install(self, cursor: Any, sql: Any) -> None:
        """Create what is missing. A shared deployment installs the schema with a privileged
        account; later starts need no DDL privileges unless an upgrade added an Add-owned table,
        which the first start after the upgrade creates. A pre-spec layout is migrated in place
        by `memos.project_dbs.postgres.install_schema`."""
        cursor.execute(
            """SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
               WHERE c.cfgname = 'zh' AND n.nspname = %s""",
            (self.schema_name,),
        )
        # An installed zh configuration is used as is, whatever parser it was created with.
        zh_installed = cursor.fetchone() is not None
        needs_parser = self.text_search_parser == "zhparser" and not zh_installed
        # vector: embedding columns; btree_gist: the EXCLUDE constraint on Episode ranges.
        required = ["vector", "btree_gist"] + (["zhparser"] if needs_parser else [])
        cursor.execute("SELECT extname FROM pg_extension WHERE extname = ANY(%s)", (required,))
        missing = sorted(set(required) - {row["extname"] for row in cursor.fetchall()})
        if missing:
            raise RuntimeError(
                f"PostgreSQL extensions {missing} are not installed; run CREATE EXTENSION with a "
                "privileged account (vector and btree_gist are required), or set "
                "PROJECT_DB_TEXT_SEARCH_PARSER=simple without zhparser"
            )

        def present(name: str) -> bool:
            cursor.execute("SELECT to_regclass(%s) AS present", (f"{self.schema_name}.{name}",))
            return cursor.fetchone()["present"] is not None

        cursor.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", (self.schema_name,))
        if cursor.fetchone() is None:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema_name)))
        # Same DDL, guard and migration as memos.project_dbs, so either side may install it.
        install_schema(
            cursor,
            render_ddl(self.dim, self.text_search_parser, schema=self.schema_name),
            self.schema_name,
        )
        cursor.execute(
            """SELECT atttypmod FROM pg_attribute
               WHERE attrelid = to_regclass(%s) AND attname = 'embedding'""",
            (f"{self.schema_name}.topics",),
        )
        installed = cursor.fetchone()
        if installed and installed["atttypmod"] > 0 and installed["atttypmod"] != self.dim:
            raise RuntimeError(
                f"{self.schema_name}.topics stores {installed['atttypmod']}-dimension vectors; "
                f"the embedder is configured for {self.dim}"
            )
        if not present("add_jobs") or not present("add_episode_events"):
            cursor.execute(ADD_TABLES)
        if present("add_space_state"):
            # Formation state now lives on spaces (resource_bindings, last_formation_time,
            # formation_version); copy what the layout migration has not, then drop the table.
            cursor.execute(
                """UPDATE spaces s SET resource_bindings = st.resource_bindings,
                          last_formation_time = st.last_formation_at,
                          formation_version = st.formation_version
                   FROM add_space_state st
                   WHERE st.space_id = s.id AND s.formation_version < st.formation_version"""
            )
            cursor.execute("DROP TABLE add_space_state")
        if self.retrieval_index:
            from .add_publish import install

            install(cursor)

    @contextmanager
    def transaction(self, *, readonly: bool = False) -> Iterator[Any]:
        """Yield a dictionary cursor and commit all writes as one unit."""
        connection = self.pool.getconn()
        try:
            with connection, connection.cursor(cursor_factory=self._cursor_factory) as cursor:
                if readonly:
                    cursor.execute("SET TRANSACTION READ ONLY")
                cursor.execute(self._search_path)
                yield cursor
        finally:
            self.pool.putconn(connection)

    def close(self) -> None:
        if self._owns_pool:
            self.pool.closeall()

    # ---------- spaces ----------
    def read_space(self, space_id: str) -> dict[str, Any] | None:
        with self.transaction(readonly=True) as cursor:
            return read_space(cursor, space_id)

    # ---------- Episodes ----------
    def load_episode(self, episode_id: str) -> dict[str, Any] | None:
        """Load an Episode with its messages and Turns, and its predecessor likewise."""
        with self.transaction(readonly=True) as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            episode = load_episode(cursor, episode_id)
            if episode is not None:
                previous_id = episode["previous_episode_id"]
                episode["previous"] = load_episode(cursor, previous_id) if previous_id else None
            return episode

    def record_event(
        self, episode_id: str, event: str, at: Any | None = None, **fields: Any
    ) -> None:
        with self.transaction() as cursor:
            record_event(cursor, None, episode_id, event, at, **fields)

    # ---------- Topics ----------
    def read_topics(
        self,
        space_id: str,
        domains: Sequence[str] | None = None,
        *,
        topic_ids: Sequence[str] | None = None,
    ) -> list[dict[str, Any]]:
        with self.transaction(readonly=True) as cursor:
            return load_topics(
                cursor,
                """t.space_id = %s
                   AND (%s::text[] IS NULL OR d.domain = ANY(%s::text[]))
                   AND (%s::text[] IS NULL OR t.id = ANY(%s::text[]))""",
                (
                    space_id,
                    None if domains is None else list(domains),
                    None if domains is None else list(domains),
                    None if topic_ids is None else list(topic_ids),
                    None if topic_ids is None else list(topic_ids),
                ),
            )

    # ---------- Default Topic ----------
    def staged_space_ids(self) -> list[str]:
        """Spaces that still hold staged Episodes awaiting Formation."""
        with self.transaction(readonly=True) as cursor:
            cursor.execute(
                "SELECT DISTINCT space_id FROM add_jobs WHERE outcome = 'staged' ORDER BY space_id"
            )
            return [row["space_id"] for row in cursor.fetchall()]

    def staged_count(self, space_id: str) -> int:
        """Staged Episodes of a Space, without the read_staged page limit."""
        with self.transaction(readonly=True) as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS n FROM add_jobs WHERE space_id = %s AND outcome = 'staged'",
                (space_id,),
            )
            return int(cursor.fetchone()["n"])

    def unfinished_episode_ids(self, space_id: str) -> list[str]:
        """Closed Episodes of a Space that are still moving through the Add stages."""
        with self.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT episode_id FROM add_jobs
                   WHERE space_id = %s AND outcome = 'pending' AND stage <> 'episode_open'
                   ORDER BY episode_id""",
                (space_id,),
            )
            return [row["episode_id"] for row in cursor.fetchall()]

    def read_staged(self, space_id: str, limit: int = 50) -> list[dict[str, Any]]:
        """Staged Episodes, latest conversation time first, with their Turn count and where
        their predecessor went."""
        with self.transaction(readonly=True) as cursor:
            cursor.execute(
                f"""SELECT {EPISODE_COLUMNS},
                           (SELECT COUNT(*) FROM messages m
                             WHERE m.project_id = j.project_id
                               AND m.conversation_key = e.conversation_key
                               AND m.msg_seq BETWEEN e.message_seq_start AND e.message_seq_end
                               AND m.role = 'user') AS turn_count,
                           p.topic_id AS previous_topic_id, pj.topic_ids AS previous_topic_ids,
                           pj.organize_result->'staged' AS previous_staged
                    FROM {EPISODE_FROM}
                      LEFT JOIN episodes p ON p.id = e.previous_episode_id
                      LEFT JOIN add_jobs pj ON pj.episode_id = p.id
                    WHERE j.space_id = %s AND j.outcome = 'staged'
                    ORDER BY e.last_chat_time DESC, e.id LIMIT %s""",
                (space_id, limit),
            )
            rows = cursor.fetchall()
        staged = []
        for row in rows:
            previous_topic = row.pop("previous_topic_id")
            previous_receipt = row.pop("previous_topic_ids")
            previous_staged = row.pop("previous_staged") or {}
            episode = episode_view(row)
            episode["previous"] = (
                {
                    "topic_id": previous_topic,
                    "result": {"topic_ids": list(previous_receipt or [])},
                    "staged_status": previous_staged.get("status"),
                    "moved_to_topic_id": previous_staged.get("moved_to"),
                }
                if row["previous_episode_id"]
                else None
            )
            staged.append(episode)
        return staged


def load_episode(cursor: Any, episode_id: str, *, lock: bool = False) -> dict[str, Any] | None:
    """One Episode view with its messages (annotated, msg_seq order) and Turns; `lock` takes the
    add_jobs row FOR UPDATE."""
    cursor.execute(
        f"""SELECT {EPISODE_COLUMNS}, s.instructions, s.resource_bindings,
                   s.clear_time AS cleared_at, tp.topic_name
            FROM {EPISODE_FROM} JOIN spaces s ON s.id = e.space_id
              LEFT JOIN topics tp ON tp.id = e.topic_id
            WHERE e.id = %s {"FOR UPDATE OF j" if lock else ""}""",
        (episode_id,),
    )
    row = cursor.fetchone()
    if row is None:
        return None
    episode = episode_view(row)
    cursor.execute(
        """SELECT * FROM messages
           WHERE project_id = %s AND conversation_key = %s AND msg_seq BETWEEN %s AND %s
           ORDER BY msg_seq""",
        (
            episode["project_id"],
            episode["conversation_key"],
            episode["message_seq_start"],
            episode["message_seq_end"],
        ),
    )
    episode["messages"] = annotate_messages(episode, cursor.fetchall())
    episode["turns"] = episode_turns(episode["messages"])
    episode["owner_task_id"] = (
        episode["turns"][0]["task_id"] if episode["turns"] else (episode["task_ids"] or [None])[0]
    )
    return episode
