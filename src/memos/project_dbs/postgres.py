"""PostgreSQL + pgvector implementation of project memory storage."""

import uuid

from collections.abc import Generator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from memos.configs.project_db import PostgresProjectDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.project_dbs.base import MAX_DOMAINS_PER_SPACE, BaseProjectDB
from memos.project_dbs.exceptions import (
    DomainAlreadyExistsError,
    DomainInUseError,
    DomainLimitExceededError,
    DomainNotFoundError,
    ProjectDBError,
    SpaceNotFoundError,
)
from memos.project_dbs.item import (
    AnyEntry,
    Decision,
    Domain,
    DomainUpdate,
    EntryHit,
    Page,
    SearchHit,
    Space,
    SpaceContext,
    Topic,
    TopicChangeResult,
    TopicChangeSet,
    TopicFilter,
)


logger = get_logger(__name__)

SCHEMA = "project_memory"
INIT_SQL = Path(__file__).with_name("sql") / "postgres_init.sql"
# pg_advisory_lock key: only one instance runs the DDL when several start together.
_INIT_LOCK_KEY = 0x50524F4A  # "PROJ"


class PostgresProjectDB(BaseProjectDB):
    @require_python_package(
        import_name="psycopg2",
        install_command="pip install psycopg2-binary",
        install_link="https://pypi.org/project/psycopg2-binary/",
    )
    def __init__(self, config: PostgresProjectDBConfig):
        import psycopg2.pool

        self.config = config
        logger.info(
            f"Connecting project memory PostgreSQL: {config.host}:{config.port}/{config.db_name}"
        )
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=config.minconn,
            maxconn=config.maxconn,
            host=config.host,
            port=config.port,
            user=config.user,
            password=config.password,
            dbname=config.db_name,
            connect_timeout=10,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )
        try:
            self._check_vector_extension()
            if config.auto_init:
                self._init_schema()
        except Exception:
            self.pool.closeall()
            raise

    # ---------- 连接与初始化 ----------
    @contextmanager
    def _tx(self) -> Generator[Any, None, None]:
        """One transaction per block: commit on success, rollback on error."""
        conn = self.pool.getconn()
        try:
            with conn, conn.cursor() as cur:
                yield cur
        finally:
            # The pool discards connections that were lost, e.g. after a DB restart.
            self.pool.putconn(conn)

    def _check_vector_extension(self) -> None:
        with self._tx() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
            if cur.fetchone() is None:
                raise ProjectDBError(
                    "pgvector extension is not installed in database "
                    f"'{self.config.db_name}'; run CREATE EXTENSION vector with a privileged account"
                )

    def _init_schema(self) -> None:
        """Create the schema once. Existing installs are left untouched, so a restart
        neither needs DDL privileges nor takes locks on live tables."""
        ddl = INIT_SQL.read_text(encoding="utf-8").replace(
            "{embedding_dimension}", str(int(self.config.embedding_dimension))
        )
        with self._tx() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_INIT_LOCK_KEY,))
            cur.execute("SELECT to_regclass(%s)", (f"{SCHEMA}.project_entries",))
            if cur.fetchone()[0] is not None:
                return
            cur.execute(ddl)
        logger.info("Project memory schema initialized")

    def close(self) -> None:
        self.pool.closeall()

    # ---------- 空间 ----------
    _SPACE_COLS = "id, project_id, space_name, instructions, create_time, update_time"
    _DOMAIN_COLS = "id, space_id, domain, description"

    @staticmethod
    def _space(row: tuple) -> Space:
        return Space(
            id=row[0],
            project_id=row[1],
            space_name=row[2],
            instructions=row[3],
            create_time=row[4],
            update_time=row[5],
        )

    @staticmethod
    def _domain(row: tuple) -> Domain:
        return Domain(id=row[0], space_id=row[1], domain=row[2], description=row[3])

    def _lock_space(self, cur: Any, space_id: str) -> None:
        """Lock the space row so concurrent create_domains batches run one at a time and
        cannot overshoot the domain cap. FOR NO KEY UPDATE does not block topic inserts."""
        cur.execute(f"SELECT 1 FROM {SCHEMA}.spaces WHERE id = %s FOR NO KEY UPDATE", (space_id,))
        if cur.fetchone() is None:
            raise SpaceNotFoundError(f"Space not found: {space_id}")

    def _insert_domains(self, cur: Any, space_id: str, domains: list[Domain]) -> list[Domain]:
        """Insert in one statement and return the newly registered rows; existing names
        are skipped. The count check runs in the same transaction, so exceeding the cap
        rolls the insert back."""
        if not domains:
            return []
        from psycopg2.extras import execute_values

        rows = execute_values(
            cur,
            f"""INSERT INTO {SCHEMA}.domains (id, space_id, domain, description)
                VALUES %s ON CONFLICT (space_id, domain) DO NOTHING
                RETURNING {self._DOMAIN_COLS}""",
            [(str(uuid.uuid4()), space_id, item.domain, item.description) for item in domains],
            fetch=True,
        )
        cur.execute(f"SELECT count(*) FROM {SCHEMA}.domains WHERE space_id = %s", (space_id,))
        if cur.fetchone()[0] > MAX_DOMAINS_PER_SPACE:
            raise DomainLimitExceededError(
                f"Space {space_id} would exceed {MAX_DOMAINS_PER_SPACE} domains"
            )
        return [self._domain(row) for row in rows]

    def create_space(
        self,
        project_id: str,
        space_name: str,
        instructions: str | None = None,
        domains: list[Domain] | None = None,
    ) -> Space:
        space_id = str(uuid.uuid4())
        with self._tx() as cur:
            cur.execute(
                f"""INSERT INTO {SCHEMA}.spaces (id, project_id, space_name, instructions)
                    VALUES (%s, %s, %s, %s) RETURNING {self._SPACE_COLS}""",
                (space_id, project_id, space_name, instructions or None),
            )
            space = self._space(cur.fetchone())
            self._insert_domains(cur, space_id, domains or [])
        return space

    def list_spaces(self, project_id: str, space_ids: list[str] | None = None) -> list[Space]:
        query = f"SELECT {self._SPACE_COLS} FROM {SCHEMA}.spaces WHERE project_id = %s"
        params: list[Any] = [project_id]
        if space_ids is not None:
            query += " AND id = ANY(%s)"
            params.append(list(space_ids))
        with self._tx() as cur:
            cur.execute(query + " ORDER BY create_time DESC, id", params)
            spaces = [self._space(row) for row in cur.fetchall()]
        missing = set(space_ids or []) - {space.id for space in spaces}
        if missing:
            raise SpaceNotFoundError(f"Space not found: {sorted(missing)}")
        return spaces

    def assert_spaces(
        self, project_id: str, space_ids: list[str], domains: list[str] | None = None
    ) -> list[Space]:
        ordered = list(dict.fromkeys(space_ids))
        if not ordered:
            return []
        with self._tx() as cur:
            cur.execute(
                f"""SELECT {self._SPACE_COLS} FROM {SCHEMA}.spaces
                    WHERE project_id = %s AND id = ANY(%s)""",
                (project_id, ordered),
            )
            found = {row[0]: self._space(row) for row in cur.fetchall()}
            registered: set = set()
            if domains:
                cur.execute(
                    f"""SELECT space_id, domain FROM {SCHEMA}.domains
                        WHERE space_id = ANY(%s) AND domain = ANY(%s)""",
                    (ordered, list(domains)),
                )
                registered = set(cur.fetchall())
        missing_spaces = [s for s in ordered if s not in found]
        if missing_spaces:
            raise SpaceNotFoundError(f"Space not found: {missing_spaces}")
        missing = [(s, d) for s in ordered for d in domains or [] if (s, d) not in registered]
        if missing:
            raise DomainNotFoundError(f"Domain not registered (space, domain): {missing}")
        return [found[space_id] for space_id in ordered]

    def update_space(
        self, space_id: str, space_name: str | None = None, instructions: str | None = None
    ) -> Space:
        sets, params = [], []
        if space_name is not None:
            sets.append("space_name = %s")
            params.append(space_name)
        if instructions is not None:
            sets.append("instructions = %s")
            params.append(instructions or None)
        if not sets:
            raise ValueError("update_space needs space_name or instructions")
        with self._tx() as cur:
            cur.execute(
                f"""UPDATE {SCHEMA}.spaces SET {", ".join(sets)}, update_time = now()
                    WHERE id = %s RETURNING {self._SPACE_COLS}""",
                [*params, space_id],
            )
            row = cur.fetchone()
        if row is None:
            raise SpaceNotFoundError(f"Space not found: {space_id}")
        return self._space(row)

    def delete_space(self, space_id: str) -> None:
        # Domains, topics and entries go with it through ON DELETE CASCADE.
        with self._tx() as cur:
            cur.execute(f"DELETE FROM {SCHEMA}.spaces WHERE id = %s", (space_id,))

    # ---------- 领域 ----------
    def create_domains(self, space_id: str, domains: list[Domain]) -> list[Domain]:
        with self._tx() as cur:
            self._lock_space(cur, space_id)
            return self._insert_domains(cur, space_id, domains)

    def update_domains(self, space_id: str, updates: list[DomainUpdate]) -> list[Domain]:
        from psycopg2 import errors

        updated: dict[str, Domain] = {}
        with self._tx() as cur:
            for item in updates:
                try:
                    cur.execute(
                        f"""UPDATE {SCHEMA}.domains
                            SET domain = COALESCE(%s, domain),
                                description = COALESCE(%s, description),
                                update_time = now()
                            WHERE space_id = %s AND domain = %s
                            RETURNING {self._DOMAIN_COLS}""",
                        (item.new_domain, item.description, space_id, item.domain),
                    )
                except errors.UniqueViolation as e:
                    raise DomainAlreadyExistsError(
                        f"Domain already exists in space {space_id}: {item.new_domain}"
                    ) from e
                row = cur.fetchone()
                if row is None:
                    raise DomainNotFoundError(
                        f"Domain not found in space {space_id}: {item.domain}"
                    )
                updated[row[0]] = self._domain(row)
        return list(updated.values())

    def delete_domains(self, space_id: str, names: list[str]) -> list[Domain]:
        from psycopg2 import errors

        try:
            with self._tx() as cur:
                cur.execute(
                    f"""DELETE FROM {SCHEMA}.domains WHERE space_id = %s AND domain = ANY(%s)
                        RETURNING {self._DOMAIN_COLS}""",
                    (space_id, list(names)),
                )
                return [self._domain(row) for row in cur.fetchall()]
        except errors.ForeignKeyViolation as e:
            # topics.domain_id references domains: any referenced name rejects the batch.
            raise DomainInUseError(f"Domain still referenced by topics in space {space_id}") from e

    def list_domains(self, space_id: str) -> list[Domain]:
        with self._tx() as cur:
            cur.execute(
                f"""SELECT {self._DOMAIN_COLS} FROM {SCHEMA}.domains
                    WHERE space_id = %s ORDER BY create_time, domain""",
                (space_id,),
            )
            return [self._domain(row) for row in cur.fetchall()]

    # ---------- 主题与条目读取 ----------
    def list_topics(
        self,
        space_id: str,
        filter: TopicFilter | None = None,
        page: int = 1,
        size: int = 10,
    ) -> Page[Topic]:
        raise NotImplementedError

    def get_topics(self, project_id: str, topic_ids: list[str]) -> list[Topic]:
        raise NotImplementedError

    def get_entries(self, project_id: str, entry_ids: list[str]) -> list[AnyEntry]:
        raise NotImplementedError

    def load_space_context(self, space_id: str, domains: list[str] | None = None) -> SpaceContext:
        raise NotImplementedError

    # ---------- 主题写入 ----------
    def apply_changes(self, change_set: TopicChangeSet) -> list[TopicChangeResult]:
        raise NotImplementedError

    def update_topic_decisions(
        self,
        project_id: str,
        topic_id: str,
        expected_update_time: datetime,
        decisions: list[Decision],
    ) -> Topic:
        raise NotImplementedError

    def delete_topics(self, project_id: str, topic_ids: list[str]) -> int:
        raise NotImplementedError

    def clear_space(self, space_id: str) -> int:
        raise NotImplementedError

    # ---------- 检索 ----------
    def search_topics(
        self,
        space_ids: list[str],
        query_vec: list[float],
        query_text: str | None = None,
        domains: list[str] | None = None,
        filter: TopicFilter | None = None,
        top_k: int = 20,
    ) -> list[SearchHit]:
        raise NotImplementedError

    def search_entries(
        self,
        space_ids: list[str],
        topic_ids: list[str],
        query_vec: list[float],
        top_k: int = 50,
    ) -> list[EntryHit]:
        raise NotImplementedError
