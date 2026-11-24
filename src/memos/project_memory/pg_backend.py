"""项目记忆自己的 PostgreSQL 存储（多副本部署用的共享库）。

为什么不用核心的 `graph_dbs/postgres.py`：开源与企业版都在大改那个文件（企业版
pgvector 分支 +2482 / −445 行），在它上面加条件写或全文检索，每次合并都会冲突。
这里只实现项目记忆用到的 7 个 `BaseGraphDB` 方法，放在插件目录里，与核心互不影响。

表结构照老库 `Memory` 表（行可以原样搬到别的后端）：

| 列 | 说明 |
| --- | --- |
| `id` | 节点 id |
| `properties` | JSONB，全部元数据，含 `memory`、`user_name`、`memory_type`、`status` |
| `embedding` | pgvector 的 `vector(n)`；没装 pgvector 时是 `real[]`，向量检索退回精确扫描 |
| `created_at` / `updated_at` | 时间 |

比老表多的：
- `rev`：每次写加一。`add_node(..., expected_rev=n)` 只在库里仍是第 n 版时写，否则抛
  `ConcurrentUpdateError`（乐观并发，多副本同时改同一条决策或经验时兜底）。
- `body`：全文检索用的文本（`search_text` 或 `memory`）。
- `seq`：写入顺序，按条件查询时照它排序（与 SQLite 后端一致）。
- `user_name` / `memory_type` / `status`：从 `properties` 派生的生成列，只为建索引。

中文全文：PostgreSQL 自带的分词把整段中文当一个词，召回不出来；这里按二元组 `ILIKE`
计分（装了 pg_trgm 时建 trigram 索引加速），得分 = 命中的二元组占比。
"""

from __future__ import annotations

import json
import math
import re
import threading

from contextlib import contextmanager
from datetime import datetime
from typing import TYPE_CHECKING, Any

from memos.graph_dbs.base import ConcurrentUpdateError


if TYPE_CHECKING:
    from collections.abc import Iterator


_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
_CJK_RUN = re.compile(r"[㐀-鿿]{2,}")
_WORD = re.compile(r"[A-Za-z0-9_./#-]{2,}")
MAX_TERMS = 64


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _terms(words: list[str]) -> list[str]:
    """中文切成二元组，英文数字按词；去重，最多 64 个。"""
    out: list[str] = []
    for w in words:
        for run in _CJK_RUN.findall(w or ""):
            out += [run[i : i + 2] for i in range(len(run) - 1)]
        out += [t.lower() for t in _WORD.findall(w or "")]
    seen: list[str] = []
    for t in out:
        if t not in seen:
            seen.append(t)
    return seen[:MAX_TERMS]


def _like_escape(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _cos(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b, strict=False)) / (na * nb)


def _text_value(v: Any) -> str:
    """与 `properties->>'f'` 的文本表示对齐（布尔是 true/false）。"""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


class ProjectPostgresStore:
    """项目记忆的 Postgres 存储，接口与 `BaseGraphDB` 里项目记忆用到的那几个方法一致。"""

    supports_cas = True

    def __init__(self, config: dict[str, Any]):
        import psycopg2.pool

        self.schema = config.get("schema_name") or "project_memory"
        if not _SCHEMA_RE.match(self.schema):
            raise ValueError(f"invalid schema name: {self.schema}")
        self.user_name = config.get("user_name")
        self.dim = int(config.get("embedding_dimension") or 1024)
        dsn = config.get("dsn")
        kwargs = (
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
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            1, int(config.get("max_connections", 10)), **kwargs
        )
        self._init_lock = threading.Lock()
        self.vec_enabled = False
        self.trgm_enabled = False
        self._init_schema()

    # ------------------------------------------------------------------ setup

    @contextmanager
    def _conn(self) -> Iterator[Any]:
        conn = self.pool.getconn()
        try:
            conn.autocommit = True
            yield conn
        finally:
            self.pool.putconn(conn)

    def _try(self, cur, sql: str) -> bool:
        try:
            cur.execute(sql)
            return True
        except Exception:
            return False

    def _init_schema(self) -> None:
        s = self.schema
        with self._init_lock, self._conn() as conn, conn.cursor() as cur:
            self.vec_enabled = self._try(cur, "CREATE EXTENSION IF NOT EXISTS vector")
            self.trgm_enabled = self._try(cur, "CREATE EXTENSION IF NOT EXISTS pg_trgm")
            emb_type = f"vector({self.dim})" if self.vec_enabled else "real[]"
            cur.execute(f"CREATE SCHEMA IF NOT EXISTS {s}")
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {s}.memory (
                  seq         BIGSERIAL,
                  id          TEXT PRIMARY KEY,
                  properties  JSONB NOT NULL,
                  embedding   {emb_type},
                  rev         BIGINT NOT NULL DEFAULT 1,
                  body        TEXT NOT NULL DEFAULT '',
                  created_at  TEXT NOT NULL,
                  updated_at  TEXT NOT NULL,
                  user_name   TEXT GENERATED ALWAYS AS (properties->>'user_name') STORED,
                  memory_type TEXT GENERATED ALWAYS AS (properties->>'memory_type') STORED,
                  status      TEXT GENERATED ALWAYS AS (properties->>'status') STORED
                )"""
            )
            # 表已存在时以库里的列类型为准（比如先在没装 pgvector 的库里建过）
            cur.execute(
                "SELECT data_type, udt_name FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = 'memory' AND column_name = 'embedding'",
                (s,),
            )
            row = cur.fetchone()
            self.vec_enabled = bool(row and row[1] == "vector")
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS memory_scope_idx "
                f"ON {s}.memory (user_name, memory_type, status)"
            )
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS memory_props_idx "
                f"ON {s}.memory USING gin (properties jsonb_path_ops)"
            )
            if self.trgm_enabled:
                self._try(
                    cur,
                    f"CREATE INDEX IF NOT EXISTS memory_body_trgm_idx "
                    f"ON {s}.memory USING gin (body gin_trgm_ops)",
                )

    def close(self) -> None:
        self.pool.closeall()

    def drop_schema(self) -> None:
        """删掉整个 schema（测试清理用）。"""
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(f"DROP SCHEMA IF EXISTS {self.schema} CASCADE")

    # ------------------------------------------------------------------ helpers

    _COLS = "id, properties, embedding, rev, created_at, updated_at"

    def _row_out(self, row: tuple, include_embedding: bool = False) -> dict[str, Any]:
        node_id, props, emb, rev, created_at, updated_at = row[:6]
        props = dict(props)
        memory = props.pop("memory", "")
        props.setdefault("created_at", created_at)
        props["updated_at"] = props.get("updated_at") or updated_at
        out = {"id": node_id, "memory": memory, "metadata": props, "rev": int(rev)}
        if include_embedding:
            out["metadata"]["embedding"] = self._emb_out(emb)
        return out

    def _emb_out(self, emb: Any) -> list[float] | None:
        if emb is None:
            return None
        if isinstance(emb, str):  # pgvector 文本形式 "[0.1,0.2]"
            return [float(x) for x in emb.strip("[]").split(",") if x]
        return [float(x) for x in emb]

    def _emb_in(self, emb: list[float] | None) -> Any:
        if emb is None:
            return None
        if self.vec_enabled:
            if len(emb) != self.dim:
                return None
            return "[" + ",".join(f"{float(x):.7g}" for x in emb) + "]"
        return [float(x) for x in emb]

    @staticmethod
    def _field(name: str) -> str:
        if not _FIELD_RE.match(name):
            raise ValueError(f"invalid field name: {name}")
        return name

    def _scope_where(
        self,
        user_name: str | None,
        scope: str | None,
        status: str | None,
        search_filter: dict | None,
        default_active: bool = True,
    ) -> tuple[list[str], list[Any]]:
        where, params = [], []
        if user_name:
            where.append("m.user_name = %s")
            params.append(user_name)
        if scope:
            where.append("m.memory_type = %s")
            params.append(scope)
        if status:
            where.append("m.status = %s")
            params.append(status)
        elif default_active:
            where.append("(m.status = 'activated' OR m.status IS NULL)")
        for k, v in (search_filter or {}).items():
            where.append(f"m.properties->>'{self._field(k)}' = %s")
            params.append(_text_value(v))
        return where, params

    # ------------------------------------------------------------------ nodes

    def add_node(
        self,
        id: str,
        memory: str,
        metadata: dict[str, Any],
        user_name: str | None = None,
        expected_rev: int | None = None,
    ) -> None:
        props = dict(metadata)
        emb = props.pop("embedding", None)
        props["memory"] = memory or ""
        props["user_name"] = user_name or props.get("user_name") or self.user_name
        created_at = props.get("created_at") or _now()
        body = props.get("search_text") or props["memory"]
        data = json.dumps(props, ensure_ascii=False)
        emb_v = self._emb_in(emb)
        s = self.schema
        with self._conn() as conn, conn.cursor() as cur:
            if expected_rev is None:
                cur.execute(
                    f"""
                    INSERT INTO {s}.memory AS m
                      (id, properties, embedding, rev, body, created_at, updated_at)
                    VALUES (%s, %s::jsonb, %s, 1, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      properties = EXCLUDED.properties,
                      embedding  = COALESCE(EXCLUDED.embedding, m.embedding),
                      body       = EXCLUDED.body,
                      rev        = m.rev + 1,
                      updated_at = EXCLUDED.updated_at""",
                    (id, data, emb_v, body, created_at, _now()),
                )
                return
            if expected_rev == 0:  # 调用方认为这是新行
                cur.execute(
                    f"""
                    INSERT INTO {s}.memory
                      (id, properties, embedding, rev, body, created_at, updated_at)
                    VALUES (%s, %s::jsonb, %s, 1, %s, %s, %s)
                    ON CONFLICT (id) DO NOTHING""",
                    (id, data, emb_v, body, created_at, _now()),
                )
            else:
                cur.execute(
                    f"""
                    UPDATE {s}.memory SET
                      properties = %s::jsonb,
                      embedding  = COALESCE(%s, embedding),
                      body       = %s,
                      rev        = rev + 1,
                      updated_at = %s
                    WHERE id = %s AND rev = %s""",
                    (data, emb_v, body, _now(), id, int(expected_rev)),
                )
            if cur.rowcount == 0:
                cur.execute(f"SELECT rev FROM {s}.memory WHERE id = %s", (id,))
                row = cur.fetchone()
                raise ConcurrentUpdateError(
                    f"{id}: expected rev {expected_rev}, found {row[0] if row else 0}"
                )

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        for n in nodes:
            self.add_node(n["id"], n["memory"], n.get("metadata", {}), user_name=user_name)

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        sql = f"DELETE FROM {self.schema}.memory m WHERE id = %s"
        params: list[Any] = [id]
        if user_name:
            sql += " AND m.user_name = %s"
            params.append(user_name)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)

    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        user_name = kwargs.get("user_name")
        sql = f"SELECT {self._COLS} FROM {self.schema}.memory m WHERE id = %s"
        params: list[Any] = [id]
        if user_name:
            sql += " AND m.user_name = %s"
            params.append(user_name)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
        return self._row_out(row, include_embedding) if row else None

    def get_nodes(
        self, ids: list, include_embedding: bool = False, **kwargs
    ) -> list[dict[str, Any]]:
        if not ids:
            return []
        user_name = kwargs.get("user_name")
        sql = f"SELECT {self._COLS} FROM {self.schema}.memory m WHERE id = ANY(%s)"
        params: list[Any] = [list(ids)]
        if user_name:
            sql += " AND m.user_name = %s"
            params.append(user_name)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = {r[0]: r for r in cur.fetchall()}
        return [self._row_out(rows[i], include_embedding) for i in ids if i in rows]

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        status: str | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
        **kwargs,
    ) -> list[str]:
        where, params = [], []
        user_name = user_name or (self.user_name if user_name_flag else None)
        if user_name and user_name_flag:
            where.append("m.user_name = %s")
            params.append(user_name)
        if status:
            where.append("m.status = %s")
            params.append(status)
        for f in filters:
            field, op, value = self._field(f["field"]), f.get("op", "="), f["value"]
            col = f"m.properties->>'{field}'"
            if op == "=":
                where.append(f"{col} = %s")
                params.append(_text_value(value))
            elif op == "in":
                where.append(f"{col} = ANY(%s)")
                params.append([_text_value(v) for v in value])
            elif op in (">", ">=", "<", "<="):
                if isinstance(value, int | float) and not isinstance(value, bool):
                    where.append(f"({col})::numeric {op} %s")
                else:
                    where.append(f"{col} {op} %s")
                params.append(value)
            elif op == "contains":
                where.append(f"m.properties->'{field}' @> %s::jsonb")
                params.append(json.dumps([value], ensure_ascii=False))
            else:
                raise ValueError(f"unsupported op: {op}")
        sql = (
            f"SELECT id FROM {self.schema}.memory m"
            + (" WHERE " + " AND ".join(where) if where else "")
            + " ORDER BY m.seq"  # 按写入顺序，与 SQLite 后端一致
        )
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return [r[0] for r in cur.fetchall()]

    def get_all_memory_items(
        self, scope: str, include_embedding: bool = False, status: str | None = None, **kwargs
    ) -> list[dict]:
        where, params = self._scope_where(
            kwargs.get("user_name") or self.user_name, scope, status, None, False
        )
        sql = f"SELECT {self._COLS} FROM {self.schema}.memory m" + (
            " WHERE " + " AND ".join(where) if where else ""
        )
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return [self._row_out(r, include_embedding) for r in cur.fetchall()]

    # ------------------------------------------------------------------ search

    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ) -> list[dict]:
        where, params = self._scope_where(user_name or self.user_name, scope, status, search_filter)
        where.append("m.embedding IS NOT NULL")
        cond = " WHERE " + " AND ".join(where)
        hits: list[dict] = []
        with self._conn() as conn, conn.cursor() as cur:
            if self.vec_enabled and len(vector) == self.dim:
                v = self._emb_in(vector)
                cur.execute(
                    f"SELECT m.id, 1 - (m.embedding <=> %s::vector) AS score "
                    f"FROM {self.schema}.memory m{cond} "
                    f"ORDER BY m.embedding <=> %s::vector LIMIT %s",
                    [v, *params, v, int(top_k)],
                )
                hits = [{"id": i, "score": float(sc)} for i, sc in cur.fetchall()]
            else:
                cur.execute(f"SELECT m.id, m.embedding FROM {self.schema}.memory m{cond}", params)
                for node_id, emb in cur.fetchall():
                    e = self._emb_out(emb)
                    if e and len(e) == len(vector):
                        hits.append({"id": node_id, "score": _cos(vector, e)})
                hits.sort(key=lambda h: h["score"], reverse=True)
                hits = hits[:top_k]
        if threshold is not None:
            hits = [h for h in hits if h["score"] >= threshold]
        return hits

    def search_by_fulltext(
        self,
        query_words: list[str],
        top_k: int = 10,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ) -> list[dict]:
        terms = _terms(list(query_words or []))
        if not terms:
            return []
        where, params = self._scope_where(user_name or self.user_name, scope, status, search_filter)
        cond = (" AND " + " AND ".join(where)) if where else ""
        sql = (
            f"WITH q(term) AS (SELECT unnest(%s::text[])) "
            f"SELECT m.id, COUNT(*)::float / %s AS score "
            f"FROM {self.schema}.memory m JOIN q "
            f"ON lower(m.body) LIKE '%%' || q.term || '%%' ESCAPE '\\'{cond} "
            f"GROUP BY m.id ORDER BY score DESC LIMIT %s"
        )
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, [[_like_escape(t) for t in terms], len(terms), *params, int(top_k)])
            hits = [{"id": i, "score": float(sc)} for i, sc in cur.fetchall()]
        if threshold is not None:
            hits = [h for h in hits if h["score"] >= threshold]
        return hits
