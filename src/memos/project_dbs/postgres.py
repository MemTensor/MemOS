"""PostgreSQL + pgvector implementation of project memory storage.

Module-level API shared with the Add plugin, which installs and writes the same schema:
SCHEMA, INIT_SQL, _INIT_LOCK_KEY, render_ddl, required_extensions, install_schema,
write_change_set (runs in the caller's transaction) and refresh_topic_ranks.
"""

import re
import uuid

from collections.abc import Generator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

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
    UpdateConflictError,
)
from memos.project_dbs.item import (
    AnyEntry,
    Decision,
    Domain,
    DomainUpdate,
    EntryHit,
    EntryStatus,
    Page,
    SearchHit,
    Space,
    Topic,
    TopicChangeResult,
    TopicChangeSet,
    TopicFilter,
)
from memos.project_dbs.postgres_migration import is_legacy_layout, migrate_legacy_layout
from memos.project_dbs.postgres_rows import (
    _ENTRY_COLS,
    _TOPIC_COLS,
    DISPLAY_ORDER,
    ENTRY_TIME_COLUMNS,
    PREVIEW_ORDER,
    SCHEMA,
    TOPIC_ORDER,
    TOPIC_TIME_COLUMNS,
    attach_entries,
    entries_from_rows,
    filters_sql,
    load_entries_by_id,
    topic_from_row,
)
from memos.project_dbs.postgres_writer import refresh_topic_ranks, tuple_cursor, write_change_set


__all__ = [
    "INIT_SQL",
    "SCHEMA",
    "_ENTRY_COLS",
    "_INIT_LOCK_KEY",
    "_TOPIC_COLS",
    "PostgresProjectDB",
    "install_schema",
    "is_legacy_layout",
    "migrate_legacy_layout",
    "refresh_topic_ranks",
    "render_ddl",
    "required_extensions",
    "write_change_set",
]

logger = get_logger(__name__)

INIT_SQL = Path(__file__).with_name("sql") / "postgres_init.sql"
# pg_advisory_lock key: only one instance runs the DDL when several start together.
_INIT_LOCK_KEY = 0x50524F4A  # "PROJ"
# Candidate rows fetched per search_entries call before folding into topics.
_ENTRY_CANDIDATES_MIN = 200


def required_extensions(text_search_parser: str) -> list[str]:
    """Extensions a privileged account must install before init: vector for the embedding
    columns, btree_gist for the episodes EXCLUDE constraint, zhparser when configured."""
    required = ["vector", "btree_gist"]
    if text_search_parser == "zhparser":
        required.append("zhparser")
    return required


def render_ddl(
    embedding_dimension: int, text_search_parser: str = "zhparser", schema: str = SCHEMA
) -> str:
    """postgres_init.sql with its placeholders filled; `schema` replaces project_memory
    (tests install into scratch schemas)."""
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
        raise ValueError("Project memory schema names must be lowercase identifiers")
    if text_search_parser == "zhparser":
        create = (
            f"CREATE TEXT SEARCH CONFIGURATION {schema}.zh (PARSER = zhparser); "
            f"ALTER TEXT SEARCH CONFIGURATION {schema}.zh "
            "ADD MAPPING FOR n, v, a, i, e, l WITH simple;"
        )
    else:
        create = f"CREATE TEXT SEARCH CONFIGURATION {schema}.zh (COPY = simple);"
    # Guarded so a pre-existing configuration does not break init.
    text_search = (
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_ts_config c "
        "JOIN pg_namespace n ON n.oid = c.cfgnamespace "
        f"WHERE c.cfgname = 'zh' AND n.nspname = '{schema}') THEN {create} END IF; END $$;"
    )
    template = INIT_SQL.read_text(encoding="utf-8")
    for placeholder in ("{embedding_dimension}", "{text_search_config}"):
        if placeholder not in template:
            raise ProjectDBError(f"Placeholder {placeholder} missing in {INIT_SQL.name}")
    if schema != SCHEMA:
        template = re.sub(rf"\b{SCHEMA}\b", schema, template)
    return template.replace("{embedding_dimension}", str(int(embedding_dimension))).replace(
        "{text_search_config}", text_search
    )


def install_schema(cursor: Any, ddl: str, schema: str = SCHEMA) -> str:
    """Create the schema when project_entries is missing and migrate a legacy layout in
    place (see postgres_migration); a current install is left untouched so a restart needs
    no DDL privileges. Run in one transaction under _INIT_LOCK_KEY.
    Returns "created", "migrated" or "current"."""
    with tuple_cursor(cursor) as cur:
        cur.execute("SELECT to_regclass(%s)", (f"{schema}.project_entries",))
        if cur.fetchone()[0] is None:
            cur.execute(ddl)
            return "created"
        if is_legacy_layout(cur, schema):
            migrate_legacy_layout(cur, ddl, schema)
            return "migrated"
    return "current"


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
            self._check_extensions()
            if config.auto_init:
                self._init_schema()
        except Exception:
            self.pool.closeall()
            raise

    # ---------- connection and init ----------
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

    def _check_extensions(self) -> None:
        required = required_extensions(self.config.text_search_parser)
        with self._tx() as cur:
            cur.execute("SELECT extname FROM pg_extension WHERE extname = ANY(%s)", (required,))
            installed = {row[0] for row in cur.fetchall()}
        missing = [name for name in required if name not in installed]
        if missing:
            raise ProjectDBError(
                f"PostgreSQL extensions not installed in database '{self.config.db_name}': "
                f"{missing}; run CREATE EXTENSION with a privileged account"
            )

    def _render_ddl(self) -> str:
        """Fill the placeholders of postgres_init.sql from the config."""
        return render_ddl(self.config.embedding_dimension, self.config.text_search_parser)

    def _init_schema(self) -> None:
        ddl = self._render_ddl()
        with self._tx() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_INIT_LOCK_KEY,))
            outcome = install_schema(cur, ddl)
        if outcome != "current":
            logger.info(f"Project memory schema {outcome}")

    def close(self) -> None:
        self.pool.closeall()

    # ---------- spaces ----------
    _SPACE_COLS = "id, project_id, space_name, instructions, create_time, update_time, clear_time"
    _DOMAIN_COLS = "id, space_id, domain, description"

    @staticmethod
    def _space(row: tuple) -> Space:
        names = ("id", "project_id", "space_name", "instructions", "create_time", "update_time",
                 "clear_time")  # fmt: skip
        return Space.model_validate(dict(zip(names, row, strict=True)))

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
        # Domains, topics, entries and Episodes go with it through ON DELETE CASCADE.
        with self._tx() as cur:
            cur.execute(f"DELETE FROM {SCHEMA}.spaces WHERE id = %s", (space_id,))

    # ---------- domains ----------
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
                            WHERE space_id = %s AND id = %s
                            RETURNING {self._DOMAIN_COLS}""",
                        (item.new_domain, item.description, space_id, item.domain_id),
                    )
                except errors.UniqueViolation as e:
                    raise DomainAlreadyExistsError(
                        f"Domain already exists in space {space_id}: {item.new_domain}"
                    ) from e
                row = cur.fetchone()
                if row is None:
                    raise DomainNotFoundError(
                        f"Domain not found in space {space_id}: {item.domain_id}"
                    )
                updated[row[0]] = self._domain(row)
        return list(updated.values())

    def delete_domains(self, space_id: str, domain_ids: list[str]) -> list[Domain]:
        from psycopg2 import errors

        try:
            with self._tx() as cur:
                cur.execute(
                    f"""DELETE FROM {SCHEMA}.domains WHERE space_id = %s AND id = ANY(%s)
                        RETURNING {self._DOMAIN_COLS}""",
                    (space_id, list(domain_ids)),
                )
                return [self._domain(row) for row in cur.fetchall()]
        except errors.ForeignKeyViolation as e:
            # topics.domain_id references domains: any referenced domain rejects the batch.
            raise DomainInUseError(f"Domain still referenced by topics in space {space_id}") from e

    def list_domains(self, space_id: str) -> list[Domain]:
        with self._tx() as cur:
            cur.execute(
                f"""SELECT {self._DOMAIN_COLS} FROM {SCHEMA}.domains
                    WHERE space_id = %s ORDER BY create_time, domain""",
                (space_id,),
            )
            return [self._domain(row) for row in cur.fetchall()]

    # ---------- topic and entry reads ----------
    def list_topics(
        self,
        space_id: str,
        filters: list[TopicFilter] | None = None,
        page: int = 1,
        size: int = 10,
        preview_size: int = 5,
    ) -> Page[Topic]:
        params: list[Any] = [space_id]
        where = "t.space_id = %s" + filters_sql(filters, params, TOPIC_TIME_COLUMNS)
        with self._tx() as cur:
            cur.execute(f"SELECT count(*) FROM {SCHEMA}.topics t WHERE {where}", params)
            total = cur.fetchone()[0]
            cur.execute(
                f"""SELECT {_TOPIC_COLS} FROM {SCHEMA}.topics t
                    JOIN {SCHEMA}.domains d ON d.id = t.domain_id
                    WHERE {where} ORDER BY {TOPIC_ORDER} LIMIT %s OFFSET %s""",
                [*params, size, (page - 1) * size],
            )
            topics = {row[0]: topic_from_row(row) for row in cur.fetchall()}
            if topics and preview_size > 0:
                cur.execute(
                    f"""SELECT {_ENTRY_COLS} FROM (
                            SELECT e.*, row_number() OVER (
                                PARTITION BY e.topic_id, e.entry_type ORDER BY {PREVIEW_ORDER}
                            ) AS rn
                            FROM {SCHEMA}.project_entries e
                            WHERE e.topic_id = ANY(%s) AND e.status = %s) e
                        WHERE e.rn <= %s
                        ORDER BY e.topic_id, e.entry_type,
                            CASE WHEN e.entry_type = 'timeline' THEN e.chat_time END, e.rn""",
                    (list(topics), int(EntryStatus.ACTIVE), preview_size),
                )
                attach_entries(topics, entries_from_rows(cur, cur.fetchall(), False))
        return Page[Topic](items=list(topics.values()), total=total, page=page, size=size)

    def list_entries(
        self,
        topic_id: str,
        entry_type: Literal["decision", "experience", "timeline"],
        filters: list[TopicFilter] | None = None,
        page: int = 1,
        size: int = 10,
    ) -> Page[AnyEntry]:
        params: list[Any] = [topic_id, entry_type, int(EntryStatus.ACTIVE)]
        where = "e.topic_id = %s AND e.entry_type = %s AND e.status = %s"
        where += filters_sql(filters, params, ENTRY_TIME_COLUMNS)
        with self._tx() as cur:
            cur.execute(f"SELECT count(*) FROM {SCHEMA}.project_entries e WHERE {where}", params)
            total = cur.fetchone()[0]
            cur.execute(
                f"""SELECT {_ENTRY_COLS} FROM {SCHEMA}.project_entries e WHERE {where}
                    ORDER BY {DISPLAY_ORDER} LIMIT %s OFFSET %s""",
                [*params, size, (page - 1) * size],
            )
            items = entries_from_rows(cur, cur.fetchall(), with_children=True)
        return Page[AnyEntry](items=items, total=total, page=page, size=size)

    def _topics_by_id(self, cur: Any, topic_ids: list[str], with_entries: bool) -> dict:
        cur.execute(
            f"""SELECT {_TOPIC_COLS} FROM {SCHEMA}.topics t
                JOIN {SCHEMA}.domains d ON d.id = t.domain_id WHERE t.id = ANY(%s)""",
            (list(topic_ids),),
        )
        topics = {row[0]: topic_from_row(row) for row in cur.fetchall()}
        if topics and with_entries:
            cur.execute(
                f"""SELECT {_ENTRY_COLS} FROM {SCHEMA}.project_entries e
                    WHERE e.topic_id = ANY(%s) AND e.status = %s ORDER BY {DISPLAY_ORDER}""",
                (list(topics), int(EntryStatus.ACTIVE)),
            )
            attach_entries(topics, entries_from_rows(cur, cur.fetchall(), with_children=True))
        return topics

    def get_topics_detail(self, topic_ids: list[str], with_entries: bool = True) -> list[Topic]:
        if not topic_ids:
            return []
        with self._tx() as cur:
            topics = self._topics_by_id(cur, topic_ids, with_entries)
        return [topics[i] for i in dict.fromkeys(topic_ids) if i in topics]

    def get_entry(self, entry_id: str) -> AnyEntry | None:
        with self._tx() as cur:
            cur.execute(
                f"""SELECT COALESCE(parent_decision_id, id) FROM {SCHEMA}.project_entries
                    WHERE id = %s""",
                (entry_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return load_entries_by_id(cur, [row[0]]).get(row[0])

    # ---------- topic writes ----------
    def apply_changes(self, change_set: TopicChangeSet) -> list[TopicChangeResult]:
        with self._tx() as cur:
            return write_change_set(cur, change_set)

    def update_decision(
        self,
        decision_id: str,
        expected_update_time: datetime,
        content: str,
        embedding: list[float] | None = None,
    ) -> Decision:
        if expected_update_time.tzinfo is None:
            raise ValueError("expected_update_time must be timezone-aware")
        with self._tx() as cur:
            cur.execute(
                f"""UPDATE {SCHEMA}.project_entries SET content = %s, embedding = %s::vector,
                        version = version + 1, update_time = clock_timestamp()
                    WHERE id = %s AND entry_type = 'decision' AND status = %s
                      AND update_time = %s
                    RETURNING topic_id""",
                (content, embedding, decision_id, int(EntryStatus.ACTIVE), expected_update_time),
            )
            row = cur.fetchone()
            if row is None:
                raise UpdateConflictError(
                    f"Decision {decision_id} changed since {expected_update_time.isoformat()}"
                )
            cur.execute(
                f"DELETE FROM {SCHEMA}.project_entries WHERE parent_decision_id = %s "
                "AND status = %s",
                (decision_id, int(EntryStatus.CONFLICT)),
            )
            refresh_topic_ranks(cur, [row[0]])
            return load_entries_by_id(cur, [decision_id])[decision_id]

    def delete_topics(self, topic_ids: list[str]) -> int:
        if not topic_ids:
            return 0
        with self._tx() as cur:
            # Entries cascade; episodes.topic_id is set NULL by its foreign key.
            cur.execute(f"DELETE FROM {SCHEMA}.topics WHERE id = ANY(%s)", (list(topic_ids),))
            return cur.rowcount

    def clear_space(self, space_id: str) -> int:
        with self._tx() as cur:
            # FOR UPDATE waits for in-flight write_change_set (FOR KEY SHARE) on this space.
            cur.execute(f"SELECT 1 FROM {SCHEMA}.spaces WHERE id = %s FOR UPDATE", (space_id,))
            if cur.fetchone() is None:
                raise SpaceNotFoundError(f"Space not found: {space_id}")
            # clock_timestamp(), not now(): stamp the moment the clear takes effect, after
            # waiting for in-flight write-backs, so tasks accepted meanwhile are rejected.
            cur.execute(
                f"UPDATE {SCHEMA}.spaces SET clear_time = clock_timestamp() WHERE id = %s",
                (space_id,),
            )
            cur.execute(f"DELETE FROM {SCHEMA}.topics WHERE space_id = %s", (space_id,))
            return cur.rowcount

    # ---------- search ----------
    @staticmethod
    def _recall_filter(
        space_ids: list[str], domains: list[str] | None, filters: list[TopicFilter] | None
    ) -> tuple[str, list[Any]]:
        params: list[Any] = [list(space_ids)]
        where = "t.space_id = ANY(%s)"
        if domains:
            where += " AND d.domain = ANY(%s)"
            params.append(list(domains))
        where += filters_sql(filters, params, TOPIC_TIME_COLUMNS)
        return where, params

    # Any query term matches: plainto_tsquery ANDs the terms, so turn & into |.
    _ANY_TERM_QUERY = f"replace(plainto_tsquery('{SCHEMA}.zh', %s)::text, ' & ', ' | ')::tsquery"

    def search_topics_by_embedding(
        self,
        space_ids: list[str],
        query_vec: list[float],
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
    ) -> list[SearchHit]:
        if not space_ids or top_k <= 0:
            return []
        where, params = self._recall_filter(space_ids, domains, filters)
        with self._tx() as cur:
            cur.execute(
                f"""SELECT {_TOPIC_COLS}, t.embedding <=> %s::vector AS distance
                    FROM {SCHEMA}.topics t JOIN {SCHEMA}.domains d ON d.id = t.domain_id
                    WHERE {where} AND t.embedding IS NOT NULL
                    ORDER BY distance, t.id COLLATE "C" LIMIT %s""",
                [query_vec, *params, top_k],
            )
            return [
                SearchHit(topic=topic_from_row(row[:-1]), score=1.0 - row[-1])
                for row in cur.fetchall()
            ]

    def search_topics_by_fulltext(
        self,
        space_ids: list[str],
        query_text: str,
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
    ) -> list[SearchHit]:
        text = query_text.strip()
        if not space_ids or not text or top_k <= 0:
            return []
        where, params = self._recall_filter(space_ids, domains, filters)
        with self._tx() as cur:
            cur.execute(
                f"""SELECT {_TOPIC_COLS}, ts_rank(t.search_tsv, q.value) AS rank
                    FROM {SCHEMA}.topics t JOIN {SCHEMA}.domains d ON d.id = t.domain_id
                    CROSS JOIN (SELECT {self._ANY_TERM_QUERY}) AS q(value)
                    WHERE {where} AND t.search_tsv @@ q.value
                    ORDER BY rank DESC, t.id COLLATE "C" LIMIT %s""",
                [text, *params, top_k],
            )
            return [
                SearchHit(topic=topic_from_row(row[:-1]), score=row[-1]) for row in cur.fetchall()
            ]

    def _search_entries(
        self,
        score_sql: str,
        score_params: list[Any],
        match_sql: str,
        match_params: list[Any],
        space_ids: list[str],
        domains: list[str] | None,
        filters: list[TopicFilter] | None,
        top_k: int,
        per_topic: int,
    ) -> list[EntryHit]:
        """Fold candidate rows into their decisions (best score), keep the top_k topics by
        their best entry and at most per_topic entries each."""
        where, params = self._recall_filter(space_ids, domains, filters)
        limit = max(_ENTRY_CANDIDATES_MIN, top_k * per_topic * 4)
        with self._tx() as cur:
            cur.execute(
                f"""SELECT COALESCE(e.parent_decision_id, e.id), e.topic_id, {score_sql} AS score
                    FROM {SCHEMA}.project_entries e
                    JOIN {SCHEMA}.topics t ON t.id = e.topic_id
                    JOIN {SCHEMA}.domains d ON d.id = t.domain_id
                    WHERE {where} AND {match_sql}
                      AND (e.entry_type = 'decision' OR e.status = %s)
                    ORDER BY score DESC, e.id COLLATE "C" LIMIT %s""",
                [*score_params, *params, *match_params, int(EntryStatus.ACTIVE), limit],
            )
            best: dict[str, tuple[str, float]] = {}
            for entry_id, topic_id, score in cur.fetchall():
                if entry_id not in best or score > best[entry_id][1]:
                    best[entry_id] = (topic_id, float(score))
            per: dict[str, list[tuple[str, float]]] = {}
            for entry_id, (topic_id, score) in best.items():
                per.setdefault(topic_id, []).append((entry_id, score))
            ranked = sorted(per.items(), key=lambda kv: (-max(s for _, s in kv[1]), kv[0]))
            chosen = [
                (entry_id, score)
                for _, items in ranked[:top_k]
                for entry_id, score in sorted(items, key=lambda x: (-x[1], x[0]))[:per_topic]
            ]
            entries = load_entries_by_id(cur, [entry_id for entry_id, _ in chosen])
        return [EntryHit(entry=entries[i], score=s) for i, s in chosen if i in entries]

    def search_entries_by_embedding(
        self,
        space_ids: list[str],
        query_vec: list[float],
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
        per_topic: int = 6,
    ) -> list[EntryHit]:
        if not space_ids or top_k <= 0 or per_topic <= 0:
            return []
        return self._search_entries(
            "1 - (e.embedding <=> %s::vector)",
            [query_vec],
            "e.embedding IS NOT NULL",
            [],
            space_ids,
            domains,
            filters,
            top_k,
            per_topic,
        )

    def search_entries_by_fulltext(
        self,
        space_ids: list[str],
        query_text: str,
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
        top_k: int = 20,
        per_topic: int = 6,
    ) -> list[EntryHit]:
        text = query_text.strip()
        if not space_ids or not text or top_k <= 0 or per_topic <= 0:
            return []
        query = self._ANY_TERM_QUERY
        return self._search_entries(
            f"ts_rank(e.search_tsv, {query})",
            [text],
            f"e.search_tsv @@ {query}",
            [text],
            space_ids,
            domains,
            filters,
            top_k,
            per_topic,
        )
