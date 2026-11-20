"""PostgreSQL + pgvector implementation of project memory storage."""

import json
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
    EntryNotFoundError,
    ProjectDBError,
    SpaceClearedError,
    SpaceNotFoundError,
    TopicNotFoundError,
    UpdateConflictError,
    VersionConflictError,
)
from memos.project_dbs.item import (
    AnyEntry,
    Decision,
    Domain,
    DomainUpdate,
    EntryHit,
    Experience,
    Page,
    SearchHit,
    Source,
    Space,
    Timeline,
    Topic,
    TopicChangeResult,
    TopicChangeSet,
    TopicCreate,
    TopicFilter,
    TopicUpdate,
)


logger = get_logger(__name__)

SCHEMA = "project_memory"
INIT_SQL = Path(__file__).with_name("sql") / "postgres_init.sql"
# pg_advisory_lock key: only one instance runs the DDL when several start together.
_INIT_LOCK_KEY = 0x50524F4A  # "PROJ"

_TOPIC_COLS = (
    "t.id, t.space_id, d.domain, t.topic_name, t.topic_summary, t.topic_description, "
    "t.sources, t.create_time, t.update_time, t.version, t.anchors, t.anchor_keys"
)
_ENTRY_COLS = (
    "e.id, e.topic_id, e.entry_type, e.content, e.time, e.user_ids, "
    "e.history, e.conflicts, e.extra, e.version, e.create_time, e.update_time"
)
_ENTRY_TYPES = {"decision": Decision, "experience": Experience, "timeline": Timeline}
_TOPIC_FIELDS = {"decision": "decisions", "experience": "experiences", "timeline": "timeline"}
_RANGE_OPS = (("gt", ">"), ("gte", ">="), ("lt", "<"), ("lte", "<="))


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
        required = ["vector"]
        if self.config.text_search_parser == "zhparser":
            required.append("zhparser")
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
        if self.config.text_search_parser == "zhparser":
            create = (
                f"CREATE TEXT SEARCH CONFIGURATION {SCHEMA}.zh (PARSER = zhparser); "
                f"ALTER TEXT SEARCH CONFIGURATION {SCHEMA}.zh "
                "ADD MAPPING FOR n, v, a, i, e, l WITH simple;"
            )
        else:
            create = f"CREATE TEXT SEARCH CONFIGURATION {SCHEMA}.zh (COPY = simple);"
        # Guarded so a pre-existing configuration does not break init.
        text_search = (
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_ts_config c "
            "JOIN pg_namespace n ON n.oid = c.cfgnamespace "
            f"WHERE c.cfgname = 'zh' AND n.nspname = '{SCHEMA}') THEN {create} END IF; END $$;"
        )
        template = INIT_SQL.read_text(encoding="utf-8")
        for placeholder in ("{embedding_dimension}", "{text_search_config}"):
            if placeholder not in template:
                raise ProjectDBError(f"Placeholder {placeholder} missing in {INIT_SQL.name}")
        return template.replace(
            "{embedding_dimension}", str(int(self.config.embedding_dimension))
        ).replace("{text_search_config}", text_search)

    def _init_schema(self) -> None:
        """Create the schema once. Existing installs are left untouched, so a restart
        neither needs DDL privileges nor takes locks on live tables."""
        ddl = self._render_ddl()
        with self._tx() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_INIT_LOCK_KEY,))
            cur.execute("SELECT to_regclass(%s)", (f"{SCHEMA}.project_entries",))
            if cur.fetchone()[0] is not None:
                return
            cur.execute(ddl)
        logger.info("Project memory schema initialized")

    def close(self) -> None:
        self.pool.closeall()

    # ---------- spaces ----------
    _SPACE_COLS = "id, project_id, space_name, instructions, create_time, update_time, cleared_at"
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
            cleared_at=row[6],
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

    # ---------- topic and entry reads ----------
    @staticmethod
    def _filters_sql(filters: list[TopicFilter] | None, params: list[Any]) -> str:
        """OR of AND groups over topic create_time / update_time; '' when unfiltered."""
        groups = []
        for group in filters or []:
            conditions = []
            for column in ("create_time", "update_time"):
                time_range = getattr(group, column)
                if time_range is None:
                    continue
                for op, sql_op in _RANGE_OPS:
                    value = getattr(time_range, op)
                    if value is not None:
                        conditions.append(f"t.{column} {sql_op} %s")
                        params.append(value)
            groups.append("(" + " AND ".join(conditions) + ")" if conditions else "TRUE")
        return " AND (" + " OR ".join(groups) + ")" if groups else ""

    @staticmethod
    def _entry(row: tuple, full: bool = True) -> AnyEntry:
        names = ("id", "topic_id", "entry_type", "content", "time", "user_ids", "history",
                 "conflicts", "extra", "version", "create_time", "update_time")  # fmt: skip
        data = dict(zip(names, row, strict=True))
        entry_type = data.pop("entry_type")
        data.pop("topic_id")
        data["user_ids"] = list(data["user_ids"])
        if entry_type != "decision" or not full:  # previews and non-decisions carry neither
            data.pop("history")
            data.pop("conflicts")
        return _ENTRY_TYPES[entry_type].model_validate(data)

    @staticmethod
    def _topic(row: tuple) -> Topic:
        cols = (
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
            "anchor_keys",
        )
        data = dict(zip(cols, row, strict=True))
        data["anchor_keys"] = list(data["anchor_keys"])
        return Topic.model_validate(data)

    def _attach_entries(self, topics: dict[str, Topic], rows: list[tuple], full: bool) -> None:
        for row in rows:
            entry = self._entry(row, full)
            getattr(topics[row[1]], _TOPIC_FIELDS[row[2]]).append(entry)

    def list_topics(
        self,
        space_id: str,
        filters: list[TopicFilter] | None = None,
        page: int = 1,
        size: int = 10,
        preview_size: int = 5,
    ) -> Page[Topic]:
        params: list[Any] = [space_id]
        where = "t.space_id = %s" + self._filters_sql(filters, params)
        with self._tx() as cur:
            cur.execute(f"SELECT count(*) FROM {SCHEMA}.topics t WHERE {where}", params)
            total = cur.fetchone()[0]
            cur.execute(
                f"""SELECT {_TOPIC_COLS} FROM {SCHEMA}.topics t
                    JOIN {SCHEMA}.domains d ON d.id = t.domain_id
                    WHERE {where} ORDER BY t.update_time DESC, t.id COLLATE "C" LIMIT %s OFFSET %s""",
                [*params, size, (page - 1) * size],
            )
            topics = {row[0]: self._topic(row) for row in cur.fetchall()}
            if topics and preview_size > 0:
                cur.execute(
                    f"""SELECT {_ENTRY_COLS} FROM (
                            SELECT *, row_number() OVER (
                                PARTITION BY topic_id, entry_type ORDER BY time DESC, id COLLATE "C") AS rn
                            FROM {SCHEMA}.project_entries WHERE topic_id = ANY(%s)) e
                        WHERE e.rn <= %s ORDER BY e.time DESC, e.id COLLATE "C" """,
                    (list(topics), preview_size),
                )
                self._attach_entries(topics, cur.fetchall(), full=False)
        return Page[Topic](items=list(topics.values()), total=total, page=page, size=size)

    def list_entries(
        self,
        topic_id: str,
        entry_type: Literal["decision", "experience", "timeline"],
        page: int = 1,
        size: int = 10,
    ) -> Page[AnyEntry]:
        with self._tx() as cur:
            cur.execute(
                f"""SELECT count(*) FROM {SCHEMA}.project_entries
                    WHERE topic_id = %s AND entry_type = %s""",
                (topic_id, entry_type),
            )
            total = cur.fetchone()[0]
            cur.execute(
                f"""SELECT {_ENTRY_COLS} FROM {SCHEMA}.project_entries e
                    WHERE e.topic_id = %s AND e.entry_type = %s
                    ORDER BY e.time DESC, e.id COLLATE "C" LIMIT %s OFFSET %s""",
                (topic_id, entry_type, size, (page - 1) * size),
            )
            items = [self._entry(row) for row in cur.fetchall()]
        return Page[AnyEntry](items=items, total=total, page=page, size=size)

    def get_topics(self, topic_ids: list[str]) -> list[Topic]:
        if not topic_ids:
            return []
        with self._tx() as cur:
            cur.execute(
                f"""SELECT {_TOPIC_COLS} FROM {SCHEMA}.topics t
                    JOIN {SCHEMA}.domains d ON d.id = t.domain_id WHERE t.id = ANY(%s)""",
                (list(topic_ids),),
            )
            topics = {row[0]: self._topic(row) for row in cur.fetchall()}
            if topics:
                cur.execute(
                    f"""SELECT {_ENTRY_COLS} FROM {SCHEMA}.project_entries e
                        WHERE e.topic_id = ANY(%s) ORDER BY e.time DESC, e.id COLLATE "C" """,
                    (list(topics),),
                )
                self._attach_entries(topics, cur.fetchall(), full=True)
        return [topics[i] for i in dict.fromkeys(topic_ids) if i in topics]

    # ---------- topic writes ----------
    @staticmethod
    def _dedupe_sources(sources: list[Source]) -> list[dict]:
        """Drop identical sources, keeping first-seen order."""
        seen, result = set(), []
        for source in sources:
            item = source.model_dump(mode="json")
            key = json.dumps(item, sort_keys=True)
            if key not in seen:
                seen.add(key)
                result.append(item)
        return result

    @staticmethod
    def _entry_row(entry: AnyEntry) -> tuple:
        is_decision = entry.entry_type == "decision"
        return (
            entry.entry_type,
            entry.content,
            entry.time,
            list(entry.user_ids),
            json.dumps([h.model_dump(mode="json") for h in entry.history] if is_decision else []),
            json.dumps([c.model_dump(mode="json") for c in entry.conflicts] if is_decision else []),
            json.dumps(entry.extra.model_dump(mode="json")),
            entry.embedding,
        )

    def _insert_entries(self, cur: Any, space_id: str, topic_id: str, entries: list) -> None:
        if not entries:
            return
        from psycopg2.extras import execute_values

        execute_values(
            cur,
            f"""INSERT INTO {SCHEMA}.project_entries (id, topic_id, space_id, entry_type, content,
                    time, user_ids, history, conflicts, extra, embedding) VALUES %s""",
            [(str(uuid.uuid4()), topic_id, space_id, *self._entry_row(e)) for e in entries],
            template="(%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::vector)",
        )

    def _create_topic(self, cur: Any, space_id: str, domain_id: str, item: TopicCreate) -> str:
        topic_id = f"topic_{uuid.uuid4().hex}"
        cur.execute(
            f"""INSERT INTO {SCHEMA}.topics (id, space_id, domain_id, topic_name, topic_summary,
                    topic_description, sources, embedding, anchors)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::vector, %s::jsonb)""",
            (
                topic_id,
                space_id,
                domain_id,
                item.topic_name,
                item.topic_summary,
                item.topic_description,
                json.dumps(self._dedupe_sources(item.sources)),
                item.embedding,
                json.dumps(item.anchors),
            ),
        )
        self._insert_entries(cur, space_id, topic_id, item.entries)
        return topic_id

    def _update_topic(
        self, cur: Any, space_id: str, domain_id: str | None, item: TopicUpdate
    ) -> None:
        sources = json.dumps(self._dedupe_sources(item.add_sources))
        cur.execute(
            f"""UPDATE {SCHEMA}.topics SET
                    domain_id = COALESCE(%s, domain_id),
                    topic_summary = COALESCE(%s, topic_summary),
                    topic_description = COALESCE(%s, topic_description),
                    embedding = CASE WHEN %s THEN %s::vector ELSE embedding END,
                    anchors = COALESCE(%s::jsonb, anchors),
                    sources = COALESCE((
                        SELECT jsonb_agg(s.e ORDER BY s.o) FROM (
                            SELECT x.e, min(x.o) AS o
                            FROM jsonb_array_elements(sources || %s::jsonb) WITH ORDINALITY x(e, o)
                            GROUP BY x.e) s), '[]'::jsonb),
                    version = version + 1,
                    update_time = now()
                WHERE id = %s AND space_id = %s AND version = %s""",
            (
                domain_id,
                item.topic_summary,
                item.topic_description,
                item.embedding is not None,
                item.embedding,
                None if item.anchors is None else json.dumps(item.anchors),
                sources,
                item.topic_id,
                space_id,
                item.expected_version,
            ),
        )
        if cur.rowcount == 0:  # failure path only: tell a missing topic from a stale version
            cur.execute(
                f"SELECT 1 FROM {SCHEMA}.topics WHERE id = %s AND space_id = %s",
                (item.topic_id, space_id),
            )
            if cur.fetchone() is None:
                raise TopicNotFoundError(f"Topic not found in space {space_id}: {item.topic_id}")
            raise VersionConflictError(
                f"Topic {item.topic_id} changed since version {item.expected_version}"
            )
        if item.delete_entry_ids:
            cur.execute(
                f"DELETE FROM {SCHEMA}.project_entries WHERE topic_id = %s AND id = ANY(%s)",
                (item.topic_id, list(item.delete_entry_ids)),
            )
        new_entries = []
        for entry in item.upsert_entries:
            if entry.id is None:
                new_entries.append(entry)
                continue
            cur.execute(
                f"""UPDATE {SCHEMA}.project_entries SET entry_type = %s, content = %s, time = %s,
                        user_ids = %s, history = %s::jsonb, conflicts = %s::jsonb,
                        extra = %s::jsonb, embedding = %s::vector,
                        version = version + 1, update_time = now()
                    WHERE id = %s AND topic_id = %s""",
                (*self._entry_row(entry), entry.id, item.topic_id),
            )
            if cur.rowcount == 0:
                raise EntryNotFoundError(f"Entry not found in topic {item.topic_id}: {entry.id}")
        self._insert_entries(cur, space_id, item.topic_id, new_entries)

    def apply_changes(self, change_set: TopicChangeSet) -> list[TopicChangeResult]:
        space_id = change_set.space_id
        with self._tx() as cur:
            # FOR KEY SHARE conflicts with clear_space's FOR UPDATE (so a clear and a
            # write-back never interleave) but not with create_domains' FOR NO KEY UPDATE.
            cur.execute(
                f"SELECT cleared_at FROM {SCHEMA}.spaces WHERE id = %s FOR KEY SHARE", (space_id,)
            )
            row = cur.fetchone()
            if row is None:
                raise SpaceNotFoundError(f"Space not found: {space_id}")
            if row[0] is not None and change_set.accepted_at <= row[0]:
                raise SpaceClearedError(
                    f"Space {space_id} was cleared at {row[0]}, after the task was accepted"
                )
            cur.execute(f"SELECT domain, id FROM {SCHEMA}.domains WHERE space_id = %s", (space_id,))
            domain_ids = dict(cur.fetchall())
            if change_set.updates:
                # Lock in id order so concurrent change sets cannot deadlock on each other.
                cur.execute(
                    f"""SELECT id FROM {SCHEMA}.topics WHERE id = ANY(%s) AND space_id = %s
                        ORDER BY id FOR NO KEY UPDATE""",
                    (sorted({u.topic_id for u in change_set.updates}), space_id),
                )

            def resolve(name: str) -> str:
                if name not in domain_ids:
                    raise DomainNotFoundError(f"Domain not registered in space {space_id}: {name}")
                return domain_ids[name]

            results = []
            for item in change_set.creates:
                topic_id = self._create_topic(cur, space_id, resolve(item.domain), item)
                results.append(TopicChangeResult(topic_id=topic_id, operation="ADD"))
            for item in change_set.updates:
                domain_id = None if item.domain is None else resolve(item.domain)
                self._update_topic(cur, space_id, domain_id, item)
                results.append(TopicChangeResult(topic_id=item.topic_id, operation="UPDATE"))
        return results

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
                f"""UPDATE {SCHEMA}.project_entries e SET content = %s, embedding = %s::vector,
                        conflicts = '[]'::jsonb, version = version + 1, update_time = now()
                    WHERE e.id = %s AND e.entry_type = 'decision' AND e.update_time = %s
                    RETURNING {_ENTRY_COLS}""",
                (content, embedding, decision_id, expected_update_time),
            )
            row = cur.fetchone()
        if row is None:
            raise UpdateConflictError(
                f"Decision {decision_id} changed since {expected_update_time.isoformat()}"
            )
        return self._entry(row)

    def delete_topics(self, topic_ids: list[str]) -> int:
        if not topic_ids:
            return 0
        with self._tx() as cur:
            cur.execute(f"DELETE FROM {SCHEMA}.topics WHERE id = ANY(%s)", (list(topic_ids),))
            return cur.rowcount

    def clear_space(self, space_id: str) -> int:
        with self._tx() as cur:
            # FOR UPDATE waits for in-flight apply_changes (FOR KEY SHARE) on this space.
            cur.execute(f"SELECT 1 FROM {SCHEMA}.spaces WHERE id = %s FOR UPDATE", (space_id,))
            if cur.fetchone() is None:
                raise SpaceNotFoundError(f"Space not found: {space_id}")
            # clock_timestamp(), not now(): stamp the moment the clear takes effect, after
            # waiting for in-flight write-backs, so tasks accepted meanwhile are rejected.
            cur.execute(
                f"UPDATE {SCHEMA}.spaces SET cleared_at = clock_timestamp() WHERE id = %s",
                (space_id,),
            )
            cur.execute(f"DELETE FROM {SCHEMA}.topics WHERE space_id = %s", (space_id,))
            return cur.rowcount

    # ---------- search ----------
    def search_topics(
        self,
        space_ids: list[str],
        query_vec: list[float],
        query_text: str | None = None,
        domains: list[str] | None = None,
        filters: list[TopicFilter] | None = None,
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
