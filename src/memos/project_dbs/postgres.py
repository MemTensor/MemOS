"""PostgreSQL + pgvector implementation of project memory storage."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from memos.configs.project_db import PostgresProjectDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.project_dbs.base import BaseProjectDB
from memos.project_dbs.exceptions import ProjectDBError
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
    def _tx(self) -> Iterator[Any]:
        """One transaction per block: commit on success, rollback on error."""
        conn = self.pool.getconn()
        if conn.closed:  # dropped by a DB restart or failover; replace it
            self.pool.putconn(conn, close=True)
            conn = self.pool.getconn()
        try:
            with conn, conn.cursor() as cur:
                yield cur
        finally:
            self.pool.putconn(conn, close=bool(conn.closed))

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
    def create_space(
        self,
        project_id: str,
        space_name: str,
        instructions: str | None = None,
        domains: list[Domain] | None = None,
    ) -> Space:
        raise NotImplementedError

    def list_spaces(self, project_id: str, space_ids: list[str] | None = None) -> list[Space]:
        raise NotImplementedError

    def assert_spaces(
        self, project_id: str, space_ids: list[str], domains: list[str] | None = None
    ) -> list[Space]:
        raise NotImplementedError

    def update_space(
        self, space_id: str, space_name: str | None = None, instructions: str | None = None
    ) -> Space:
        raise NotImplementedError

    def delete_space(self, space_id: str) -> None:
        raise NotImplementedError

    # ---------- 领域 ----------
    def create_domains(self, space_id: str, domains: list[Domain]) -> list[Domain]:
        raise NotImplementedError

    def update_domains(self, space_id: str, updates: list[DomainUpdate]) -> list[Domain]:
        raise NotImplementedError

    def delete_domains(self, space_id: str, names: list[str]) -> list[Domain]:
        raise NotImplementedError

    def list_domains(self, space_id: str) -> list[Domain]:
        raise NotImplementedError

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
