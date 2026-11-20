"""Shared PostgreSQL storage for project memory and its Add stages."""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from .add_migrations import CREATE_TABLES, CREATE_VECTOR_INDEXES


if TYPE_CHECKING:
    from collections.abc import Iterator, Sequence


def json_value(value: Any) -> Any:
    """Bind a Python value as JSONB through the optional PostgreSQL driver."""
    from psycopg2.extras import Json

    return Json(value)


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
                cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("pm-ddl",))
                cursor.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
                cursor.execute(
                    sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(
                        sql.Identifier(self.schema_name)
                    )
                )
                cursor.execute(CREATE_TABLES.format(dimension=self.dim))
                # pgvector HNSW on the vector type supports dimensions up to 2000.
                if self.dim <= 2000:
                    cursor.execute(CREATE_VECTOR_INDEXES)
                if self.retrieval_index:
                    from .add_publish import install

                    install(cursor)
        except Exception:
            self.close()
            raise

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
                "SELECT * FROM spaces WHERE project_id = %s AND id = %s",
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
            """SELECT e.*, s.instructions, s.resource_bindings, s.cleared_at
               FROM episodes e JOIN spaces s ON s.id = e.space_id AND s.project_id = e.project_id
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
            cursor.execute(
                """SELECT t.*, d.domain FROM topics t
                     JOIN spaces s ON s.id = t.space_id
                     JOIN domains d ON d.space_id = t.space_id AND d.id = t.domain_id
                   WHERE s.project_id = %s AND t.space_id = %s
                     AND (%s::text[] IS NULL OR d.domain = ANY(%s::text[]))
                     AND (%s::text[] IS NULL OR t.id = ANY(%s::text[]))
                   ORDER BY t.update_time DESC, t.id""",
                (
                    self.project_id,
                    space_id,
                    None if domains is None else list(domains),
                    None if domains is None else list(domains),
                    None if topic_ids is None else list(topic_ids),
                    None if topic_ids is None else list(topic_ids),
                ),
            )
            return cursor.fetchall()

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
