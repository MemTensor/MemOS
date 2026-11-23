"""Shared PostgreSQL storage for project memory and its Add stages."""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from memos.project_dbs.postgres import _INIT_LOCK_KEY as INIT_LOCK_KEY

from .add_layout import ADD_TABLES, SPACE_STATE, load_topics, render_shared_ddl


if TYPE_CHECKING:
    from collections.abc import Iterator, Sequence


def json_value(value: Any) -> Any:
    """Bind a Python value as JSONB through the optional PostgreSQL driver."""
    from psycopg2.extras import Json

    return Json(value)


def record_event(
    cursor: Any,
    project_id: str,
    episode_id: str,
    event: str,
    at: Any | None = None,
    *,
    stage: str | None = None,
    attempt: int | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append one Episode lifecycle event in the caller's transaction (database clock if no time)."""
    cursor.execute(
        """INSERT INTO add_episode_events (project_id, episode_id, event, at, stage, attempt, detail)
           VALUES (%s, %s, %s, COALESCE(%s, clock_timestamp()), %s, %s, %s)""",
        (project_id, episode_id, event, at, stage, attempt, json_value(detail or {})),
    )


class PostgresAddStore:
    """A connection pool with an explicit project scope for each store instance."""

    def __init__(self, config: dict[str, Any], *, project_id: str) -> None:
        try:
            from psycopg2 import sql
            from psycopg2.extras import RealDictCursor
            from psycopg2.pool import ThreadedConnectionPool
        except ImportError as exc:
            raise ImportError("Project memory Add requires the psycopg2 PostgreSQL driver") from exc

        if not project_id.strip():
            raise ValueError("Project memory Add requires a trusted project ID")
        self.project_id = project_id
        self.schema_name = config.get("schema_name") or "project_memory"
        self.dim = int(config.get("embedding_dimension") or 1024)
        self.retrieval_index = bool(config.get("retrieval_index"))
        # The shared schema's full-text configuration; zhparser in production, simple in tests.
        self.text_search_parser = config.get("text_search_parser") or "simple"
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
        self.pool = ThreadedConnectionPool(1, int(config.get("max_connections", 10)), **parameters)
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
        account; on later starts nothing here needs DDL privileges."""
        cursor.execute(
            """SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
               WHERE c.cfgname = 'zh' AND n.nspname = %s""",
            (self.schema_name,),
        )
        # An installed zh configuration is used as is, whatever parser it was created with.
        zh_installed = cursor.fetchone() is not None
        needs_parser = self.text_search_parser == "zhparser" and not zh_installed
        required = ["vector"] + (["zhparser"] if needs_parser else [])
        cursor.execute("SELECT extname FROM pg_extension WHERE extname = ANY(%s)", (required,))
        missing = sorted(set(required) - {row["extname"] for row in cursor.fetchall()})
        if missing:
            raise RuntimeError(
                f"PostgreSQL extensions {missing} are not installed; run CREATE EXTENSION with a "
                "privileged account, or set PROJECT_DB_TEXT_SEARCH_PARSER=simple without zhparser"
            )

        def present(name: str) -> bool:
            cursor.execute("SELECT to_regclass(%s) AS present", (f"{self.schema_name}.{name}",))
            return cursor.fetchone()["present"] is not None

        cursor.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", (self.schema_name,))
        if cursor.fetchone() is None:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema_name)))
        if not present("project_entries"):
            if present("topics"):
                raise RuntimeError(
                    f"Schema {self.schema_name} has an older project memory layout; "
                    "migrate it or use another PROJECT_MEMORY_POSTGRES_SCHEMA"
                )
            # Same DDL and guard as memos.project_dbs, so either side may install it.
            cursor.execute(render_shared_ddl(self.schema_name, self.dim, self.text_search_parser))
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
        if not present("add_space_state") or not present("add_episode_events"):
            cursor.execute(ADD_TABLES)
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
        self.pool.closeall()

    def read_space(self, space_id: str) -> dict[str, Any] | None:
        with self.transaction(readonly=True) as cursor:
            cursor.execute(
                f"""SELECT s.*, {SPACE_STATE} FROM spaces s
                      LEFT JOIN add_space_state st ON st.space_id = s.id
                    WHERE s.project_id = %s AND s.id = %s""",
                (self.project_id, space_id),
            )
            return cursor.fetchone()

    def load_episode(self, episode_id: str) -> dict[str, Any] | None:
        """Load a current Episode and its nearest predecessor, with per-Space Turn provenance."""
        with self.transaction(readonly=True) as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            episode = self._load_episode(cursor, episode_id)
            if episode is not None:
                previous_id = episode["previous_episode_id"]
                episode["previous"] = (
                    self._load_episode(cursor, previous_id) if previous_id else None
                )
            return episode

    def _load_episode(self, cursor: Any, episode_id: str) -> dict[str, Any] | None:
        cursor.execute(
            """SELECT e.*, s.instructions, COALESCE(st.resource_bindings, '[]'::jsonb)
                      AS resource_bindings, s.cleared_at
               FROM episodes e JOIN spaces s ON s.id = e.space_id AND s.project_id = e.project_id
                 LEFT JOIN add_space_state st ON st.space_id = s.id
               WHERE e.project_id = %s AND e.id = %s""",
            (self.project_id, episode_id),
        )
        episode = cursor.fetchone()
        if episode is None:
            return None
        cursor.execute(
            """SELECT * FROM episode_turns
               WHERE project_id = %s AND episode_id = %s ORDER BY turn_seq, turn_id""",
            (self.project_id, episode_id),
        )
        turns = cursor.fetchall()
        cursor.execute(
            """SELECT m.*, et.task_id AS origin_task_id, et.user_id AS origin_user_id,
                      et.accepted_at AS origin_accepted_at
               FROM episode_turns et JOIN messages m USING (project_id, conversation_key, turn_id)
               WHERE et.project_id = %s AND et.episode_id = %s
               ORDER BY et.turn_seq, m.msg_seq, m.message_id""",
            (self.project_id, episode_id),
        )
        episode["messages"] = cursor.fetchall()
        episode["turns"] = turns
        episode["owner_task_id"] = turns[0]["task_id"] if turns else None
        return episode

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
                """s.project_id = %s AND t.space_id = %s
                   AND (%s::text[] IS NULL OR d.domain = ANY(%s::text[]))
                   AND (%s::text[] IS NULL OR t.id = ANY(%s::text[]))""",
                (
                    self.project_id,
                    space_id,
                    None if domains is None else list(domains),
                    None if domains is None else list(domains),
                    None if topic_ids is None else list(topic_ids),
                    None if topic_ids is None else list(topic_ids),
                ),
            )

    def record_event(
        self, episode_id: str, event: str, at: Any | None = None, **fields: Any
    ) -> None:
        with self.transaction() as cursor:
            record_event(cursor, self.project_id, episode_id, event, at, **fields)

    def read_staged(self, space_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT e.*, (SELECT COUNT(*) FROM episode_turns et
                                  WHERE et.project_id = e.project_id AND et.episode_id = e.id) AS turn_count,
                          CASE WHEN p.id IS NOT NULL THEN jsonb_build_object(
                              'result', p.result, 'staged_status', p.staged_status,
                              'moved_to_topic_id', p.moved_to_topic_id
                          ) END AS previous
                   FROM (
                       SELECT * FROM episodes
                       WHERE project_id = %s AND space_id = %s AND staged_status = 'active'
                       ORDER BY last_turn_at DESC, id LIMIT %s
                   ) e
                   LEFT JOIN episodes p ON p.id = e.previous_episode_id
                       AND p.project_id = e.project_id AND p.space_id = e.space_id
                       AND p.conversation_key = e.conversation_key
                   ORDER BY e.last_turn_at DESC, e.id""",
                (self.project_id, space_id, limit),
            )
            return cursor.fetchall()
