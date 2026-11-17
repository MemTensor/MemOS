"""SQLite backend for MemOS graph storage.

Tables follow the old `Memory` table one-to-one (keys inside `properties` are unchanged), so rows can
be moved between backends as-is:

| table | mirrors | holds |
| --- | --- | --- |
| `memory` | `Memory` | one row per memory; all metadata in `properties` (JSON), including `memory` |
| `memory_fts` | the Chinese full-text column | FTS5 index (trigram tokenizer, works for Chinese) |
| `memory_vec` | the ivfflat index on `embedding` | sqlite-vec `vec0` index partitioned by `user_name` |
| `edges` | `Edges` | relationships |

Two things the old tables do not have:
- `rev`: bumped on every write. `add_node(..., expected_rev=n)` only writes when the stored row is
  still at revision n, otherwise raises `ConcurrentUpdateError` (optimistic concurrency).
- `seq`: internal row number used as the rowid of the FTS and vector tables.

`user_name`, `memory_type` and `status` are generated columns derived from `properties`, only for
indexing. When the sqlite-vec extension is unavailable, vector search falls back to an exact scan
within the filtered rows.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import struct
import threading

from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from memos.graph_dbs.base import BaseGraphDB, ConcurrentUpdateError
from memos.log import get_logger


logger = get_logger(__name__)

_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_CJK_RUN = re.compile(r"[㐀-鿿]{3,}")
_WORD = re.compile(r"[A-Za-z0-9_./#-]{3,}")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack(blob: bytes | None) -> list[float] | None:
    if not blob:
        return None
    return list(struct.unpack(f"{len(blob) // 4}f", blob))


def _cos(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b, strict=False)) / (na * nb)


def _fts_query(words: list[str]) -> str:
    """Trigram FTS needs >=3 characters per term: Chinese runs are cut into trigrams, OR-ed."""
    terms: list[str] = []
    for w in words:
        for run in _CJK_RUN.findall(w or ""):
            terms += [run[i : i + 3] for i in range(len(run) - 2)]
        terms += _WORD.findall(w or "")
    seen: list[str] = []
    for t in terms:
        t = t.replace('"', "")
        if t and t not in seen:
            seen.append(t)
    return " OR ".join(f'"{t}"' for t in seen[:64])


class SQLiteGraphDB(BaseGraphDB):
    supports_cas = True

    def __init__(self, config):
        self.config = config
        self.user_name = getattr(config, "user_name", None)
        self.dim = int(getattr(config, "embedding_dimension", 1024))
        path = Path(config.db_path)
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.vec_enabled = self._load_vec()
        self._init_schema()

    # ------------------------------------------------------------------ setup

    def _load_vec(self) -> bool:
        try:
            import sqlite_vec

            self.conn.enable_load_extension(True)
            sqlite_vec.load(self.conn)
            self.conn.enable_load_extension(False)
            return True
        except Exception as e:
            logger.info("[SQLiteGraphDB] sqlite-vec unavailable, exact vector scan: %s", e)
            return False

    def _init_schema(self) -> None:
        with self._lock:
            c = self.conn
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS memory (
                  seq         INTEGER PRIMARY KEY,
                  id          TEXT    NOT NULL UNIQUE,
                  properties  TEXT    NOT NULL CHECK (json_valid(properties)),
                  embedding   BLOB,
                  rev         INTEGER NOT NULL DEFAULT 0,
                  created_at  TEXT    NOT NULL,
                  updated_at  TEXT    NOT NULL,
                  user_name   TEXT GENERATED ALWAYS AS (json_extract(properties, '$.user_name'))   VIRTUAL,
                  memory_type TEXT GENERATED ALWAYS AS (json_extract(properties, '$.memory_type')) VIRTUAL,
                  status      TEXT GENERATED ALWAYS AS (json_extract(properties, '$.status'))      VIRTUAL
                )"""
            )
            c.execute(
                "CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory (user_name, memory_type, status)"
            )
            c.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, tokenize='trigram')"
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS edges (
                  source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL,
                  created_at TEXT NOT NULL, PRIMARY KEY (source_id, target_id, type)
                )"""
            )
            c.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target_id)")
            if self.vec_enabled:
                try:
                    c.execute(
                        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0("
                        f"user_name text partition key, embedding float[{self.dim}] distance_metric=cosine)"
                    )
                except sqlite3.OperationalError as e:
                    logger.info("[SQLiteGraphDB] vec0 table unavailable, exact scan: %s", e)
                    self.vec_enabled = False

    # ------------------------------------------------------------------ helpers

    def _row_out(self, row: sqlite3.Row | tuple, include_embedding: bool = False) -> dict[str, Any]:
        node_id, props_text, emb, rev, created_at, updated_at = row[:6]
        props = json.loads(props_text)
        memory = props.pop("memory", "")
        props.setdefault("created_at", created_at)
        props["updated_at"] = props.get("updated_at") or updated_at
        out = {"id": node_id, "memory": memory, "metadata": props, "rev": rev}
        if include_embedding:
            out["metadata"]["embedding"] = _unpack(emb)
        return out

    _COLS = "id, properties, embedding, rev, created_at, updated_at"

    def _index(self, seq: int, user_name: str | None, body: str, emb: list[float] | None) -> None:
        self.conn.execute("DELETE FROM memory_fts WHERE rowid = ?", (seq,))
        if body:
            self.conn.execute("INSERT INTO memory_fts(rowid, body) VALUES (?, ?)", (seq, body))
        if self.vec_enabled:
            self.conn.execute("DELETE FROM memory_vec WHERE rowid = ?", (seq,))
            if emb is not None and len(emb) == self.dim:
                self.conn.execute(
                    "INSERT INTO memory_vec(rowid, user_name, embedding) VALUES (?, ?, ?)",
                    (seq, user_name or "", _pack(emb)),
                )

    def _unindex(self, seq: int) -> None:
        self.conn.execute("DELETE FROM memory_fts WHERE rowid = ?", (seq,))
        if self.vec_enabled:
            self.conn.execute("DELETE FROM memory_vec WHERE rowid = ?", (seq,))

    @staticmethod
    def _field(name: str) -> str:
        if not _FIELD_RE.match(name):
            raise ValueError(f"invalid field name: {name}")
        return f"json_extract(properties, '$.{name}')"

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
            where.append("m.user_name = ?")
            params.append(user_name)
        if scope:
            where.append("m.memory_type = ?")
            params.append(scope)
        if status:
            where.append("m.status = ?")
            params.append(status)
        elif default_active:
            where.append("(m.status = 'activated' OR m.status IS NULL)")
        for k, v in (search_filter or {}).items():
            where.append(f"CAST({self._field(k)} AS TEXT) = ?")
            params.append(str(v))
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
        with self._lock:
            c = self.conn
            c.execute("BEGIN IMMEDIATE")
            try:
                row = c.execute(
                    "SELECT seq, rev, embedding FROM memory WHERE id = ?", (id,)
                ).fetchone()
                if expected_rev is not None and (row[1] if row else 0) != expected_rev:
                    raise ConcurrentUpdateError(
                        f"{id}: expected rev {expected_rev}, found {row[1] if row else 0}"
                    )
                blob = _pack(emb) if emb is not None else (row[2] if row else None)
                if row:
                    c.execute(
                        "UPDATE memory SET properties = ?, embedding = ?, rev = rev + 1, updated_at = ? "
                        "WHERE seq = ?",
                        (json.dumps(props, ensure_ascii=False), blob, _now(), row[0]),
                    )
                    seq = row[0]
                else:
                    cur = c.execute(
                        "INSERT INTO memory (id, properties, embedding, rev, created_at, updated_at) "
                        "VALUES (?, ?, ?, 1, ?, ?)",
                        (id, json.dumps(props, ensure_ascii=False), blob, created_at, _now()),
                    )
                    seq = cur.lastrowid
                self._index(
                    seq, props["user_name"], body, emb if emb is not None else _unpack(blob)
                )
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        for n in nodes:
            self.add_node(n["id"], n["memory"], n.get("metadata", {}), user_name=user_name)

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        node = self.get_node(id, include_embedding=True, user_name=user_name)
        if not node:
            return
        props = dict(node["metadata"])
        memory = fields.pop("memory", node["memory"])
        props.update(fields)
        self.add_node(id, memory, props, user_name=props.get("user_name"))

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        with self._lock:
            row = self.conn.execute(
                "SELECT seq FROM memory m WHERE id = ?"
                + (" AND m.user_name = ?" if user_name else ""),
                (id, user_name) if user_name else (id,),
            ).fetchone()
            if not row:
                return
            self._unindex(row[0])
            self.conn.execute("DELETE FROM memory WHERE seq = ?", (row[0],))
            self.conn.execute("DELETE FROM edges WHERE source_id = ? OR target_id = ?", (id, id))

    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        user_name = kwargs.get("user_name")
        sql = f"SELECT {self._COLS} FROM memory m WHERE id = ?"
        params: list[Any] = [id]
        if user_name:
            sql += " AND m.user_name = ?"
            params.append(user_name)
        row = self.conn.execute(sql, params).fetchone()
        return self._row_out(row, include_embedding) if row else None

    def get_nodes(
        self, ids: list, include_embedding: bool = False, **kwargs
    ) -> list[dict[str, Any]]:
        if not ids:
            return []
        user_name = kwargs.get("user_name")
        marks = ",".join("?" * len(ids))
        sql = f"SELECT {self._COLS} FROM memory m WHERE id IN ({marks})"
        params: list[Any] = list(ids)
        if user_name:
            sql += " AND m.user_name = ?"
            params.append(user_name)
        rows = {r[0]: r for r in self.conn.execute(sql, params).fetchall()}
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
            where.append("m.user_name = ?")
            params.append(user_name)
        if status:
            where.append("m.status = ?")
            params.append(status)
        for f in filters:
            field, op, value = f["field"], f.get("op", "="), f["value"]
            col = self._field(field)
            if op == "=":
                where.append(f"CAST({col} AS TEXT) = ?")
                params.append(str(value))
            elif op == "in":
                where.append(f"CAST({col} AS TEXT) IN ({','.join('?' * len(value))})")
                params += [str(v) for v in value]
            elif op in (">", ">=", "<", "<="):
                where.append(f"{col} {op} ?")
                params.append(value)
            elif op == "contains":
                where.append(
                    f"EXISTS (SELECT 1 FROM json_each(m.properties, '$.{field}') WHERE value = ?)"
                )
                params.append(value)
            else:
                raise ValueError(f"unsupported op: {op}")
        sql = "SELECT id FROM memory m" + (" WHERE " + " AND ".join(where) if where else "")
        return [r[0] for r in self.conn.execute(sql, params).fetchall()]

    def get_all_memory_items(
        self, scope: str, include_embedding: bool = False, status: str | None = None, **kwargs
    ) -> list[dict]:
        where, params = self._scope_where(
            kwargs.get("user_name") or self.user_name, scope, status, None, False
        )
        sql = f"SELECT {self._COLS} FROM memory m" + (
            " WHERE " + " AND ".join(where) if where else ""
        )
        return [
            self._row_out(r, include_embedding) for r in self.conn.execute(sql, params).fetchall()
        ]

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        user_name = user_name or self.user_name
        return self.conn.execute(
            "SELECT COUNT(*) FROM memory m WHERE m.memory_type = ? AND (? IS NULL OR m.user_name = ?)",
            (memory_type, user_name, user_name),
        ).fetchone()[0]

    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        user_name = user_name or self.user_name
        rows = self.conn.execute(
            "SELECT id FROM memory m WHERE m.memory_type = ? AND (? IS NULL OR m.user_name = ?) "
            "ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
            (memory_type, user_name, user_name, int(keep_latest)),
        ).fetchall()
        for (node_id,) in rows:
            self.delete_node(node_id)

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
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        user_name = user_name or self.user_name
        where, params = self._scope_where(user_name, scope, status, search_filter)
        hits: list[dict] = []
        if self.vec_enabled and len(vector) == self.dim:
            k = max(top_k * 8, 50)
            vec_sql = "SELECT rowid, distance FROM memory_vec WHERE embedding MATCH ? AND k = ?"
            vec_params: list[Any] = [_pack(vector), k]
            if user_name:
                vec_sql += " AND user_name = ?"
                vec_params.append(user_name)
            sql = (
                f"SELECT m.id, v.distance FROM ({vec_sql}) v JOIN memory m ON m.seq = v.rowid"
                + (" WHERE " + " AND ".join(where) if where else "")
                + " ORDER BY v.distance"
            )
            for node_id, dist in self.conn.execute(sql, vec_params + params).fetchall():
                hits.append({"id": node_id, "score": 1.0 - float(dist)})
        else:
            sql = "SELECT m.id, m.embedding FROM memory m WHERE m.embedding IS NOT NULL" + (
                " AND " + " AND ".join(where) if where else ""
            )
            for node_id, blob in self.conn.execute(sql, params).fetchall():
                emb = _unpack(blob)
                if emb and len(emb) == len(vector):
                    hits.append({"id": node_id, "score": _cos(vector, emb)})
            hits.sort(key=lambda h: h["score"], reverse=True)
        if threshold is not None:
            hits = [h for h in hits if h["score"] >= threshold]
        return hits[:top_k]

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
        match = _fts_query(list(query_words or []))
        if not match:
            return []
        where, params = self._scope_where(user_name or self.user_name, scope, status, search_filter)
        sql = (
            "SELECT m.id, bm25(memory_fts) AS s FROM memory_fts JOIN memory m ON m.seq = memory_fts.rowid "
            "WHERE memory_fts MATCH ?"
            + (" AND " + " AND ".join(where) if where else "")
            + " ORDER BY s LIMIT ?"
        )
        rows = self.conn.execute(sql, [match, *params, top_k]).fetchall()
        if not rows:
            return []
        best = max(-s for _, s in rows) or 1.0
        hits = [{"id": i, "score": max(0.0, -s) / best} for i, s in rows]
        if threshold is not None:
            hits = [h for h in hits if h["score"] >= threshold]
        return hits

    # ------------------------------------------------------------------ edges

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT OR IGNORE INTO edges (source_id, target_id, type, created_at) VALUES (?, ?, ?, ?)",
                (source_id, target_id, type, _now()),
            )

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        with self._lock:
            self.conn.execute(
                "DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?",
                (source_id, target_id, type),
            )

    def edge_exists(self, source_id: str, target_id: str, type: str = "ANY", **kwargs) -> bool:
        sql = "SELECT 1 FROM edges WHERE source_id = ? AND target_id = ?"
        params = [source_id, target_id]
        if type and type != "ANY":
            sql += " AND type = ?"
            params.append(type)
        return self.conn.execute(sql, params).fetchone() is not None

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out", **kwargs
    ) -> list[str]:
        out: list[str] = []
        if direction in ("out", "both"):
            out += [
                r[0]
                for r in self.conn.execute(
                    "SELECT target_id FROM edges WHERE source_id = ? AND type = ?", (id, type)
                )
            ]
        if direction in ("in", "both"):
            out += [
                r[0]
                for r in self.conn.execute(
                    "SELECT source_id FROM edges WHERE target_id = ? AND type = ?", (id, type)
                )
            ]
        return list(dict.fromkeys(out))

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        prev: dict[str, str | None] = {source_id: None}
        queue = deque([(source_id, 0)])
        while queue:
            node, depth = queue.popleft()
            if node == target_id:
                path = [node]
                while prev[path[-1]] is not None:
                    path.append(prev[path[-1]])
                return list(reversed(path))
            if depth >= max_depth:
                continue
            for (nxt,) in self.conn.execute(
                "SELECT target_id FROM edges WHERE source_id = ?", (node,)
            ):
                if nxt not in prev:
                    prev[nxt] = node
                    queue.append((nxt, depth + 1))
        return []

    def get_subgraph(self, center_id: str, depth: int = 2, **kwargs) -> dict[str, Any]:
        seen = {center_id}
        frontier = [center_id]
        edges: list[dict[str, str]] = []
        for _ in range(depth):
            nxt: list[str] = []
            for node in frontier:
                for s, t, ty in self.conn.execute(
                    "SELECT source_id, target_id, type FROM edges WHERE source_id = ? OR target_id = ?",
                    (node, node),
                ):
                    edges.append({"source": s, "target": t, "type": ty})
                    for x in (s, t):
                        if x not in seen:
                            seen.add(x)
                            nxt.append(x)
            frontier = nxt
        nodes = self.get_nodes(list(seen))
        core = next((n for n in nodes if n["id"] == center_id), None)
        return {
            "core_node": core,
            "neighbors": [n for n in nodes if n["id"] != center_id],
            "edges": edges,
        }

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        chain, node = [id], id
        while True:
            nxt = self.get_neighbors(node, type, "out")
            if not nxt or nxt[0] in chain:
                return chain
            node = nxt[0]
            chain.append(node)

    # ------------------------------------------------------------------ maintenance

    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False, **kwargs
    ) -> list[dict]:
        user_name = kwargs.get("user_name") or self.user_name
        where, params = self._scope_where(user_name, scope, None, None)
        sql = (
            f"SELECT {self._COLS} FROM memory m WHERE NOT EXISTS (SELECT 1 FROM edges e "
            "WHERE e.source_id = m.id OR e.target_id = m.id)"
            + (" AND " + " AND ".join(where) if where else "")
        )
        return [
            self._row_out(r, include_embedding) for r in self.conn.execute(sql, params).fetchall()
        ]

    def deduplicate_nodes(self, user_name: str | None = None) -> None:
        """Delete exact duplicates (same user_name, memory_type and text); the earliest row is kept."""
        rows = self.conn.execute(
            "SELECT id, m.user_name, m.memory_type, json_extract(properties, '$.memory') FROM memory m "
            "WHERE (? IS NULL OR m.user_name = ?) ORDER BY seq",
            (user_name, user_name),
        ).fetchall()
        seen: set[tuple] = set()
        for node_id, un, mt, text in rows:
            key = (un, mt, text)
            if key in seen:
                self.delete_node(node_id)
            else:
                seen.add(key)

    def detect_conflicts(self) -> list[tuple[str, str]]:
        return [
            tuple(r)
            for r in self.conn.execute(
                "SELECT source_id, target_id FROM edges WHERE type = 'CONFLICT'"
            )
        ]

    def merge_nodes(self, id1: str, id2: str) -> str:
        with self._lock:
            self.conn.execute(
                "UPDATE OR IGNORE edges SET source_id = ? WHERE source_id = ?", (id1, id2)
            )
            self.conn.execute(
                "UPDATE OR IGNORE edges SET target_id = ? WHERE target_id = ?", (id1, id2)
            )
        self.delete_node(id2)
        return id1

    def clear(self, user_name: str | None = None) -> None:
        user_name = user_name or self.user_name
        ids = [
            r[0]
            for r in self.conn.execute(
                "SELECT id FROM memory m WHERE (? IS NULL OR m.user_name = ?)",
                (user_name, user_name),
            )
        ]
        for node_id in ids:
            self.delete_node(node_id)

    def export_graph(self, include_embedding: bool = False, **kwargs) -> dict[str, Any]:
        user_name = kwargs.get("user_name") or self.user_name
        rows = self.conn.execute(
            f"SELECT {self._COLS} FROM memory m WHERE (? IS NULL OR m.user_name = ?)",
            (user_name, user_name),
        ).fetchall()
        nodes = [self._row_out(r, include_embedding) for r in rows]
        ids = {n["id"] for n in nodes}
        edges = [
            {"source": s, "target": t, "type": ty}
            for s, t, ty in self.conn.execute("SELECT source_id, target_id, type FROM edges")
            if s in ids or t in ids
        ]
        return {"nodes": nodes, "edges": edges}

    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        for n in data.get("nodes", []):
            self.add_node(n["id"], n.get("memory", ""), n.get("metadata", {}), user_name=user_name)
        for e in data.get("edges", []):
            self.add_edge(e["source"], e["target"], e["type"])
