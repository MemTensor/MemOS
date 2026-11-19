"""Scoped PostgreSQL reads over the committed search index."""

from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from memos.project_memory.index import Vector, terms
from memos.project_memory.views import (
    ENTRY_FIELDS,
    ITEM_TYPES,
    component,
    default_timezone,
    timestamp,
    topic_detail,
)


class MissingSpaceError(LookupError):
    pass


class AmbiguousMemoryError(LookupError):
    pass


class UnknownDomainError(ValueError):
    pass


@dataclass(frozen=True)
class Scope:
    tenant: str
    spaces: tuple[str, ...] | None
    domains: tuple[str, ...] = ()

    def params(self) -> dict:
        return {
            "tenant": self.tenant,
            "spaces": None if self.spaces is None else list(self.spaces),
            "domains": list(self.domains),
        }


# All reads, including ID lookup, observe current space deletion and clear fences.
VISIBLE = """
    FROM memos_project.pm_retrieval_items i
    JOIN memos_project.pm_retrieval_roots r USING (tenant_id,space_id,root_id)
    JOIN memos_project.pm_spaces s USING (tenant_id,space_id)
    WHERE i.tenant_id=%(tenant)s AND (%(spaces)s::text[] IS NULL OR i.space_id=ANY(%(spaces)s))
      AND s.deleted_at IS NULL AND (s.cleared_at IS NULL OR r.accepted_at>s.cleared_at)
"""


@dataclass(frozen=True)
class IndexQuery:
    qid: str
    text: str
    vector: Vector | None = None


@dataclass
class Hit:
    group: str
    data: dict
    score: float
    current_session: bool = False
    kind: str | None = None

    @property
    def key(self) -> tuple[str, str, str]:
        return self.group, self.data.get("space_id", ""), self.data["id"]


class RetrievalStore:
    def __init__(self, pool: Any):
        self.pool = pool

    @contextmanager
    def cursor(self) -> Iterator[Any]:
        conn = self.pool.getconn()
        try:
            with conn, conn.cursor() as cur:
                cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                cur.execute("SET LOCAL statement_timeout = '240ms'")
                yield cur
        finally:
            self.pool.putconn(conn)

    def validate(self, scope: Scope) -> None:
        if not scope.spaces:
            raise MissingSpaceError
        with self.cursor() as cur:
            cur.execute(
                """
                SELECT s.space_id, d.domain FROM memos_project.pm_spaces s
                LEFT JOIN memos_project.pm_domains d USING(space_id)
                WHERE s.tenant_id=%(tenant)s AND s.space_id=ANY(%(spaces)s)
                    AND s.deleted_at IS NULL
            """,
                scope.params(),
            )
            rows = cur.fetchall()
        if set(scope.spaces) != {space for space, _ in rows}:
            raise MissingSpaceError
        if any(
            set(scope.domains) - {domain for sid, domain in rows if sid == space}
            for space in scope.spaces
        ):
            raise UnknownDomainError

    def _candidates(
        self,
        cur: Any,
        scope: Scope,
        kinds: list[str],
        query: str,
        vector: Vector | None,
        session: str | None,
        k: int,
        per_root: int,
        topic_ids: list[str] | None = None,
    ) -> tuple[list, list, bool]:
        from psycopg2 import Error as DatabaseError

        words = list(dict.fromkeys(terms(query)))[:128]
        params = {
            **scope.params(),
            "kinds": kinds,
            "session": session or "",
            "k": k,
            "per_root": per_root,
            "tsquery": " | ".join(words),
            "cutoff": 0,
        }
        base = (
            VISIBLE
            + """
            AND i.kind=ANY(%(kinds)s)
            AND (cardinality(%(domains)s::text[])=0 OR i.domains && %(domains)s::text[])
        """
        )
        if topic_ids is not None:
            base += " AND i.root_id=ANY(%(topic_ids)s)"
            params["topic_ids"] = topic_ids
        tsquery = "to_tsquery('simple', %(tsquery)s)"
        lexical = (
            self._rank(
                cur, base, params, f"ts_rank_cd(i.keywords, {tsquery})", f"i.keywords @@ {tsquery}"
            )
            if words
            else []
        )
        if vector is None:
            return lexical, [], True
        # A vector query may time out independently. Keep the full-text result and
        # its visibility snapshot usable for assembling the response.
        params.update(
            vector=vector.sql_value(), model=vector.model, dim=len(vector.values), cutoff=0
        )
        distance = """CASE WHEN i.embedding_model=%(model)s AND vector_dims(i.embedding)=%(dim)s
                           THEN 1-(i.embedding <=> %(vector)s::vector) END"""
        cur.execute("SAVEPOINT vector_recall")
        try:
            cur.execute("SET LOCAL statement_timeout = '75ms'")
            cur.execute(
                "SELECT EXISTS(SELECT 1 "
                + base
                + """
                AND (i.embedding_model IS DISTINCT FROM %(model)s
                     OR vector_dims(i.embedding) IS DISTINCT FROM %(dim)s))""",
                params,
            )
            partial = cur.fetchone()[0]
            semantic = self._rank(cur, base, params, distance, "i.embedding IS NOT NULL")
        except DatabaseError:
            cur.execute("ROLLBACK TO SAVEPOINT vector_recall")
            semantic, partial = [], True
        cur.execute("RELEASE SAVEPOINT vector_recall")
        cur.execute("SET LOCAL statement_timeout = '240ms'")
        return lexical, semantic, partial

    def query_index(
        self,
        scope: Scope,
        index: str,
        queries: list[IndexQuery],
        k: int,
        topic_ids: list[str] | None = None,
        conversation_id: str | None = None,
    ) -> dict:
        """Shared index primitive for retrieval and topic matching; each route keeps its raw score."""
        kinds = {"topic": ["topic"], "entry": list(ENTRY_FIELDS), "trajectory": ["trajectory"]}
        if index not in kinds or k < 1:
            raise ValueError("Expected topic, entry or trajectory and positive k")
        self.validate(scope)
        results = []
        degraded = set()
        with self.cursor() as cur:
            for query in queries:
                lexical, semantic, partial = self._candidates(
                    cur,
                    scope,
                    kinds[index],
                    query.text,
                    query.vector,
                    conversation_id,
                    k,
                    k,
                    topic_ids,
                )
                if partial:
                    degraded.add("vector")
                hits = {}
                for route, rows in (("lexical", lexical), ("vector", semantic)):
                    ranked = sorted(
                        rows, key=lambda row: (-row[-1], not row[-2], row[0], row[2], row[3])
                    )
                    for space, root, id_, part, kind, payload, current, score in ranked[:k]:
                        key = (space, id_, part)
                        hit = hits.setdefault(
                            key,
                            {
                                "space_id": space,
                                "root_id": root,
                                "id": id_,
                                "part": part,
                                "kind": kind,
                                "payload": payload,
                                "from_conversation": current,
                                "scores": {},
                            },
                        )
                        hit["scores"][route] = score
                results.append({"qid": query.qid, "hits": list(hits.values())})
        return {"results": results, "degraded": sorted(degraded)}

    def recall(
        self,
        scope: Scope,
        channel: str,
        query: str,
        vector: Vector | None,
        session: str | None,
        limit: int,
        item_types: tuple[str, ...] = ITEM_TYPES,
        result_format: str = "topic",
        threshold: float = 0.45,
    ) -> tuple[list[Hit], bool]:
        flat = channel == "project" and result_format == "item"
        kinds = (
            ["trajectory"]
            if channel == "trajectory"
            else list(dict.fromkeys(item_types if flat else ("topic", *item_types)))
        )
        budget = max(10, limit * 2)
        with self.cursor() as cur:
            lexical, semantic, partial = self._candidates(
                cur, scope, kinds, query, vector, session, budget, budget if flat else 6
            )
            docs = {}
            root_strength = defaultdict(float)
            root_rank = defaultdict(float)
            entry_rank = defaultdict(float)
            strength = defaultdict(float)
            for is_vector, rows in ((False, lexical), (True, semantic)):
                roots = set()
                positions = defaultdict(int)
                for space, root, id_, part, kind, payload, current, raw in rows:
                    key = (space, root)
                    doc = (id_, part)
                    if key not in roots:
                        root_rank[key] += 1 / (61 + len(roots))
                        roots.add(key)
                    positions[key] += 1
                    entry_rank[key, doc] += 1 / (60 + positions[key])
                    relevance = raw if is_vector else raw / (raw + 0.1)
                    relevance = min(
                        1.0,
                        relevance
                        + (
                            0.1
                            if current and channel == "project" and (not flat or kind == "topic")
                            else 0
                        ),
                    )
                    strength[key, doc] = max(strength[key, doc], relevance)
                    root_strength[key] = max(root_strength[key], relevance)
                    docs.setdefault(key, {})[doc] = (kind, payload, current)
            headers = {}
            if channel == "project" and docs:
                cur.execute(
                    "SELECT i.space_id,i.id,i.payload "
                    + VISIBLE
                    + " AND i.kind='topic' AND i.id=ANY(%(roots)s)",
                    {**scope.params(), "roots": list({root for _, root in docs})},
                )
                headers = {(s, i): p for s, i, p in cur}
            hits = []
            for key, items in docs.items():
                space, root = key
                ranked = sorted(
                    items, key=lambda doc: (-strength[key, doc], -entry_rank[key, doc], doc)
                )
                kind, payload, current = items[ranked[0]]
                if channel == "trajectory":
                    data = {**payload, "space_id": space}
                    group = "trajectory_detail_list"
                elif flat:
                    for doc in ranked:
                        score = strength[key, doc]
                        if score >= threshold:
                            kind, payload, current = items[doc]
                            data = component(kind, payload, headers[key], space, False)
                            data["relativity"] = score
                            hits.append(
                                Hit("project_item_list", data, entry_rank[key, doc], current, kind)
                            )
                    continue
                else:
                    if root_strength[key] < threshold:
                        continue
                    entries = [items[d][:2] for d in ranked if items[d][0] in ENTRY_FIELDS]
                    data = topic_detail(headers[key], space, entries[:5], False)
                    group = "topic_detail_list"
                data["relativity"] = root_strength[key]
                hits.append(Hit(group, data, root_rank[key], current))
            hits.sort(key=lambda h: (-h.data["relativity"], -h.score, not h.current_session, h.key))
            return hits[:budget], partial

    @staticmethod
    def _rank(cur: Any, base: str, params: dict, score: str, condition: str) -> list:
        cur.execute(
            """
            WITH scored AS (
                SELECT i.space_id,i.root_id,i.id,i.part,i.kind,
                       %(session)s=ANY(i.conversations) AS in_session, """
            + score
            + " AS score "
            + base
            + " AND "
            + condition
            + """
            ), ranked AS (
                SELECT *,row_number() OVER(PARTITION BY space_id,root_id
                    ORDER BY score DESC,id,part) AS n
                FROM scored WHERE score>%(cutoff)s
            ), roots AS (
                SELECT space_id,root_id,score AS best,in_session FROM ranked WHERE n=1
                ORDER BY best DESC,in_session DESC,space_id,root_id LIMIT %(k)s
            )
            SELECT r.space_id,r.root_id,r.id,r.part,r.kind,i.payload,r.in_session,r.score
            FROM roots JOIN ranked r USING(space_id,root_id)
            JOIN memos_project.pm_retrieval_items i ON i.tenant_id=%(tenant)s AND
                (i.space_id,i.id,i.part)=(r.space_id,r.id,r.part) WHERE r.n<=%(per_root)s
            ORDER BY roots.best DESC,roots.in_session DESC,r.space_id,r.root_id,r.n
        """,
            params,
        )
        return cur.fetchall()

    def get(self, scope: Scope, memory_id: str, metadata_only: bool) -> dict | None:
        params = {**scope.params(), "id": memory_id}
        with self.cursor() as cur:
            cur.execute(
                "SELECT i.space_id,i.root_id,i.kind,r.immutable "
                + VISIBLE
                + " AND i.id=%(id)s AND i.part=0 LIMIT 2",
                params,
            )
            matches = cur.fetchall()
            if len(matches) > 1:
                raise AmbiguousMemoryError
            if not matches:
                return None
            space, root, kind, immutable = matches[0]
            data = {
                "id": memory_id,
                "space_id": space,
                "kind": kind,
                "cache_policy": "immutable" if immutable else "live",
            }
            if kind != "trajectory":
                data["topic_id"] = root
            if metadata_only:
                return data
            params.update(root=root, spaces=[space])
            predicate = (
                "i.root_id=%(root)s"
                if kind == "topic"
                else "(i.id=%(id)s OR (i.kind='topic' AND i.id=%(root)s))"
            )
            cur.execute(
                "SELECT i.kind,i.payload "
                + VISIBLE
                + " AND "
                + predicate
                + " ORDER BY i.position,i.id",
                params,
            )
            rows = cur.fetchall()
            if kind == "trajectory":
                return {
                    **rows[0][1],
                    **data,
                    "content": "".join(item["content"] for _, item in rows),
                }
            header = next(item for k, item in rows if k == "topic")
            if kind == "topic":
                return {**topic_detail(header, space, rows, True), **data}
            payload = next(item for k, item in rows if k == kind)
            return {**component(kind, payload, header, space, True), **data}

    def list_topics(self, scope: Scope, page: int, size: int | None, filters: dict) -> dict:
        """Count, page and hydrate the visible topics in one repeatable-read transaction."""
        self.validate(scope)
        params = scope.params()
        (space,) = scope.spaces
        where = VISIBLE + " AND i.kind='topic'"
        if set(filters) - {"related_id", "create_time", "update_time"}:
            raise ValueError("Unsupported project topic filter")
        if "related_id" in filters:
            related = filters["related_id"]
            if isinstance(related, dict) and set(related) == {"contains"}:
                related = related["contains"]
            if not isinstance(related, str) or not related.strip():
                raise ValueError("related_id must be a member or agent ID")
            params["related"] = related
            where += """ AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.payload->'sources') src
                WHERE (src->'user_id') ? %(related)s OR (src->'agent_id') ? %(related)s
                OR src->>'agent_id'=%(related)s)"""

        def time_column(field: str) -> str:
            # Older snapshots may carry only a year or month.
            value = f"(i.payload->>'{field}')"
            return f"""(CASE WHEN {value} ~ '^[0-9]{{4}}$' THEN {value}||'-01-01'
                    WHEN {value} ~ '^[0-9]{{4}}-[0-9]{{2}}$' THEN {value}||'-01' ELSE {value} END)::timestamptz"""

        operators = {"gte": ">=", "gt": ">", "lte": "<=", "lt": "<", "eq": "="}
        for field in ("create_time", "update_time"):
            if field not in filters:
                continue
            bounds = filters[field]
            if not isinstance(bounds, dict) or not bounds or set(bounds) - operators.keys():
                raise ValueError("Invalid topic time filter")
            for op, value in bounds.items():
                if not isinstance(value, str):
                    raise ValueError("Expected an ISO date or timestamp")
                name = f"{field}_{op}"
                params[name] = timestamp(value)
                where += f" AND {time_column(field)} {operators[op]} %({name})s"
        with self.cursor() as cur:
            cur.execute("SELECT set_config('TimeZone',%s,true)", (str(default_timezone()),))
            cur.execute("SELECT count(*) " + where, params)
            total = cur.fetchone()[0]
            query = (
                "SELECT i.id,i.payload "
                + where
                + " ORDER BY "
                + time_column("update_time")
                + " DESC,i.id"
            )
            if size is not None:
                query += " LIMIT %(size)s OFFSET %(offset)s"
                params.update(size=size, offset=(page - 1) * size)
            cur.execute(query, params)
            headers = cur.fetchall()
            entries = defaultdict(list)
            if headers:
                cur.execute(
                    "SELECT i.root_id,i.kind,i.payload "
                    + VISIBLE
                    + " AND i.kind=ANY(%(kinds)s) AND i.root_id=ANY(%(roots)s) ORDER BY i.position,i.id",
                    {**params, "kinds": list(ENTRY_FIELDS), "roots": [i for i, _ in headers]},
                )
                for root, kind, payload in cur:
                    entries[root].append((kind, payload))
            return {
                "space_id": space,
                "total": total,
                "topic_detail_list": [
                    topic_detail(header, space, entries[root], True) for root, header in headers
                ],
            }

    def visible_spaces(self, scope: Scope) -> list[str]:
        with self.cursor() as cur:
            cur.execute(
                """SELECT space_id FROM memos_project.pm_spaces
                WHERE tenant_id=%(tenant)s AND deleted_at IS NULL
                AND (%(spaces)s::text[] IS NULL OR space_id=ANY(%(spaces)s)) ORDER BY space_id""",
                scope.params(),
            )
            return [s for (s,) in cur]

    def log_recall(self, scope: Scope, session: str, topics: list[dict]) -> None:
        with self.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO memos_project.pm_retrieval_log
                    (tenant_id,space_id,conversation_id,topic_id,decision_ids,conflicting_decision_ids)
                VALUES (%s,%s,%s,%s,%s,%s)
            """,
                [
                    (
                        scope.tenant,
                        t["space_id"],
                        session,
                        t["id"],
                        [d["id"] for d in t["decisions"]],
                        [d["id"] for d in t["decisions"] if d.get("conflicts")],
                    )
                    for t in topics
                ],
            )
