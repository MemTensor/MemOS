"""Scoped reads from the same PostgreSQL rows that Add commits."""

from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from memos.project_memory.add_layout import load_topics
from memos.project_memory.index import Vector
from memos.project_memory.topic_projection import topic_snapshot
from memos.project_memory.views import (
    ENTRY_FIELDS,
    budget,
    entry_view,
    parse_topic_filters,
    time_key,
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
    tenant: str | None
    spaces: tuple[str, ...] | None
    domains: tuple[str, ...] = ()

    def params(self) -> dict:
        return {
            "tenant": self.tenant,
            "spaces": None if self.spaces is None else list(self.spaces),
            "domains": list(self.domains),
        }


@dataclass
class Hit:
    group: str
    data: dict
    score: float
    current_session: bool = False
    kind: str | None = None

    @property
    def key(self) -> tuple:
        key = (self.group, self.data.get("space_id", ""), self.data["id"])
        if self.kind in {"turn", "message"}:
            return (*key, self.kind, self.data["conversation_id"])
        return key


SPACE = """(%(tenant)s::text IS NULL OR s.project_id=%(tenant)s)
       AND (%(spaces)s::text[] IS NULL OR s.id=ANY(%(spaces)s))"""
DOMAIN = "(cardinality(%(domains)s::text[])=0 OR d.domain=ANY(%(domains)s))"
TOPICS = "FROM topics t JOIN spaces s ON s.id=t.space_id JOIN domains d ON d.id=t.domain_id"
EPISODES = """FROM episodes e JOIN spaces s ON s.id=e.space_id
              LEFT JOIN topics t ON t.id=e.topic_id AND t.space_id=e.space_id LEFT JOIN domains d ON d.id=t.domain_id"""
LIVE = "(s.clear_time IS NULL OR e.create_time>s.clear_time)"
MESSAGES = """ JOIN messages m ON m.project_id=s.project_id AND m.conversation_key=e.conversation_key
               AND m.msg_seq BETWEEN e.message_seq_start AND e.message_seq_end"""
# Both ends of the ordered Turn must be visible together to return its skeleton.
TURNS = """ JOIN turns u ON u.project_id=s.project_id AND u.conversation_key=e.conversation_key
            JOIN messages first_msg ON (first_msg.project_id,first_msg.conversation_key,first_msg.message_id)=
                (u.project_id,u.conversation_key,u.msg_ids[1])
            JOIN messages last_msg ON (last_msg.project_id,last_msg.conversation_key,last_msg.message_id)=
                (u.project_id,u.conversation_key,u.msg_ids[cardinality(u.msg_ids)])
            AND first_msg.msg_seq >= e.message_seq_start AND last_msg.msg_seq <= e.message_seq_end"""
TRACE_SCOPE = f"{SPACE} AND {DOMAIN} AND {LIVE}"
EPISODE_COLS = "e.id, e.space_id, e.conversation_key AS conversation_id, e.topic_id"
MESSAGE_COLS = """m.message_id AS id, m.message_id, m.conversation_key AS conversation_id,
                  e.space_id, e.id AS episode_id, e.topic_id, m.content, m.role, m.role_id,
                  m.role_name, m.agent_id, m.tool_calls, m.tool_call_id, m.chat_time, m.task_id AS source_task_id"""
TURN_COLS = """u.turn_id AS id, u.turn_id, u.conversation_key AS conversation_id, u.msg_ids AS message_ids,
               e.space_id, e.id AS episode_id, e.topic_id, u.content"""
TS_QUERY = "replace(plainto_tsquery(%(config)s::regconfig,%(query)s)::text,' & ',' | ')::tsquery"


def _evidence_source(kind: str) -> str:
    """Choose one visible Episode per source before applying rank and LIMIT. A Turn
    needs its entire interval; a Message needs only its own sequence number."""
    if kind == "message":
        source = "FROM messages m"
        alias = "m"
        bounds = "m.msg_seq BETWEEN e.message_seq_start AND e.message_seq_end"
    else:
        source = """FROM turns u
                    JOIN messages first_msg ON (first_msg.project_id,first_msg.conversation_key,first_msg.message_id)=
                        (u.project_id,u.conversation_key,u.msg_ids[1])
                    JOIN messages last_msg ON (last_msg.project_id,last_msg.conversation_key,last_msg.message_id)=
                        (u.project_id,u.conversation_key,u.msg_ids[cardinality(u.msg_ids)])"""
        alias = "u"
        bounds = (
            "first_msg.msg_seq >= e.message_seq_start AND last_msg.msg_seq <= e.message_seq_end"
        )
    return f"""{source} JOIN LATERAL (
               SELECT e.id,e.topic_id,e.space_id {EPISODES}
               WHERE {TRACE_SCOPE} AND s.project_id={alias}.project_id
                 AND e.conversation_key={alias}.conversation_key AND {bounds}
               ORDER BY e.space_id,e.id LIMIT 1) e ON true"""


def _ranked(cur, fields, source, where, params, alias, *, semantic=False, per_topic=False):
    if semantic:
        # Keep the distance expression indexable by pgvector.
        measure = f"{alias}.embedding <=> %(vector)s::vector"
        condition = f"{alias}.embedding IS NOT NULL"
        order = "ASC"
    else:
        measure = f"ts_rank_cd({alias}.search_tsv, q)"
        source += f" CROSS JOIN (SELECT {TS_QUERY} AS q) query_terms"
        condition = f"{alias}.search_tsv @@ q"
        order = "DESC"
    statement = f"SELECT {fields}, {measure} AS measure {source} WHERE {where} AND {condition}"
    if per_topic:
        statement = f"""SELECT DISTINCT ON (topic_id,id) * FROM ({statement}) matches
                        ORDER BY topic_id,id,measure {order}"""
        statement = f"""SELECT * FROM (SELECT scored.*, row_number() OVER
                   (PARTITION BY topic_id ORDER BY measure {order}, id) AS position
                   FROM ({statement}) scored) ranked WHERE position<=%(k)s"""
    cur.execute(
        statement
        + f" ORDER BY measure {order}"
        + (", (%(session)s=ANY(conversation_ids)) DESC NULLS LAST" if alias in {"t", "x"} else "")
        + ", id, space_id"
        + (", conversation_id" if alias in {"u", "m"} else "")
        + ("" if per_topic else " LIMIT %(k)s"),
        params,
    )
    return cur.fetchall()


def _search_rows(cur, fields, source, where, params, alias, *, lexical=True, per_topic=False):
    from psycopg2 import DataError, OperationalError

    text = (
        _ranked(cur, fields, source, where, params, alias, per_topic=per_topic) if lexical else []
    )
    if params["vector"] is None:
        return text, [], True
    cur.execute("SAVEPOINT semantic_search")
    try:
        cur.execute(f"SET LOCAL statement_timeout = '{round(budget(75))}ms'")
        semantic = _ranked(
            cur, fields, source, where, params, alias, semantic=True, per_topic=per_topic
        )
    except (DataError, OperationalError):
        cur.execute("ROLLBACK TO SAVEPOINT semantic_search")
        return text, [], True
    finally:
        cur.execute("RELEASE SAVEPOINT semantic_search")
        cur.execute(f"SET LOCAL statement_timeout = '{round(budget(240))}ms'")
    return text, [r for r in semantic if 1 - r["measure"] >= 0.35], False


def _rank_topics(lexical, semantic, session):
    """The strongest matching row determines relevance; use reciprocal ranks to break ties."""
    scores = {}
    for rows, is_vector in ((lexical, False), (semantic, True)):
        seen = set()
        for rank, row in enumerate(rows, 1):
            key = row["id"]
            score = 1 - row["measure"] if is_vector else row["measure"] / (row["measure"] + 0.1)
            current = bool(session and session in row["conversation_ids"])
            if current and row["kind"] == "topic":
                score = min(1, score + 0.1)
            strength, rrf, _ = scores.get(key, (0, 0, row))
            scores[key] = max(strength, score), rrf + (0 if key in seen else 1 / (60 + rank)), row
            seen.add(key)
    return sorted(scores.values(), key=lambda item: (-item[0], -item[1], item[2]["id"]))


def _snapshots(cur, ids, entry_ids=None):
    rows = load_topics(cur, "t.id=ANY(%s)", (ids,), entry_ids=entry_ids) if ids else []
    return {row["id"]: topic_snapshot(row).model_dump(exclude_none=True) for row in rows}


def _header(snapshot):
    return {k: v for k, v in snapshot.items() if k not in ENTRY_FIELDS.values()}


def _items(snapshot):
    return [(kind, item) for kind, field in ENTRY_FIELDS.items() for item in snapshot[field]]


def _topic_preview(snap, space):
    data = topic_detail(_header(snap), space, [], False)
    for kind, field in ENTRY_FIELDS.items():
        recent = sorted(snap[field], key=time_key, reverse=True)[:5]
        data[field] = [
            {
                k: v
                for k, v in entry_view(kind, item, False).items()
                if k not in {"history", "conflicts"}
            }
            for item in recent
        ]
    return data


class RetrievalStore:
    def __init__(self, pool: Any, schema: str = "project_memory"):
        self.pool = pool
        self.schema = schema

    @contextmanager
    def cursor(self) -> Iterator[Any]:
        from psycopg2 import sql
        from psycopg2.extras import RealDictCursor

        conn = self.pool.getconn()
        try:
            with conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                cur.execute(
                    sql.SQL("SET LOCAL search_path TO {}, public").format(
                        sql.Identifier(self.schema)
                    )
                )
                cur.execute(f"SET LOCAL statement_timeout = '{round(budget(240))}ms'")
                yield cur
        finally:
            self.pool.putconn(conn)

    def validate(self, scope: Scope) -> Scope:
        if not scope.spaces:
            raise MissingSpaceError
        with self.cursor() as cur:
            cur.execute(
                f"""SELECT s.project_id,s.id,d.domain FROM spaces s
                         LEFT JOIN domains d ON d.space_id=s.id WHERE {SPACE}""",
                scope.params(),
            )
            rows = cur.fetchall()
        tenants = {r["project_id"] for r in rows}
        if len(tenants) != 1 or set(scope.spaces) != {r["id"] for r in rows}:
            raise MissingSpaceError
        if any(
            set(scope.domains) - {r["domain"] for r in rows if r["id"] == space}
            for space in scope.spaces
        ):
            raise UnknownDomainError
        return Scope(tenants.pop(), scope.spaces, scope.domains)

    def recall(
        self,
        scope: Scope,
        channel: str,
        query: str,
        vector: Vector | None,
        session: str | None,
        limit: int,
        threshold: float = 0.45,
    ) -> tuple[list[Hit], bool]:
        params = {
            **scope.params(),
            "k": max(10, limit * 2),
            "query": query,
            "session": session,
            "config": self.schema + ".zh",
            "vector": vector.sql_value() if vector else None,
        }
        with self.cursor() as cur:
            if channel == "project":
                return self._topics(cur, params, session, threshold)
            if channel == "episode":
                return self._episodes(cur, params, session)
            if channel == "trajectory":
                return self._trajectory(cur, params, session)
            raise ValueError("Unknown project recall channel")

    def _topics(self, cur, params, session, threshold):
        cols = "t.id,t.space_id,t.conversation_ids,'topic' AS kind"
        text, vec, partial = _search_rows(cur, cols, TOPICS, f"{SPACE} AND {DOMAIN}", params, "t")
        roots = _rank_topics(text, vec, session)
        ids = [r["id"] for _, _, r in roots][: params["k"]]
        entries = defaultdict(list)
        if ids:
            cols = """COALESCE(x.parent_decision_id,x.id) AS id,t.space_id,t.id AS topic_id,
                      t.conversation_ids,x.entry_type AS kind"""
            text, vec, missing = _search_rows(
                cur,
                cols,
                TOPICS + " JOIN project_entries x ON x.topic_id=t.id",
                "t.id=ANY(%(ids)s) AND (x.status=0 OR x.parent_decision_id IS NOT NULL)",
                {**params, "ids": ids},
                "x",
                per_topic=True,
            )
            partial |= missing
            for score, rank, row in _rank_topics(text, vec, session):
                entries[row["topic_id"]].append((score, rank, row))
        entry_ids = [row["id"] for ranked in entries.values() for _, _, row in ranked]
        snapshots = _snapshots(cur, ids, entry_ids)
        hits = []
        for root_score, root_rank, root in roots[: len(ids)]:
            sid, tid = root["space_id"], root["id"]
            snap = snapshots[tid]
            header = _header(snap)
            current = bool(session and session in root["conversation_ids"])
            items = {item["id"]: (kind, item) for kind, item in _items(snap)}
            ranked = [
                (score, rank, *items[row["id"]])
                for score, rank, row in entries[tid]
                if row["id"] in items
            ]
            score = max([root_score, *(s for s, *_ in ranked)])
            if score >= threshold:
                data = topic_detail(header, sid, [(k, v) for _, _, k, v in ranked], False)
                hits.append(
                    Hit("project_item_list", {**data, "relativity": score}, root_rank, current)
                )
        hits.sort(key=lambda h: (-h.data["relativity"], -h.score, not h.current_session, h.key))
        return hits[: params["k"]], partial

    def _episodes(self, cur, params, session):
        cols = EPISODE_COLS + ", e.episode_summary AS content"
        text, vec, partial = _search_rows(
            cur, cols, EPISODES, TRACE_SCOPE + " AND e.episode_summary <> ''", params, "e"
        )
        hits = {}
        for lane in (text, vec):
            for rank, row in enumerate(lane, 1):
                key = row["id"]
                if key not in hits:
                    data = {k: v for k, v in row.items() if k != "measure"}
                    hits[key] = Hit(
                        "project_item_list", data, 0, row["conversation_id"] == session, "episode"
                    )
                hits[key].score += 1 / (60 + rank)
        return _ordered_hits(hits.values(), params["k"]), partial

    def _trajectory(self, cur, params, session):
        text = _ranked(
            cur,
            MESSAGE_COLS,
            _evidence_source("message"),
            "m.role<>'system'",
            params,
            "m",
        )
        _, turns, partial = _search_rows(
            cur, TURN_COLS, _evidence_source("turn"), "TRUE", params, "u", lexical=False
        )
        if not text:
            hits = [_trace_hit(row, "turn", 1 - row["measure"], session) for row in turns]
            return _ordered_hits(hits, params["k"]), partial

        # Give every member the rank of its best matching Turn, regardless of Turn length.
        # Message ids are local to a tenant and conversation. The Episode identifies its Space.
        scores = defaultdict(float)
        rows = {}
        for rank, row in enumerate(text, 1):
            key = row["conversation_id"], row["id"]
            scores[key] = 0.6 / (60 + rank)
            rows[key] = row
        best_turn = {}
        for rank, turn in enumerate(turns, 1):
            for mid in turn["message_ids"]:
                best_turn.setdefault(
                    (turn["conversation_id"], mid), (0.4 / (60 + rank), turn["episode_id"])
                )
        for key, (score, _episode_id) in best_turn.items():
            scores[key] += score
        keys = list(scores)
        missing = [key for key in keys if key not in rows]
        if missing:
            cur.execute(
                f"""SELECT {MESSAGE_COLS} {EPISODES}{MESSAGES}
                         JOIN unnest(%(episodes)s::text[],%(ids)s::text[]) AS hit(eid,mid)
                           ON hit.eid=e.id AND hit.mid=m.message_id
                         WHERE {TRACE_SCOPE} AND m.role<>'system'""",
                {
                    **params,
                    "episodes": [best_turn[k][1] for k in missing],
                    "ids": [k[1] for k in missing],
                },
            )
            rows.update({(r["conversation_id"], r["id"]): r for r in cur})
        return _ordered_hits(
            [_trace_hit(rows[k], "message", scores[k], session) for k in keys if k in rows],
            params["k"],
        ), partial

    def get(
        self,
        scope: Scope,
        memory_id: str,
        metadata_only: bool,
        kind: str | None = None,
        conversation: str | None = None,
    ) -> dict | None:
        # The gateway can return a typed reference; Add also accepts caller-assigned opaque IDs.
        if kind is None:
            for prefix, evidence in (
                ("msg_", "message"),
                ("turn_", "turn"),
                ("ep-", "episode"),
                ("episode_", "episode"),
            ):
                if memory_id.startswith(prefix):
                    kind = evidence
                    break
        params = {**scope.params(), "id": memory_id, "kind": kind, "conversation": conversation}
        with self.cursor() as cur:
            if kind or conversation:
                return self._get_evidence(cur, params, metadata_only)
            cur.execute(
                f"""SELECT t.id AS topic_id,t.space_id,'topic' AS kind,t.id {TOPICS}
                            WHERE {SPACE} AND t.id=%(id)s
                            UNION ALL SELECT t.id,t.space_id,x.entry_type,COALESCE(x.parent_decision_id,x.id)
                            {TOPICS} JOIN project_entries x ON x.topic_id=t.id
                            WHERE {SPACE} AND x.id=%(id)s AND (x.status=0 OR x.parent_decision_id IS NOT NULL)""",
                params,
            )
            row = cur.fetchone()
            if row:
                data = {**row, "cache_policy": "live"}
                if metadata_only:
                    return data
                snap = _snapshots(cur, [row["topic_id"]])[row["topic_id"]]
                header = _header(snap)
                if row["kind"] == "topic":
                    return {**topic_detail(header, row["space_id"], _items(snap), True), **data}
                kind, item = next((k, i) for k, i in _items(snap) if i["id"] == row["id"])
                return {
                    **entry_view(kind, item, True),
                    "domain": header["domain"],
                    "topic_name": header["topic_name"],
                    **data,
                }
            return self._get_evidence(cur, params, metadata_only)

    def _get_evidence(self, cur, params, metadata_only):
        matches = []
        for kind, cols, joins, where in (
            (
                "episode",
                EPISODE_COLS + ", e.episode_summary AS content",
                "",
                "e.id=%(id)s AND e.episode_summary<>''",
            ),
            ("message", MESSAGE_COLS, MESSAGES, "m.message_id=%(id)s AND m.role<>'system'"),
            ("turn", TURN_COLS, TURNS, "u.turn_id=%(id)s"),
        ):
            if params.get("kind") and kind != params["kind"]:
                continue
            cur.execute(
                f"SELECT DISTINCT ON (e.space_id,e.conversation_key) {cols} {EPISODES}{joins} WHERE {TRACE_SCOPE} AND {where} "
                "AND (%(conversation)s::text IS NULL OR e.conversation_key=%(conversation)s) "
                "ORDER BY e.space_id,e.conversation_key,e.id LIMIT 2",
                {**params, "conversation": params.get("conversation")},
            )
            matches.extend({**r, "kind": kind, "cache_policy": "live"} for r in cur)
        if len(matches) > 1:
            raise AmbiguousMemoryError
        if matches:
            row = matches[0]
            return {
                k: v
                for k, v in row.items()
                if not metadata_only
                or k in {"kind", "id", "space_id", "conversation_id", "cache_policy"}
            }
        return None

    def list_topics(self, scope: Scope, page: int, size: int | None, filters: dict) -> dict:
        scope = self.validate(scope)
        params = scope.params()
        where = SPACE
        related, bounds = parse_topic_filters(filters)
        if related is not None:
            params["related"] = related
            where += """ AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.sources) src
                WHERE (src->'user_id') ? %(related)s OR src->>'agent_id'=%(related)s)"""
        operators = {"gte": ">=", "gt": ">", "lte": "<=", "lt": "<", "eq": "="}
        for field, op, bound in bounds:
            name = f"{field}_{op}"
            params[name] = bound
            where += f" AND t.{field} {operators[op]} %({name})s"
        with self.cursor() as cur:
            cur.execute(f"SELECT count(*) AS n {TOPICS} WHERE {where}", params)
            total = cur.fetchone()["n"]
            sql = f"SELECT t.id {TOPICS} WHERE {where} ORDER BY t.update_time DESC,t.id"
            if size is not None:
                sql += " LIMIT %(size)s OFFSET %(offset)s"
                params.update(size=size, offset=(page - 1) * size)
            cur.execute(sql, params)
            ids = [r["id"] for r in cur]
            cur.execute(
                """SELECT id FROM (
                SELECT id, row_number() OVER (PARTITION BY topic_id,entry_type ORDER BY chat_time DESC,id) n
                FROM project_entries WHERE topic_id=ANY(%s) AND status=0
            ) preview WHERE n<=5""",
                (ids,),
            )
            snaps = _snapshots(cur, ids, [row["id"] for row in cur])
            (space,) = scope.spaces
            return {
                "space_id": space,
                "total": total,
                "topic_detail_list": [_topic_preview(snaps[i], space) for i in ids],
            }

    def list_entries(
        self, scope: Scope, topic: str, kind: str, page: int, size: int
    ) -> dict | None:
        params = {
            **scope.params(),
            "topic": topic,
            "kind": kind,
            "size": size,
            "offset": (page - 1) * size,
        }
        with self.cursor() as cur:
            cur.execute(f"SELECT t.id {TOPICS} WHERE {SPACE} AND t.id=%(topic)s", params)
            if cur.fetchone() is None:
                return None
            where = (
                "FROM project_entries WHERE topic_id=%(topic)s AND entry_type=%(kind)s AND status=0"
            )
            cur.execute("SELECT count(*) AS n " + where, params)
            total = cur.fetchone()["n"]
            cur.execute(
                "SELECT id "
                + where
                + " ORDER BY chat_time DESC,id LIMIT %(size)s OFFSET %(offset)s",
                params,
            )
            ids = [row["id"] for row in cur]
            items = []
            if ids:
                snap = _snapshots(cur, [topic], ids)[topic]
                by_id = {
                    item["id"]: entry_view(kind, item, True) for item in snap[ENTRY_FIELDS[kind]]
                }
                items = [by_id[i] for i in ids]
            return {"total": total, "entry_detail_list": items}

    def messages(self, scope: Scope, conversation: str, limit: int | None) -> list[dict]:
        """Read each message once, even when multiple authorized Episodes cover it."""
        with self.cursor() as cur:
            if scope.spaces:
                cur.execute(f"SELECT s.id FROM spaces s WHERE {SPACE}", scope.params())
                if {row["id"] for row in cur} != set(scope.spaces):
                    raise MissingSpaceError
            params = {**scope.params(), "conversation": conversation, "limit": limit}
            cur.execute(
                f"""SELECT DISTINCT s.project_id {EPISODES}{MESSAGES}
                           WHERE {TRACE_SCOPE} AND e.conversation_key=%(conversation)s LIMIT 2""",
                params,
            )
            if len(cur.fetchall()) > 1:
                raise AmbiguousMemoryError
            cur.execute(
                f"""SELECT * FROM (SELECT m.message_id,m.role,m.content,m.chat_time,m.role_id,
                            m.role_name,m.tool_calls,m.tool_call_id,m.msg_seq FROM messages m
                            WHERE m.conversation_key=%(conversation)s AND m.role IN ('user','assistant','tool') AND EXISTS
                            (SELECT 1 {EPISODES} WHERE {TRACE_SCOPE} AND m.project_id=s.project_id
                              AND m.conversation_key=e.conversation_key
                              AND m.msg_seq BETWEEN e.message_seq_start AND e.message_seq_end)
                            ORDER BY m.msg_seq DESC LIMIT %(limit)s) page ORDER BY msg_seq""",
                params,
            )
            return [
                {k: v for k, v in row.items() if k != "msg_seq" and v is not None} for row in cur
            ]


def _trace_hit(row, kind, score, session):
    fields = (
        "id",
        "space_id",
        "conversation_id",
        "content",
        "message_id",
        "message_ids",
        "role",
        "tool_calls",
    )
    data = {k: row[k] for k in fields if row.get(k) is not None}
    return Hit("project_item_list", data, score, data["conversation_id"] == session, kind)


def _ordered_hits(hits, k):
    ordered = sorted(hits, key=lambda h: (-h.score, not h.current_session, h.key))[:k]
    if ordered:
        for hit in ordered:
            hit.data["relativity"] = hit.score / ordered[0].score
    return ordered
