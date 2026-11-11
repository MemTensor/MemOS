"""openGauss enterprise AGE backend, following the existing GraphDB provider layout.

The provider owns its connection pool, graph operations and filter builders.
Consumer capabilities are validated separately from factory registration.
"""

import json
import math
import re
import threading

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import ConfigurationError, GraphDBError
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


try:
    import psycopg2

    from psycopg2.pool import ThreadedConnectionPool
except ImportError:
    psycopg2 = None
    ThreadedConnectionPool = None

logger = get_logger(__name__)
_TABLE = '"memos_graph"."Memory"'
# This AGE build emits fractional floats as .8 / -.2. Protect quoted JSON
# strings while restoring the leading zero needed by a standard JSON parser.
_AGE_JSON_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|(?<![\w.])(-?)\.(\d+)')
_UPSERT = (
    f"INSERT INTO {_TABLE} (scope, business_id, memory, embedding, properties) "
    "VALUES (%(scope)s, %(id)s, %(memory)s, %(embedding)s::pg_catalog.vector, %(properties)s::ag_catalog.agtype) "
    "ON CONFLICT (scope, business_id) DO UPDATE SET memory = EXCLUDED.memory, "
    "embedding = EXCLUDED.embedding, properties = EXCLUDED.properties"
)


_DELETE_NODE = f"DELETE FROM ONLY {_TABLE} WHERE scope = %(scope)s AND business_id = %(id)s"
_DELETE_INCIDENT_EDGES = (
    "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
    "(a.id = $id AND a.user_name = $scope) OR "
    "(b.id = $id AND b.user_name = $scope) DELETE r"
)


_ARRAY_FIELDS = {"tags", "sources", "file_ids", "related_id", "message_ids"}
_ROOT_FIELDS = {
    "id",
    "key",
    "tags",
    "type",
    "usage",
    "memory",
    "status",
    "sources",
    "user_id",
    "graph_id",
    "user_name",
    "background",
    "confidence",
    "created_at",
    "session_id",
    "updated_at",
    "memory_type",
    "node_type",
    "info",
    "source",
    "file_ids",
    "project_id",
    "manager_user_id",
    "delete_time",
    "delete_record_id",
    "related_id",
    "message_ids",
}
_OPERATORS = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


def _encode_filter_value(value: Any) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if json.loads(encoded) != value:
            raise ValueError("Filter values must be JSON values with string object keys")
        return encoded
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid JSON filter value") from exc


class OpenGaussGraphDB(BaseGraphDB):
    """Scoped AGE graph backend with an owned pool and parameter-bound filters."""

    def __init__(self, config: OpenGaussGraphDBConfig) -> None:
        if ThreadedConnectionPool is None:
            raise ConfigurationError(
                "Install openGauss support with pip install 'MemoryOS[tree-mem]'"
            )
        self.config = config.model_copy(deep=True)
        self.db_name = config.db_name
        self.user_name = config.user_name
        self._semaphore = threading.BoundedSemaphore(config.maxconn)
        self._condition = threading.Condition()
        self._active = 0
        self._closed = False
        self._pool_closed = False
        try:
            self.connection_pool = ThreadedConnectionPool(
                config.minconn,
                config.maxconn,
                host=config.host,
                port=config.port,
                dbname=config.db_name,
                user=config.user,
                password=config.password,
                connect_timeout=config.connect_timeout,
                application_name="memos-opengauss",
            )
        except psycopg2.Error as exc:
            raise GraphDBError("Could not open the openGauss connection pool") from exc

        try:
            self._init_schema()
        except BaseException:
            try:
                self.close()
            except GraphDBError:
                logger.warning("openGauss pool cleanup failed after initialization failure")
            raise

    def _ensure_open(self) -> None:
        """Reject operations after close, including operations on empty inputs."""
        with self._condition:
            if self._closed:
                raise GraphDBError("The openGauss connection pool is closed")

    @contextmanager
    def _get_connection(self, *, snapshot: bool = False) -> Iterator[Any]:
        """Prepare one owned session, commit once, and always release admission."""
        self._ensure_open()
        if not self._semaphore.acquire(timeout=self.config.connection_wait_timeout):
            raise GraphDBError("openGauss connection wait timed out")
        with self._condition:
            if self._closed:
                self._semaphore.release()
                raise GraphDBError("The openGauss connection pool is closed")
            self._active += 1
        connection = None
        failed = discard = False
        try:
            connection = self.connection_pool.getconn()
            if connection.closed:
                raise GraphDBError("The openGauss pool returned a closed connection")
            connection.rollback()
            connection.set_session(
                isolation_level="REPEATABLE READ" if snapshot else "READ COMMITTED",
                readonly=snapshot,
                autocommit=False,
            )
            with connection.cursor() as cursor:
                cursor.execute("RESET ALL")
                # Public type input loads AGE hooks without privileged LOAD.
                cursor.execute("SELECT 'null'::ag_catalog.agtype")
                cursor.execute("SET search_path = ag_catalog, public")
            yield connection
            connection.commit()
        except BaseException as exc:
            failed = True
            discard = isinstance(exc, psycopg2.OperationalError | psycopg2.InterfaceError)
            if connection is not None:
                try:
                    connection.rollback()
                except psycopg2.Error:
                    discard = True
                    logger.warning("openGauss rollback failed; discarding the connection")
            if isinstance(exc, psycopg2.Error):
                raise GraphDBError(
                    "openGauss transaction failed; the write was not retried"
                ) from exc
            raise
        finally:
            try:
                if connection is not None:
                    self._return_connection(connection, discard, failed)
            finally:
                with self._condition:
                    self._active -= 1
                    if self._closed and not self._active:
                        try:
                            self._close_pool()
                        except GraphDBError:
                            logger.warning(
                                "openGauss pool shutdown failed during transaction cleanup"
                            )
                    self._condition.notify_all()
                self._semaphore.release()

    @contextmanager
    def _cursor(
        self, *, utc: bool = False, lock: int | None = None, snapshot: bool = False
    ) -> Iterator[Any]:
        """Borrow one transactional cursor, optionally preparing UTC and a graph lock."""
        transaction = self._get_connection(snapshot=True) if snapshot else self._get_connection()
        with transaction as connection, connection.cursor() as cursor:
            if utc:
                cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            if lock is not None:
                cursor.execute("SELECT pg_advisory_xact_lock(621503, %(lock)s)", {"lock": lock})
            yield cursor

    def _return_connection(self, connection: Any, discard: bool, failed: bool) -> None:
        try:
            self.connection_pool.putconn(connection, close=discard or bool(connection.closed))
        except psycopg2.Error as exc:
            # A failed return may leave the driver's checkout bookkeeping dirty.
            # Stop admission and drain owners before closing the entire pool.
            with self._condition:
                self._closed = True
            try:
                connection.close()
            except psycopg2.Error:
                logger.warning("openGauss connection close failed during pool cleanup")
            if not failed:
                raise GraphDBError(
                    "Could not return the openGauss connection; the transaction may already be committed"
                ) from exc
            logger.warning("openGauss connection return failed during error cleanup")

    def close(self) -> None:
        """Reject new borrowers, wait for owners, then close; successful close is idempotent."""
        with self._condition:
            self._closed = True
            while self._active:
                self._condition.wait()
            self._close_pool()

    def _close_pool(self) -> None:
        if not self._pool_closed:
            try:
                self.connection_pool.closeall()
            except psycopg2.Error as exc:
                raise GraphDBError("Could not close the openGauss connection pool") from exc
            self._pool_closed = True

    def _init_schema(self) -> None:
        with self._cursor(lock=1) as cursor:
            cursor.execute(
                "SELECT oid FROM ag_catalog.ag_graph WHERE name = %(graph)s",
                {"graph": "memos_graph"},
            )
            if cursor.fetchone() is None:
                cursor.execute(
                    "SELECT ag_catalog.create_graph(%(graph)s)", {"graph": "memos_graph"}
                )
            cursor.execute(
                "SELECT l.kind, n.nspname, c.relname FROM ag_catalog.ag_label l "
                "JOIN ag_catalog.ag_graph g ON g.oid = l.graph "
                "JOIN pg_catalog.pg_class c ON c.oid = l.relation "
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                "WHERE g.name = %(graph)s AND l.name = %(label)s",
                {"graph": "memos_graph", "label": "Memory"},
            )
            label = cursor.fetchone()
            if label is None:
                cursor.execute(
                    "SELECT ag_catalog.create_vlabel(%(graph)s, %(label)s)",
                    {"graph": "memos_graph", "label": "Memory"},
                )
                cursor.execute(
                    f"ALTER TABLE {_TABLE} ADD COLUMN scope text NOT NULL, "
                    "ADD COLUMN business_id text NOT NULL, ADD COLUMN memory text NOT NULL, "
                    f"ADD COLUMN embedding pg_catalog.vector({self.config.embedding_dimension}), "
                    "ADD UNIQUE(scope, business_id)"
                )
            elif label != ("v", "memos_graph", "Memory"):
                raise GraphDBError("The openGauss Memory label is incompatible")
            cursor.execute(
                "SELECT attname, pg_catalog.format_type(atttypid, atttypmod), attnotnull, "
                "atthasdef, attnum FROM pg_catalog.pg_attribute "
                "WHERE attrelid = %(table)s::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
                {"table": _TABLE},
            )
            expected = [
                ("id", "graphid", True, True, 1),
                ("properties", "agtype", True, True, 2),
                ("scope", "text", True, False, 3),
                ("business_id", "text", True, False, 4),
                ("memory", "text", True, False, 5),
                ("embedding", f"vector({self.config.embedding_dimension})", False, False, 6),
            ]
            if cursor.fetchall() != expected:
                raise GraphDBError("The openGauss Memory columns are incompatible")
            cursor.execute(
                "SELECT 1 FROM pg_catalog.pg_index WHERE indrelid = %(table)s::regclass "
                "AND indisunique AND indisvalid AND indimmediate AND indpred IS NULL "
                "AND indexprs IS NULL AND indkey::text = '3 4'",
                {"table": _TABLE},
            )
            if cursor.fetchone() is None:
                raise GraphDBError("The openGauss Memory unique constraint is incompatible")
            self._init_vector_index(cursor)
            self._init_fulltext_index(cursor)

    def _init_fulltext_index(self, cursor: Any, create: bool = True) -> None:
        """Validate the owned native text index, creating it only during initialization."""
        inspect_index = (
            "SELECT tn.nspname, t.relname, am.amname, opc.opcname, i.indkey::text, "
            "i.indisvalid, i.indisready, i.indpred, i.indexprs, idx.reloptions "
            "FROM pg_catalog.pg_class idx "
            "JOIN pg_catalog.pg_namespace n ON n.oid=idx.relnamespace "
            "JOIN pg_catalog.pg_index i ON i.indexrelid=idx.oid "
            "JOIN pg_catalog.pg_class t ON t.oid=i.indrelid "
            "JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace "
            "JOIN pg_catalog.pg_am am ON am.oid=idx.relam "
            "JOIN pg_catalog.pg_opclass opc ON opc.oid=i.indclass[0] "
            "WHERE n.nspname='memos_graph' AND idx.relname='memory_fulltext_bm25'"
        )
        cursor.execute(inspect_index)
        index = cursor.fetchone()
        if index is None and create:
            cursor.execute(f"CREATE INDEX memory_fulltext_bm25 ON {_TABLE} USING bm25 (memory)")
            cursor.execute(inspect_index)
            index = cursor.fetchone()
        if index != (
            "memos_graph",
            "Memory",
            "bm25",
            "bm25_text_ops",
            "5",
            True,
            True,
            None,
            None,
            ["dict_path=DEFAULT"],
        ):
            raise GraphDBError("The openGauss fulltext index is missing or incompatible")

    def _rebuild_fulltext_index(self) -> None:
        """Repair the known failed-write index state without replaying any write."""
        with self._cursor(lock=1) as cursor:
            self._init_fulltext_index(cursor, create=False)
            cursor.execute("REINDEX INDEX memos_graph.memory_fulltext_bm25")

    def _init_vector_index(self, cursor: Any) -> None:
        """Keep full precision above the HNSW dimension limit using exact retrieval."""
        if self.config.embedding_dimension > 2000:
            return
        inspect_index = (
            "SELECT tn.nspname, t.relname, am.amname, opc.opcname, i.indkey::text, "
            "i.indisvalid, i.indisready, i.indpred, i.indexprs "
            "FROM pg_catalog.pg_class idx "
            "JOIN pg_catalog.pg_namespace n ON n.oid=idx.relnamespace "
            "JOIN pg_catalog.pg_index i ON i.indexrelid=idx.oid "
            "JOIN pg_catalog.pg_class t ON t.oid=i.indrelid "
            "JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace "
            "JOIN pg_catalog.pg_am am ON am.oid=idx.relam "
            "JOIN pg_catalog.pg_opclass opc ON opc.oid=i.indclass[0] "
            "WHERE n.nspname='memos_graph' AND idx.relname='memory_embedding_hnsw'"
        )
        cursor.execute(inspect_index)
        index = cursor.fetchone()
        if index is None:
            cursor.execute(
                f"CREATE INDEX memory_embedding_hnsw ON {_TABLE} "
                "USING hnsw (embedding pg_catalog.vector_cosine_ops)"
            )
            cursor.execute(inspect_index)
            index = cursor.fetchone()
        if index != (
            "memos_graph",
            "Memory",
            "hnsw",
            "vector_cosine_ops",
            "6",
            True,
            True,
            None,
            None,
        ):
            raise GraphDBError("The openGauss vector index is incompatible")

    def _scope(self, user_name: str | None) -> str:
        scope = self.config.user_name if user_name is None else user_name
        if scope is None and self.config.use_multi_db:
            return ""
        if not isinstance(scope, str) or not scope.strip():
            raise ValueError("user_name must be a nonblank string")
        return scope

    @staticmethod
    def _validate_id(node_id: str) -> None:
        if not isinstance(node_id, str) or not node_id.strip():
            raise ValueError("id must be a nonblank string")

    def _encode_node(
        self, node_id: str, memory: str, metadata: dict[str, Any], scope: str
    ) -> tuple[str, str, str, str | None, str]:
        self._validate_id(node_id)
        if not isinstance(memory, str):
            raise ValueError("memory must be a string")
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be a JSON object")
        if "id" in metadata or "memory" in metadata:
            raise ValueError("metadata cannot override id or memory")
        if "user_name" in metadata and metadata["user_name"] != scope:
            raise ValueError("metadata user_name must match the operation scope")
        properties = {**metadata, "id": node_id, "memory": memory, "user_name": scope}
        embedding = properties.pop("embedding", None)
        if embedding is not None:
            if not isinstance(embedding, list):
                raise ValueError("embedding must be a list of finite numbers")
            if embedding:
                if len(embedding) != self.config.embedding_dimension:
                    raise ValueError("embedding must match embedding_dimension")
                try:
                    if any(
                        type(value) not in (int, float) or not math.isfinite(value)
                        for value in embedding
                    ):
                        raise ValueError("embedding must contain finite numbers, excluding bool")
                except OverflowError as exc:
                    raise ValueError(
                        "embedding numbers must be representable as finite floats"
                    ) from exc
        try:
            payload = json.dumps(properties, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("metadata must contain valid JSON values") from exc
        if json.loads(payload) != properties:
            raise ValueError("metadata must contain JSON objects with string keys and JSON lists")
        vector = json.dumps(embedding) if embedding else None
        return scope, node_id, memory, vector, payload

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Upsert one identity without replacing its native graphid."""
        self.add_nodes_batch([{"id": id, "memory": memory, "metadata": metadata}], user_name)

    def add_nodes_batch(self, nodes: list[dict[str, Any]], user_name: str | None = None) -> None:
        """Prepare the entire batch before borrowing; SQL succeeds or rolls back together."""
        self._ensure_open()
        scope = self._scope(user_name)
        if not isinstance(nodes, list):
            raise ValueError("nodes must be a list")
        rows = []
        for node in nodes:
            if not isinstance(node, dict) or "id" not in node or "memory" not in node:
                raise ValueError("each node must contain id and memory")
            rows.append(
                self._encode_node(node["id"], node["memory"], node.get("metadata", {}), scope)
            )
        if rows:
            with self._cursor() as cursor:
                for owner, node_id, memory, embedding, properties in rows:
                    cursor.execute(
                        _UPSERT,
                        {
                            "scope": owner,
                            "id": node_id,
                            "memory": memory,
                            "embedding": embedding,
                            "properties": properties,
                        },
                    )

    @staticmethod
    def _decode_embedding(value: Any) -> list[float] | None:
        """Decode the driver's vector value without hiding damaged data."""
        if value is None:
            return None
        try:
            if isinstance(value, str):
                value = json.loads(value)
            if not isinstance(value, list | tuple) or any(
                type(item) not in (int, float) or not math.isfinite(item) for item in value
            ):
                raise ValueError("Invalid vector values")
            return list(value)
        except (TypeError, ValueError, OverflowError) as exc:
            raise GraphDBError("Invalid stored openGauss embedding") from exc

    @staticmethod
    def _decode_node(row: tuple, scope: str, include_embedding: bool) -> dict[str, Any]:
        node_id, memory, payload, vector = row
        try:
            payload = _AGE_JSON_TOKEN.sub(
                lambda token: token[0] if token[0].startswith('"') else f"{token[1]}0.{token[2]}",
                payload,
            )
            properties = json.loads(payload)
        except (TypeError, ValueError) as exc:
            raise GraphDBError("Invalid AGE node properties") from exc
        if not isinstance(properties, dict) or (
            properties.get("id"),
            properties.get("memory"),
            properties.get("user_name"),
        ) != (node_id, memory, scope):
            raise GraphDBError("Inconsistent AGE node properties and retrieval columns")
        for key in ("id", "memory", "user_name"):
            del properties[key]
        if include_embedding:
            properties["embedding"] = OpenGaussGraphDB._decode_embedding(vector)
        return {"id": node_id, "memory": memory, "metadata": properties}

    def get_nodes(
        self,
        ids: list[str],
        include_embedding: bool = False,
        user_name: str | None = None,
        cube_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return existing identities once, in first-requested order, within one scope."""
        self._ensure_open()
        scope = self._scope(cube_name if cube_name is not None else user_name)
        if not isinstance(ids, list):
            raise ValueError("ids must be a list")
        for node_id in ids:
            self._validate_id(node_id)
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        ids = list(dict.fromkeys(ids))
        if not ids:
            return []
        with self._cursor() as cursor:
            found = self._read_nodes(cursor, ids, scope, include_embedding)
        return [found[node_id] for node_id in ids if node_id in found]

    def _read_nodes(
        self, cursor: Any, ids: list[str], scope: str, include_embedding: bool = False
    ) -> dict[str, dict[str, Any]]:
        vector_column = "embedding::text" if include_embedding else "NULL"
        cursor.execute(
            f"SELECT business_id, memory, properties, {vector_column} FROM ONLY {_TABLE} "
            "WHERE scope = %(scope)s AND business_id = ANY(%(ids)s)",
            {"scope": scope, "ids": ids},
        )
        return {
            row[0]: self._decode_node(row, scope, include_embedding) for row in cursor.fetchall()
        }

    def get_node(
        self,
        id: str,
        include_embedding: bool = False,
        user_name: str | None = None,
        cube_name: str | None = None,
    ) -> dict[str, Any] | None:
        """Read an identity; a missing node is None."""
        nodes = self.get_nodes([id], include_embedding, user_name, cube_name)
        return nodes[0] if nodes else None

    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        return_fields: list[str] | None = None,
        *,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        filter: dict | None = None,
        user_name: str | None = None,
        cube_name: str | None = None,
        knowledgebase_ids: list[str] | None = None,
        include_embedding: bool = False,
    ) -> list[dict]:
        """Recall scoped DataVec candidates with normalized cosine scores.

        HNSW supports at most 2000 dimensions. An underfilled candidate query is
        replaced by one exact, identically filtered query. Higher dimensions use
        exact search directly. Separate reads retain READ COMMITTED semantics.
        """
        self._ensure_open()
        if not isinstance(vector, list) or len(vector) != self.config.embedding_dimension:
            raise ValueError("vector must be a list matching embedding_dimension")
        try:
            if any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
                raise ValueError("vector must contain finite numbers, excluding bool")
            scale = max(abs(float(value)) for value in vector)
            if not scale:
                raise ValueError("Cosine query vector must be nonzero")
            query_vector = json.dumps([value / scale for value in vector])
        except OverflowError as exc:
            raise ValueError("vector numbers must be representable as finite floats") from exc
        if type(top_k) is not int or top_k < 0:
            raise ValueError("top_k must be a nonnegative integer")
        if threshold is not None and (
            type(threshold) not in (int, float) or not 0 <= threshold <= 1
        ):
            raise ValueError("threshold must be a finite number between zero and one")
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        if return_fields is not None and (
            not isinstance(return_fields, list)
            or any(
                not isinstance(field, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field)
                for field in return_fields
            )
        ):
            raise ValueError("return_fields must contain valid field names")
        fields = list(dict.fromkeys(return_fields or []))
        if include_embedding and "embedding" not in fields:
            fields.append("embedding")
        with_embedding = "embedding" in fields
        scopes = self._filter_scopes(
            cube_name if cube_name is not None else user_name, knowledgebase_ids
        )
        if search_filter is not None and not isinstance(search_filter, dict):
            raise ValueError("search_filter must be an object")
        metadata = [{"field": key, "value": value} for key, value in (search_filter or {}).items()]
        if scope is not None:
            self._validate_id(scope)
            metadata.append({"field": "memory_type", "value": scope})
        metadata_sql, metadata_params = self._build_metadata_conditions(metadata)
        filter_sql, filter_params = self._build_filter_where_clause(filter)
        status_sql, status_params = self._filter_status("activated" if status is None else status)
        if top_k == 0:
            return []
        vector_column = "embedding::text" if with_embedding else "NULL"
        query = (
            f"SELECT business_id, memory, properties, {vector_column}, scope, "
            f"embedding <=> %(vector)s::pg_catalog.vector FROM ONLY {_TABLE} "
            "WHERE scope = ANY(%(scopes)s) AND embedding IS NOT NULL AND vector_norm(embedding) > 0 "
            f"AND ({metadata_sql}) AND ({filter_sql}) AND ({status_sql}) "
            "ORDER BY (embedding <=> %(vector)s::pg_catalog.vector)"
        )
        query_params = self._merge_bindings(
            metadata_params,
            filter_params,
            status_params,
            {"vector": query_vector, "scopes": scopes, "top_k": top_k},
        )
        with self._cursor(utc=True) as cursor:
            if self.config.embedding_dimension <= 2000:
                cursor.execute("SET LOCAL hnsw_ef_search = 100")
                cursor.execute(query + " LIMIT %(top_k)s", query_params)
                rows = cursor.fetchall()
            else:
                rows = []
            if self.config.embedding_dimension > 2000 or len(rows) < top_k:
                cursor.execute(query + " + 0, scope, business_id LIMIT %(top_k)s", query_params)
                rows = cursor.fetchall()
        ranked = []
        for row in rows:
            try:
                distance = float(row[5])
                if not 0 <= distance <= 2:
                    raise ValueError("Distance outside cosine range")
            except (TypeError, ValueError, OverflowError) as exc:
                raise GraphDBError("Invalid openGauss cosine distance") from exc
            score = 1 - distance / 2
            node = self._decode_node(row[:4], row[4], with_embedding)
            item = {"id": node["id"], "score": score}
            for field in fields:
                if field in ("id", "score"):
                    continue
                if field == "user_name":
                    item[field] = row[4]
                elif field == "memory":
                    item[field] = node["memory"]
                else:
                    item[field] = node["metadata"].get(field)
            if threshold is None or score >= threshold:
                ranked.append((score, row[4], node["id"], item))
        ranked.sort(key=lambda hit: (-hit[0], hit[1], hit[2]))
        return [hit[3] for hit in ranked[:top_k]]

    def _query_fulltext(self, query: str, params: dict[str, Any]) -> list[tuple]:
        with self._cursor(utc=True) as cursor:
            # TAAT scores all term candidates; SQL LIMIT can exceed bm25_topk's
            # separate 200 maximum. Pin scoring independently of role defaults.
            cursor.execute("SET LOCAL enable_bm25_taat = on")
            cursor.execute("SET LOCAL bm25_k1 = 1.2")
            cursor.execute("SET LOCAL bm25_b = 0.75")
            cursor.execute("SET LOCAL enable_bm25_global_idf = off")
            cursor.execute(query, params)
            return cursor.fetchall()

    def search_by_fulltext(
        self,
        query_words: list[str],
        top_k: int = 10,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        tsvector_field: str = "properties_tsvector_zh",
        tsquery_config: str | None = "jiebacfg",
        return_fields: list[str] | None = None,
        *,
        cube_name: str | None = None,
        include_embedding: bool = False,
    ) -> list[dict]:
        """Return native BM25 OR matches and raw scores within the requested scopes.

        The legacy tsquery aliases select the native default tokenizer. Terms
        are natural text, not executable tsquery expressions. One recognized
        failed-write index error permits REINDEX and a fresh read, at most once.
        """
        self._ensure_open()
        if not isinstance(query_words, list) or any(
            not isinstance(word, str) for word in query_words
        ):
            raise ValueError("query_words must be a list of strings")
        terms = []
        for word in query_words:
            term = word.strip()
            if len(term) >= 2 and term[0] == term[-1] and term[0] in ("'", '"'):
                quote = term[0]
                term = term[1:-1]
                if quote == "'":
                    term = term.replace("''", "'")
                term = term.strip()
            if term and term not in terms:
                terms.append(term)
        if type(top_k) is not int or top_k < 0:
            raise ValueError("top_k must be a nonnegative integer")
        if threshold is not None:
            try:
                valid_threshold = (
                    type(threshold) in (int, float) and math.isfinite(threshold) and threshold >= 0
                )
            except OverflowError:
                valid_threshold = False
            if not valid_threshold:
                raise ValueError("threshold must be a finite nonnegative number")
        if tsvector_field not in ("properties_tsvector_zh", "memory") or tsquery_config not in (
            None,
            "jiebacfg",
            "jiebaqry",
        ):
            raise ValueError("Only native BM25 and the documented fulltext aliases are supported")
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        if return_fields is not None and (
            not isinstance(return_fields, list)
            or any(
                not isinstance(field, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field)
                for field in return_fields
            )
        ):
            raise ValueError("return_fields must contain valid field names")
        fields = list(dict.fromkeys(return_fields or []))
        if include_embedding and "embedding" not in fields:
            fields.append("embedding")
        with_embedding = "embedding" in fields
        scopes = self._filter_scopes(
            cube_name if cube_name is not None else user_name, knowledgebase_ids
        )
        if search_filter is not None and not isinstance(search_filter, dict):
            raise ValueError("search_filter must be an object")
        metadata = [{"field": key, "value": value} for key, value in (search_filter or {}).items()]
        if scope is not None:
            self._validate_id(scope)
            metadata.append({"field": "memory_type", "value": scope})
        metadata_sql, metadata_params = self._build_metadata_conditions(metadata)
        filter_sql, filter_params = self._build_filter_where_clause(filter)
        status_sql, status_params = self._filter_status("activated" if status is None else status)
        if not terms or top_k == 0:
            return []
        query_text = " ".join(terms)
        vector_column = "embedding::text" if with_embedding else "NULL"
        query = (
            f"SELECT business_id, memory, properties, {vector_column}, scope, memory <&> %(query)s "
            f"FROM ONLY {_TABLE} WHERE scope = ANY(%(scopes)s) "
            f"AND ({metadata_sql}) AND ({filter_sql}) AND ({status_sql}) "
            "ORDER BY memory <&> %(query)s DESC LIMIT %(top_k)s"
        )
        query_params = self._merge_bindings(
            metadata_params,
            filter_params,
            status_params,
            {"query": query_text, "scopes": scopes, "top_k": top_k},
        )
        try:
            rows = self._query_fulltext(query, query_params)
        except GraphDBError as exc:
            cause = exc.__cause__
            if (
                not isinstance(cause, psycopg2.Error)
                or cause.pgcode != "42809"
                or cause.diag.message_primary
                != (
                    "Last batch insert document failed, scanned score maybe affected, "
                    "please reindex or recreate bm25 index [memory_fulltext_bm25]."
                )
            ):
                raise
            self._rebuild_fulltext_index()
            rows = self._query_fulltext(query, query_params)
        ranked = []
        for row in rows:
            try:
                score = float(row[5])
                if not math.isfinite(score) or score < 0:
                    raise ValueError("Invalid BM25 score")
            except (TypeError, ValueError, OverflowError) as exc:
                raise GraphDBError("Invalid openGauss BM25 score") from exc
            node = self._decode_node(row[:4], row[4], with_embedding)
            item = {"id": node["id"], "score": score}
            for field in fields:
                if field in ("id", "score"):
                    continue
                if field == "user_name":
                    item[field] = row[4]
                elif field == "memory":
                    item[field] = node["memory"]
                else:
                    item[field] = node["metadata"].get(field)
            if threshold is None or score >= threshold:
                ranked.append((score, row[4], node["id"], item))
        ranked.sort(key=lambda hit: (-hit[0], hit[1], hit[2]))
        return [hit[3] for hit in ranked[:top_k]]

    def search_by_keywords_like(
        self,
        query_word: str,
        scope: str | None = None,
        status: str | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        return_fields: list[str] | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        """Return every literal SQL LIKE match, ordered by Cube and business ID."""
        self._ensure_open()
        if kwargs:
            raise ValueError("Unknown search_by_keywords_like arguments")
        if not isinstance(query_word, str) or "\0" in query_word:
            raise ValueError("query_word must be a string without NUL")
        if (len(query_word) - len(query_word.rstrip("\\"))) % 2:
            raise ValueError("query_word cannot end with an unpaired LIKE escape")
        if return_fields is not None and (
            not isinstance(return_fields, list)
            or any(
                not isinstance(field, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field)
                for field in return_fields
            )
        ):
            raise ValueError("return_fields must contain valid field names")
        fields = list(dict.fromkeys(return_fields or []))
        scopes = self._filter_scopes(user_name, knowledgebase_ids)
        if len(scopes) > 1 and "user_name" not in fields:
            fields.append("user_name")
        if search_filter is not None and not isinstance(search_filter, dict):
            raise ValueError("search_filter must be an object")
        metadata = [{"field": key, "value": value} for key, value in (search_filter or {}).items()]
        if scope is not None:
            self._validate_id(scope)
            metadata.append({"field": "memory_type", "value": scope})
        predicate, params = self._join_fragments(
            [
                self._build_metadata_conditions(metadata),
                self._build_filter_where_clause(filter),
                self._filter_status("activated" if status is None else status),
            ],
            " AND ",
        )
        with_embedding = "embedding" in fields
        vector_column = "embedding::text" if with_embedding else "NULL"
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, {vector_column}, scope FROM ONLY {_TABLE} "
                "WHERE scope = ANY(%(scopes)s) AND memory LIKE %(memos_like)s "
                f'AND {predicate} ORDER BY scope COLLATE "C", business_id COLLATE "C"',
                self._merge_bindings(params, {"scopes": scopes, "memos_like": query_word}),
            )
            results = []
            for row in cursor.fetchall():
                node = self._decode_node(row[:4], row[4], with_embedding)
                item = {"id": node["id"]}
                for field in fields:
                    if field == "id":
                        continue
                    if field == "user_name":
                        item[field] = row[4]
                    elif field == "memory":
                        item[field] = node["memory"]
                    else:
                        item[field] = node["metadata"].get(field)
                results.append(item)
            return results

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """Merge fields under a row lock, retaining unspecified values and scope."""
        self._ensure_open()
        scope = self._scope(user_name)
        if not isinstance(fields, dict):
            raise ValueError("fields must be a JSON object")
        supplied = {key: value for key, value in fields.items() if key != "memory"}
        self._encode_node(id, fields.get("memory", ""), supplied, scope)
        if not fields:
            return
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, embedding::text FROM ONLY {_TABLE} "
                "WHERE scope = %(scope)s AND business_id = %(id)s FOR UPDATE",
                {"scope": scope, "id": id},
            )
            row = cursor.fetchone()
            if row is None:
                return
            node = self._decode_node(row, scope, True)
            metadata = {**node["metadata"], **supplied}
            _, _, memory, vector, payload = self._encode_node(
                id, fields.get("memory", node["memory"]), metadata, scope
            )
            cursor.execute(
                f"UPDATE {_TABLE} SET memory = %(memory)s, embedding = %(embedding)s::pg_catalog.vector, "
                "properties = %(properties)s::ag_catalog.agtype WHERE scope = %(scope)s AND business_id = %(id)s",
                {
                    "memory": memory,
                    "embedding": vector,
                    "properties": payload,
                    "scope": scope,
                    "id": id,
                },
            )

    @staticmethod
    def _validate_edge_type(edge_type: str, allow_any: bool = True) -> None:
        if (
            not isinstance(edge_type, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", edge_type)
            or (edge_type == "ANY" and not allow_any)
        ):
            raise ValueError("Invalid relationship type")

    @staticmethod
    def _cypher(
        cursor: Any, body: str, parameters: dict[str, Any], columns: str = "result agtype"
    ) -> list[tuple]:
        # AGE requires a literal query body and a prepared agtype parameter.
        # This connection belongs exclusively to the pool borrower. Clearing
        # first also bounds statements left behind by an aborted transaction.
        cursor.execute("DEALLOCATE ALL")
        cursor.execute(
            "PREPARE memos_age (ag_catalog.agtype) AS SELECT * FROM "
            f"ag_catalog.cypher('memos_graph', $memos${body}$memos$, $1) AS ({columns})"
        )
        cursor.execute(
            "EXECUTE memos_age(%(parameters)s::ag_catalog.agtype)",
            {"parameters": json.dumps(parameters, ensure_ascii=False)},
        )
        rows = cursor.fetchall()
        cursor.execute("DEALLOCATE memos_age")
        return rows

    @staticmethod
    def _lock_graph_nodes(cursor: Any, ids: list[str], scope: str) -> set[str]:
        # The caller holds the graph advisory lock before taking these row
        # locks, which coordinate deletion with existing node upserts.
        cursor.execute(
            f"SELECT business_id FROM ONLY {_TABLE} "
            "WHERE scope = %(scope)s AND business_id = ANY(%(ids)s) ORDER BY business_id FOR UPDATE",
            {"scope": scope, "ids": sorted(set(ids))},
        )
        return {row[0] for row in cursor.fetchall()}

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """Atomically hard-delete one scoped node and all its incident native edges."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(id)
        with self._cursor(lock=2) as cursor:
            if not self._lock_graph_nodes(cursor, [id], scope):
                return
            self._cypher(
                cursor,
                _DELETE_INCIDENT_EDGES,
                {"id": id, "scope": scope},
            )
            # Native AGE node deletion bypasses SQL row triggers and DELETE
            # privileges in this build. Keep node mutations on the SQL label
            # path so projection, constraints and failure handling stay aligned.
            cursor.execute(
                _DELETE_NODE,
                {"scope": scope, "id": id},
            )

    def _change_edge(
        self, source: str, target: str, edge_type: str, user_name: str | None, create: bool
    ) -> None:
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(source)
        self._validate_id(target)
        self._validate_edge_type(edge_type, allow_any=False)
        endpoints = {source, target}
        with self._cursor(lock=2) as cursor:
            if self._lock_graph_nodes(cursor, list(endpoints), scope) != endpoints:
                return
            conditions = (
                "a.id = $source AND b.id = $target "
                "AND a.user_name = $scope AND b.user_name = $scope "
            )
            body = (
                f"MATCH (a:Memory), (b:Memory) WHERE {conditions}MERGE (a)-[:{edge_type}]->(b)"
                if create
                else f"MATCH (a:Memory)-[r]->(b:Memory) WHERE {conditions}"
                "AND type(r) = $type DELETE r"
            )
            parameters = {"source": source, "target": target, "scope": scope}
            if not create:
                parameters["type"] = edge_type
            self._cypher(cursor, body, parameters)

    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Merge a directed typed edge; a missing scoped endpoint is a no-op."""
        self._change_edge(source_id, target_id, type, user_name, create=True)

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Remove only the given direction and type, retaining parallel edges."""
        self._change_edge(source_id, target_id, type, user_name, create=False)

    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY", user_name: str | None = None
    ) -> list[dict[str, str]]:
        """Return sorted, unique from/to/type records, with both endpoints scoped."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(id)
        self._validate_edge_type(type)
        if direction not in ("OUTGOING", "INCOMING", "ANY"):
            raise ValueError("Invalid edge direction")
        endpoint = {
            "OUTGOING": "a.id = $id",
            "INCOMING": "b.id = $id",
            "ANY": "(a.id = $id OR b.id = $id)",
        }[direction]
        condition = "" if type == "ANY" else " AND type(r) = $type"
        with self._cursor() as cursor:
            return self._read_edges(
                cursor,
                endpoint + condition,
                {"id": id, "scope": scope, "type": type},
            )

    def _read_edges(
        self, cursor: Any, condition: str, parameters: dict[str, Any]
    ) -> list[dict[str, str]]:
        rows = self._cypher(
            cursor,
            "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
            f"{condition} AND a.user_name = $scope AND b.user_name = $scope "
            "RETURN a.id, b.id, type(r)",
            parameters,
            "source agtype, target agtype, edge_type agtype",
        )
        edges = set()
        try:
            for row in rows:
                edge = tuple(json.loads(value) for value in row)
                if len(edge) != 3 or not all(isinstance(value, str) for value in edge):
                    raise ValueError("Invalid edge fields")
                edges.add(edge)
        except (TypeError, ValueError) as exc:
            raise GraphDBError("Invalid AGE edge projection") from exc
        return [
            {"from": source, "to": target, "type": edge_type}
            for source, target, edge_type in sorted(edges)
        ]

    def edge_exists(
        self,
        source_id: str,
        target_id: str,
        type: str = "ANY",
        direction: str = "OUTGOING",
        user_name: str | None = None,
    ) -> bool:
        """Check adjacency in the requested direction without crossing scopes."""
        self._ensure_open()
        self._validate_id(target_id)
        return any(
            (edge["to"] if edge["from"] == source_id else edge["from"]) == target_id
            for edge in self.get_edges(source_id, type, direction, user_name)
        )

    def get_neighbors(
        self, id: str, type: str, direction: str = "out", user_name: str | None = None
    ) -> list[str]:
        """Return unique sorted neighboring business IDs, including self-loops."""
        self._ensure_open()
        if direction not in ("in", "out", "both"):
            raise ValueError("Invalid neighbor direction")
        edges = self.get_edges(
            id, type, {"in": "INCOMING", "out": "OUTGOING", "both": "ANY"}[direction], user_name
        )
        return sorted({edge["to"] if edge["from"] == id else edge["from"] for edge in edges})

    def get_context_chain(
        self, id: str, type: str = "FOLLOWS", user_name: str | None = None
    ) -> list[str]:
        """Return one-hop outgoing neighbors, matching the existing context contract."""
        return self.get_neighbors(id, type=type, direction="out", user_name=user_name)

    def deduplicate_nodes(self) -> None:
        """Persistent semantic deduplication is outside this backend's capabilities."""
        self._ensure_open()
        raise NotImplementedError("openGauss does not support deduplicate_nodes")

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """Semantic conflict detection is outside this backend's capabilities."""
        self._ensure_open()
        raise NotImplementedError("openGauss does not support detect_conflicts")

    def merge_nodes(self, id1: str, id2: str) -> str:
        """Semantic node merging is outside this backend's capabilities."""
        self._ensure_open()
        raise NotImplementedError("openGauss does not support merge_nodes")

    @staticmethod
    def _validate_depth(depth: int) -> None:
        if type(depth) is not int or not 1 <= depth <= 5:
            raise ValueError("depth must be an integer from 1 to 5")

    def get_path(
        self, source_id: str, target_id: str, max_depth: int = 3, user_name: str | None = None
    ) -> list[str]:
        """Find the lexicographically first shortest directed path within 1-5 hops."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(source_id)
        self._validate_id(target_id)
        self._validate_depth(max_depth)
        with self._cursor() as cursor:
            endpoints = {source_id, target_id}
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} WHERE scope = %(scope)s AND business_id = ANY(%(ids)s)",
                {"scope": scope, "ids": sorted(endpoints)},
            )
            if {row[0] for row in cursor.fetchall()} != endpoints:
                return []
            if source_id == target_id:
                return [source_id]
            paths = {source_id: [source_id]}
            frontier = [source_id]
            for _ in range(max_depth):
                edges = self._read_edges(cursor, "a.id IN $ids", {"scope": scope, "ids": frontier})
                adjacency: dict[str, set[str]] = {}
                for edge in edges:
                    adjacency.setdefault(edge["from"], set()).add(edge["to"])
                following = []
                # Discovery order preserves lexicographic order of full paths.
                for source in frontier:
                    for target in sorted(adjacency.get(source, set())):
                        if target in paths:
                            continue
                        paths[target] = [*paths[source], target]
                        if target == target_id:
                            return paths[target]
                        following.append(target)
                frontier = following
                if not frontier:
                    break
        return []

    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str | None = "activated",
        user_name: str | None = None,
    ) -> dict[str, Any]:
        """Return full scoped nodes and the induced edges within a two-way radius."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_id(center_id)
        self._validate_depth(depth)
        if center_status is not None and not isinstance(center_status, str):
            raise ValueError("center_status must be a string or None")
        empty = {"core_node": None, "neighbors": [], "edges": []}
        with self._cursor() as cursor:
            core = self._read_nodes(cursor, [center_id], scope).get(center_id)
            if core is None or (
                center_status and core["metadata"].get("status", "activated") != center_status
            ):
                return empty
            reached = {center_id}
            frontier = [center_id]
            for _ in range(depth):
                edges = self._read_edges(
                    cursor,
                    "(a.id IN $ids OR b.id IN $ids)",
                    {"scope": scope, "ids": frontier},
                )
                following = {edge[key] for edge in edges for key in ("from", "to")} - reached
                if not following:
                    break
                reached.update(following)
                frontier = sorted(following)
            neighbors = self._read_nodes(cursor, sorted(reached - {center_id}), scope)
            present = {center_id, *neighbors}
            edges = self._read_edges(
                cursor,
                "a.id IN $ids AND b.id IN $ids",
                {"scope": scope, "ids": sorted(present)},
            )
            return {
                "core_node": core,
                "neighbors": [neighbors[node_id] for node_id in sorted(neighbors)],
                "edges": [
                    {"source": edge["from"], "target": edge["to"], "type": edge["type"]}
                    for edge in edges
                ],
            }

    @staticmethod
    def _validate_string_list(values: list[str], name: str) -> None:
        if not isinstance(values, list) or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            raise ValueError(f"{name} must be a list of nonblank strings")

    @staticmethod
    def _node_tags(value: Any) -> set[str]:
        if value is None:
            return set()
        try:
            tags = json.loads(value) if isinstance(value, str) else value
            if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
                raise ValueError("Invalid tag list")
            return set(tags)
        except (TypeError, ValueError) as exc:
            raise GraphDBError("Invalid AGE node tags") from exc

    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Rank active, non-reasoning/non-working scoped nodes by unique tag overlap."""
        self._ensure_open()
        scope = self._scope(user_name)
        self._validate_string_list(tags, "tags")
        self._validate_string_list(exclude_ids, "exclude_ids")
        if type(top_k) is not int or top_k < 0:
            raise ValueError("top_k must be a nonnegative integer")
        if type(min_overlap) is not int or min_overlap < 1:
            raise ValueError("min_overlap must be a positive integer")
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        if not tags or top_k == 0:
            return []
        requested = set(tags)
        vector_column = "embedding::text" if include_embedding else "NULL"
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, {vector_column} FROM ONLY {_TABLE} "
                "WHERE scope = %(scope)s AND NOT (business_id = ANY(%(ids)s))",
                {"scope": scope, "ids": exclude_ids},
            )
            ranked = []
            for row in cursor.fetchall():
                node = self._decode_node(row, scope, include_embedding)
                metadata = node["metadata"]
                if (
                    metadata.get("status", "activated") != "activated"
                    or metadata.get("type") == "reasoning"
                    or metadata.get("node_type") == "reasoning"
                    or metadata.get("memory_type") == "WorkingMemory"
                ):
                    continue
                overlap = len(requested & self._node_tags(metadata.get("tags")))
                if overlap >= min_overlap:
                    ranked.append((overlap, node))
        ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
        return [node for _, node in ranked[:top_k]]

    def _filter_scopes(
        self, user_name: str | None, knowledgebase_ids: list[str] | None
    ) -> list[str]:
        scopes = [self._scope(user_name)]
        if knowledgebase_ids is not None:
            self._validate_string_list(knowledgebase_ids, "knowledgebase_ids")
            scopes.extend(knowledgebase_ids)
        return sorted(set(scopes))

    @staticmethod
    def _filter_status(status: str | None) -> tuple[str, dict[str, Any]]:
        if status is None:
            return "TRUE", {}
        if not isinstance(status, str) or not status.strip():
            raise ValueError("status must be a nonblank string or None")
        return (
            "(CASE WHEN properties ? 'status'::text THEN "
            "ag_catalog.agtype_access_operator(properties, '\"status\"'::ag_catalog.agtype) "
            "ELSE '\"activated\"'::ag_catalog.agtype END) = %(memos_status)s::ag_catalog.agtype",
            {"memos_status": json.dumps(status)},
        )

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
        status: str | None = None,
    ) -> list[str]:
        """Read matching IDs in explicit scopes, ordered by scope then business ID."""
        self._ensure_open()
        scopes = self._filter_scopes(user_name, knowledgebase_ids)
        if user_name_flag is not True:
            raise ValueError("Disabling scope isolation is unsupported")
        metadata_sql, metadata_params = self._build_metadata_conditions(filters)
        filter_sql, filter_params = self._build_filter_where_clause(filter)
        status_sql, status_params = self._filter_status(status)
        params = self._merge_bindings(
            metadata_params, filter_params, status_params, {"scopes": scopes}
        )
        with self._cursor(utc=True) as cursor:
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} WHERE scope = ANY(%(scopes)s) "
                f"AND ({metadata_sql}) AND ({filter_sql}) AND ({status_sql}) "
                "ORDER BY scope, business_id",
                params,
            )
            return [row[0] for row in cursor.fetchall()]

    def get_all_memory_items(
        self,
        scope: str,
        user_name: str | None = None,
        include_embedding: bool = False,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        """List a memory type without a hidden cap, including explicit Dream types."""
        self._ensure_open()
        scopes = self._filter_scopes(user_name, knowledgebase_ids)
        self._validate_id(scope)
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        type_sql, type_params = self._build_metadata_conditions(
            [{"field": "memory_type", "value": scope}]
        )
        filter_sql, filter_params = self._build_filter_where_clause(filter)
        status_sql, status_params = self._filter_status(status)
        params = self._merge_bindings(type_params, filter_params, status_params, {"scopes": scopes})
        vector_column = "embedding::text" if include_embedding else "NULL"
        with self._cursor(utc=True) as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, {vector_column}, scope FROM ONLY {_TABLE} "
                f"WHERE scope = ANY(%(scopes)s) AND ({type_sql}) AND ({filter_sql}) AND ({status_sql}) "
                "ORDER BY scope, business_id",
                params,
            )
            nodes = []
            for row in cursor.fetchall():
                node = self._decode_node(row[:4], row[4], include_embedding)
                if len(scopes) > 1:
                    node["metadata"]["user_name"] = row[4]
                nodes.append(node)
            return nodes

    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """Atomically hard-delete one selector in explicit or default scopes."""
        self._ensure_open()
        if writable_cube_ids is None:
            scopes = [self._scope(None)]
        else:
            self._validate_string_list(writable_cube_ids, "writable_cube_ids")
            scopes = sorted(set(writable_cube_ids))
        for name, values in (("memory_ids", memory_ids), ("file_ids", file_ids)):
            if values is not None:
                self._validate_string_list(values, name)
        predicate, params = self._build_filter_where_clause(filter)
        modes = sum(bool(value) for value in (memory_ids, file_ids, filter))
        if modes > 1:
            raise ValueError("Select only one of memory_ids, file_ids or filter")
        if memory_ids:
            predicate, params = self._build_metadata_conditions(
                [{"field": "id", "op": "in", "value": memory_ids}]
            )
        elif file_ids:
            predicate, params = self._build_metadata_conditions(
                [{"field": "file_ids", "op": "contains", "value": file_ids}]
            )
        if not modes or not scopes:
            return 0
        params = self._merge_bindings(params, {"scopes": scopes})
        with self._cursor(utc=True, lock=2) as cursor:
            cursor.execute(
                f"SELECT scope, business_id FROM ONLY {_TABLE} WHERE scope = ANY(%(scopes)s) "
                f"AND ({predicate}) ORDER BY scope, business_id FOR UPDATE",
                params,
            )
            selected = cursor.fetchall()
            deleted = 0
            for owner, node_id in selected:
                self._cypher(
                    cursor,
                    _DELETE_INCIDENT_EDGES,
                    {"id": node_id, "scope": owner},
                )
                cursor.execute(
                    _DELETE_NODE,
                    {"scope": owner, "id": node_id},
                )
                deleted += cursor.rowcount
            return deleted

    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str | None = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Group all scoped rows by AGE values, with an optional trusted SQL predicate.

        Callers must supply constant SQL and bind dynamic values through params.
        This interface is not a sandbox for SQL supplied by end users.
        """
        self._ensure_open()
        scope = self._scope(user_name)
        if "\0" in scope:
            raise ValueError("user_name must not contain NUL")
        predicate, params = self._validate_grouping(group_fields, where_clause, params)
        query, bindings = self._build_grouping_query(group_fields, predicate, params, scope)
        with self._cursor() as cursor:
            # AGE's numeric equality merges 1 and 1.0, but this build's hash
            # aggregation does not. Keep the workaround local to this read.
            cursor.execute("SET LOCAL enable_hashagg = off")
            cursor.execute(query, bindings)
            return self._decode_grouped_rows(group_fields, cursor.fetchall())

    @staticmethod
    def _validate_grouping(
        group_fields: list[str], where_clause: str | None, params: dict[str, Any] | None
    ) -> tuple[str, dict[str, Any]]:
        """Validate trusted predicates and scalar user bindings before borrowing."""
        if not isinstance(group_fields, list) or not group_fields:
            raise ValueError("group_fields must be a nonempty list")
        for field in group_fields:
            if (
                not isinstance(field, str)
                or not re.fullmatch(r"(?:info\.)?[A-Za-z_][A-Za-z0-9_]*", field)
                or field == "count"
            ):
                raise ValueError("Invalid grouping field")
        if len(set(group_fields)) != len(group_fields):
            raise ValueError("Grouping fields must be unique")
        if where_clause is not None and not isinstance(where_clause, str):
            raise ValueError("where_clause must be a string or None")
        predicate = re.sub(r"(?i)^WHERE\b", "", (where_clause or "").strip(), count=1).strip()
        if any(token in predicate for token in ("\0", ";", "--", "/*")):
            raise ValueError("Invalid SQL predicate")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise ValueError("params must be a dict or None")
        for key, value in params.items():
            if (
                not isinstance(key, str)
                or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or key.startswith("memos_")
            ):
                raise ValueError("Invalid or reserved SQL parameter name")
            if (
                type(value) not in (type(None), bool, int, float, str)
                or (type(value) is float and not math.isfinite(value))
                or (type(value) is str and "\0" in value)
            ):
                raise ValueError("SQL parameters must be finite scalar values without NUL")
        placeholder = re.compile(r"%%|%\(([A-Za-z_][A-Za-z0-9_]*)\)s")
        keys = {match[1] for match in placeholder.finditer(predicate) if match[1] is not None}
        if "%" in placeholder.sub("", predicate) or keys != set(params):
            raise ValueError("SQL placeholders must exactly match named parameters")
        return predicate, dict(params)

    def _build_grouping_query(
        self, group_fields: list[str], predicate: str, params: dict[str, Any], scope: str
    ) -> tuple[str, dict[str, Any]]:
        """Build deterministic AGE value grouping with a separate outer scope."""
        bindings = self._merge_bindings(params, {"memos_scope": scope})
        expressions = []
        for index, field in enumerate(group_fields):
            expression, field_params = self._field_expr(
                field.split("."), prefix=f"memos_group_{index}"
            )
            bindings = self._merge_bindings(bindings, field_params)
            expressions.append(f"{expression} AS g{index}")
        groups = ", ".join(f"g{i}" for i in range(len(group_fields)))
        representatives = ", ".join(
            f'MIN(ag_catalog.agtype_out(g{i})::text COLLATE "C") AS r{i}'
            for i in range(len(group_fields))
        )
        order = ", ".join(f'r{i} COLLATE "C" ASC NULLS LAST' for i in range(len(group_fields)))
        query = (
            f"SELECT {representatives}, COUNT(*) FROM "
            f"(SELECT {', '.join(expressions)} FROM ONLY {_TABLE} "
            "WHERE scope = %(memos_scope)s"
            + (f" AND ({predicate})" if predicate else "")
            + f") AS grouped GROUP BY {groups} ORDER BY {order}"
        )
        return query, bindings

    @staticmethod
    def _decode_grouped_rows(group_fields: list[str], rows: list[tuple]) -> list[dict[str, Any]]:
        """Decode scalar/structured AGE representatives before the transaction commits."""
        result = []
        for row in rows:
            record = {}
            for field, payload in zip(group_fields, row[:-1], strict=True):
                try:
                    record[field] = (
                        None
                        if payload is None
                        else json.loads(
                            _AGE_JSON_TOKEN.sub(
                                lambda token: token[0]
                                if token[0].startswith('"')
                                else f"{token[1]}0.{token[2]}",
                                payload,
                            )
                        )
                    )
                    # Python's JSON parser accepts NaN/Infinity extensions;
                    # AGE results must still be finite JSON, including nested values.
                    json.dumps(record[field], allow_nan=False)
                except (TypeError, ValueError) as exc:
                    raise GraphDBError("Invalid AGE grouped value") from exc
            record["count"] = row[-1]
            result.append(record)
        return result

    def _capacity_scope(self, memory_type: str, user_name: str | None) -> str:
        """Validate the type and Cube before borrowing a connection."""
        self._ensure_open()
        scope = self._scope(user_name)
        if (
            not isinstance(memory_type, str)
            or not memory_type.strip()
            or "\0" in memory_type
            or "\0" in scope
        ):
            raise ValueError("memory_type and user_name must be nonblank strings without NUL")
        return scope

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        """Count occupied rows of one type, including archived and deleted rows."""
        scope = self._capacity_scope(memory_type, user_name)
        kind, params = self._build_equal_condition(
            ["memory_type"], memory_type, prefix="memos_type"
        )
        params = self._merge_bindings(params, {"scope": scope})
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT COUNT(*) FROM ONLY {_TABLE} WHERE scope = %(scope)s AND {kind}",
                params,
            )
            return cursor.fetchone()[0]

    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        """Return integer one only when this Cube has no rows of the given type."""
        return int(self.get_memory_count(scope, user_name) == 0)

    def get_structure_optimization_candidates(
        self,
        scope: str,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Read activated nodes without same-Cube PARENT adjacency in one snapshot."""
        owner = self._capacity_scope(scope, user_name)
        if not isinstance(include_embedding, bool):
            raise ValueError("include_embedding must be a bool")
        condition, params = self._join_fragments(
            [
                self._build_equal_condition(["memory_type"], scope, prefix="memos_type"),
                self._build_equal_condition(["status"], "activated", prefix="memos_status"),
            ],
            " AND ",
        )
        vector = "m.embedding::text" if include_embedding else "NULL"
        # The inherited edge table also works before a PARENT label exists.
        # Its tableoid identifies the AGE label; native graphids join endpoints
        # without conflating equal business IDs in different Cubes.
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT m.business_id, m.memory, m.properties, {vector} FROM ONLY {_TABLE} m "
                f"WHERE m.scope = %(scope)s AND {condition} AND NOT EXISTS ("
                "SELECT 1 FROM memos_graph._ag_label_edge e "
                "JOIN ag_catalog.ag_label l ON l.relation = e.tableoid "
                "AND l.name = 'PARENT' AND l.kind = 'e' "
                f"JOIN ONLY {_TABLE} n ON n.scope = m.scope AND "
                "((e.start_id = m.id AND e.end_id = n.id) OR "
                "(e.end_id = m.id AND e.start_id = n.id))) "
                'ORDER BY m.business_id COLLATE "C"',
                self._merge_bindings(params, {"scope": owner}),
            )
            return [self._decode_node(row, owner, include_embedding) for row in cursor.fetchall()]

    def _maintenance_scope(self, user_name: str | None) -> str:
        self._ensure_open()
        scope = self._scope(user_name)
        if "\0" in scope:
            raise ValueError("user_name cannot contain NUL")
        return scope

    def _maintenance_strings(self, values: list[str], name: str) -> None:
        self._validate_string_list(values, name)
        if any("\0" in value for value in values):
            raise ValueError(f"{name} cannot contain NUL")

    def export_graph(
        self,
        include_embedding: bool = False,
        user_name: str | None = None,
        user_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        filter: dict | None = None,
        memory_type: list[str] | None = None,
        status: list[str] | None = None,
        *,
        all_cubes: bool = False,
        exclude_user_name: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Export a consistent filtered page; cross-Cube reads require explicit opt-in."""
        self._ensure_open()
        if kwargs:
            raise ValueError("Unknown export_graph arguments")
        if not isinstance(include_embedding, bool) or not isinstance(all_cubes, bool):
            raise ValueError("include_embedding and all_cubes must be bool")
        if all_cubes and user_name is not None:
            raise ValueError("all_cubes and user_name are mutually exclusive")
        if (page is None) != (page_size is None) or any(
            type(value) is not int or value <= 0 for value in (page, page_size) if value is not None
        ):
            raise ValueError("page and page_size must both be positive integers or omitted")
        parts = [self._build_filter_where_clause(filter)]
        if exclude_user_name is not None:
            if not all_cubes:
                raise ValueError("exclude_user_name requires all_cubes=True")
            self._maintenance_scope(exclude_user_name)
            parts.append(
                ("scope <> %(memos_excluded_owner)s", {"memos_excluded_owner": exclude_user_name})
            )
        if not all_cubes:
            parts.append(
                ("scope = %(memos_owner)s", {"memos_owner": self._maintenance_scope(user_name)})
            )
        if user_id is not None:
            self._maintenance_strings([user_id], "user_id")
            parts.append(self._build_equal_condition(["user_id"], user_id, prefix="memos_user"))
        if memory_type is not None:
            self._maintenance_strings(memory_type, "memory_type")
            if memory_type:
                parts.append(
                    self._build_filter_condition(
                        "memory_type", "in", memory_type, prefix="memos_types"
                    )
                )
        if status is None:
            deleted, bound = self._build_equal_condition(
                ["status"], "deleted", prefix="memos_deleted"
            )
            parts.append((f"({deleted}) IS NOT TRUE", bound))
        else:
            self._maintenance_strings(status, "status")
            if status:
                statuses = []
                for index, value in enumerate(status):
                    expression, bound = self._filter_status(value)
                    key = f"memos_status_{index}"
                    statuses.append(
                        (
                            expression.replace("%(memos_status)s", f"%({key})s"),
                            {key: bound["memos_status"]},
                        )
                    )
                expression, bound = self._join_fragments(statuses, " OR ")
                parts.append((f"({expression})", bound))
        predicate, params = self._join_fragments(parts, " AND ")
        instant, time_params = self._text_field_expr(["created_at"], prefix="memos_created")
        vector = "embedding::text" if include_embedding else "NULL"
        pagination = ""
        page_params = {}
        if page is not None:
            pagination = " LIMIT %(memos_limit)s OFFSET %(memos_offset)s"
            page_params = {"memos_limit": page_size, "memos_offset": (page - 1) * page_size}
        with self._cursor(utc=True, snapshot=True) as cursor:
            cursor.execute(f"SELECT COUNT(*) FROM ONLY {_TABLE} WHERE {predicate}", params)
            total = cursor.fetchone()[0]
            cursor.execute(
                f"SELECT business_id, memory, properties, {vector}, scope, id::text "
                f"FROM ONLY {_TABLE} WHERE {predicate} "
                f"ORDER BY {instant}::timestamptz DESC NULLS LAST, "
                'business_id COLLATE "C" DESC, scope COLLATE "C"' + pagination,
                self._merge_bindings(params, time_params, page_params),
            )
            rows = cursor.fetchall()
            nodes = []
            for row in rows:
                node = self._decode_node(row[:4], row[4], include_embedding)
                node["metadata"]["user_name"] = row[4]
                nodes.append(node)
            edges = self._export_edges(cursor, [row[5] for row in rows], all_cubes)
            return {"nodes": nodes, "edges": edges, "total_nodes": total, "total_edges": len(edges)}

    def _export_edges(
        self, cursor: Any, graphids: list[str], all_cubes: bool
    ) -> list[dict[str, str]]:
        if not graphids:
            return []
        cursor.execute(
            "SELECT a.business_id, b.business_id, l.name, a.scope "
            "FROM memos_graph._ag_label_edge e "
            "JOIN ag_catalog.ag_label l ON l.relation = e.tableoid AND l.kind = 'e' "
            f"JOIN ONLY {_TABLE} a ON a.id = e.start_id "
            f"JOIN ONLY {_TABLE} b ON b.id = e.end_id AND b.scope = a.scope "
            "WHERE a.id::text = ANY(%(graphids)s) AND b.id::text = ANY(%(graphids)s)",
            {"graphids": graphids},
        )
        edges = set()
        for source, target, kind, owner in cursor.fetchall():
            if not all(isinstance(value, str) for value in (source, target, kind, owner)):
                raise GraphDBError("Invalid stored openGauss edge")
            edges.add((owner, source, target, kind))
        return [
            {
                "source": source,
                "target": target,
                "type": kind,
                **({"user_name": owner} if all_cubes else {}),
            }
            for owner, source, target, kind in sorted(edges)
        ]

    @staticmethod
    def _reject_nul(value: Any) -> None:
        if isinstance(value, str):
            if "\0" in value:
                raise ValueError("Import strings cannot contain NUL")
        elif isinstance(value, dict):
            for key, item in value.items():
                OpenGaussGraphDB._reject_nul(key)
                OpenGaussGraphDB._reject_nul(item)
        elif isinstance(value, list):
            for item in value:
                OpenGaussGraphDB._reject_nul(item)

    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        """Atomically upsert one Cube's nodes and merge edges with existing endpoints."""
        scope = self._maintenance_scope(user_name)
        if (
            not isinstance(data, dict)
            or not isinstance(data.get("nodes", []), list)
            or not isinstance(data.get("edges", []), list)
        ):
            raise ValueError("Graph data must contain nodes and edges lists")
        self._reject_nul(data)
        nodes = {}
        for node in data.get("nodes", []):
            if not isinstance(node, dict) or "id" not in node or "memory" not in node:
                raise ValueError("Each import node needs id and memory")
            encoded = self._encode_node(node["id"], node["memory"], node.get("metadata", {}), scope)
            if node["id"] in nodes:
                raise ValueError("Duplicate import node ID")
            nodes[node["id"]] = encoded
        edges = set()
        endpoints = set()
        for edge in data.get("edges", []):
            if not isinstance(edge, dict) or not {"source", "target", "type"} <= edge.keys():
                raise ValueError("Each import edge needs source, target and type")
            self._validate_id(edge["source"])
            self._validate_id(edge["target"])
            self._validate_edge_type(edge["type"], allow_any=False)
            if edge.get("user_name", scope) != scope:
                raise ValueError("Import edge user_name must match the target Cube")
            edges.add((edge["source"], edge["target"], edge["type"]))
            endpoints.update((edge["source"], edge["target"]))
        if not nodes and not edges:
            return
        with self._cursor(lock=2) as cursor:
            existing = self._lock_graph_nodes(cursor, sorted(set(nodes) | endpoints), scope)
            if endpoints - existing - nodes.keys():
                raise GraphDBError("An import edge endpoint does not exist in the target Cube")
            for key in sorted(nodes):
                owner, node_id, memory, embedding, properties = nodes[key]
                cursor.execute(
                    _UPSERT,
                    {
                        "scope": owner,
                        "id": node_id,
                        "memory": memory,
                        "embedding": embedding,
                        "properties": properties,
                    },
                )
            for source, target, kind in sorted(edges):
                self._cypher(
                    cursor,
                    "MATCH (a:Memory), (b:Memory) WHERE a.id=$source AND b.id=$target "
                    "AND a.user_name=$scope AND b.user_name=$scope "
                    f"MERGE (a)-[:{kind}]->(b)",
                    {"source": source, "target": target, "scope": scope},
                )

    def _delete_locked_nodes(self, cursor: Any, scope: str, ids: list[str]) -> int:
        deleted = 0
        for offset in range(0, len(ids), 500):
            batch = ids[offset : offset + 500]
            self._cypher(
                cursor,
                "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
                "(a.user_name = $scope AND a.id IN $ids) OR "
                "(b.user_name = $scope AND b.id IN $ids) DELETE r",
                {"scope": scope, "ids": batch},
            )
            cursor.execute(
                f"DELETE FROM ONLY {_TABLE} WHERE scope = %(scope)s AND business_id = ANY(%(ids)s)",
                {"scope": scope, "ids": batch},
            )
            deleted += cursor.rowcount
        return deleted

    def clear(self, user_name: str | None = None) -> None:
        """Clear a fixed locked set in one Cube, retaining graph schema and other Cubes."""
        scope = self._maintenance_scope(user_name)
        with self._cursor(lock=2) as cursor:
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} WHERE scope = %(scope)s ORDER BY business_id FOR UPDATE",
                {"scope": scope},
            )
            self._delete_locked_nodes(cursor, scope, [row[0] for row in cursor.fetchall()])

    def drop_database(self) -> None:
        """Compatibility operation: clear the configured Cube, never drop the database."""
        self.clear()

    def get_user_names_by_memory_ids(self, memory_ids: list[str]) -> dict[str, str | None]:
        """Resolve unique stored ownership; never arbitrarily choose among multiple Cubes."""
        self._ensure_open()
        self._maintenance_strings(memory_ids, "memory_ids")
        result = dict.fromkeys(memory_ids)
        if not result:
            return result
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT business_id, scope FROM ONLY {_TABLE} WHERE business_id = ANY(%(ids)s)",
                {"ids": list(result)},
            )
            for node_id, owner in cursor.fetchall():
                if result[node_id] is not None and result[node_id] != owner:
                    raise GraphDBError("A memory ID belongs to multiple Cubes")
                result[node_id] = owner
            return result

    def exist_user_name(self, user_name: str) -> dict[str, bool]:
        """Report stored data presence, including archived and deleted memories."""
        self._ensure_open()
        self._maintenance_strings([user_name], "user_name")
        with self._cursor() as cursor:
            cursor.execute(
                f"SELECT EXISTS (SELECT 1 FROM ONLY {_TABLE} WHERE scope = %(scope)s)",
                {"scope": user_name},
            )
            return {user_name: bool(cursor.fetchone()[0])}

    def delete_node_by_mem_cube_id(
        self, mem_cube_id: str, delete_record_id: str, hard_delete: bool = False
    ) -> int:
        """Mark currently nondeleted rows, or hard-delete one already-deleted batch."""
        self._ensure_open()
        if not isinstance(hard_delete, bool):
            raise ValueError("hard_delete must be a bool")
        return self._change_deletion_record(
            mem_cube_id, delete_record_id, "hard" if hard_delete else "delete"
        )

    def recover_memory_by_mem_cube_id(self, mem_cube_id: str, delete_record_id: str) -> int:
        """Reactivate only deleted rows carrying this Cube's deletion batch."""
        return self._change_deletion_record(mem_cube_id, delete_record_id, "recover")

    def _change_deletion_record(self, scope: str, record_id: str, action: str) -> int:
        self._ensure_open()
        self._maintenance_strings([scope, record_id], "Cube and deletion record")
        deleted, params = self._build_equal_condition(["status"], "deleted", prefix="memos_deleted")
        if action == "delete":
            predicate = f"({deleted}) IS NOT TRUE"
        else:
            batch, bound = self._build_equal_condition(
                ["delete_record_id"], record_id, prefix="memos_batch"
            )
            predicate = f"{deleted} AND {batch}"
            params = self._merge_bindings(params, bound)
        with self._cursor(lock=2) as cursor:
            cursor.execute(
                f"SELECT business_id, memory, properties, NULL FROM ONLY {_TABLE} "
                f"WHERE scope = %(scope)s AND ({predicate}) ORDER BY business_id FOR UPDATE",
                self._merge_bindings(params, {"scope": scope}),
            )
            rows = cursor.fetchall()
            if action == "hard":
                return self._delete_locked_nodes(cursor, scope, [row[0] for row in rows])
            changes = (
                {
                    "status": "deleted",
                    "delete_record_id": record_id,
                    "delete_time": datetime.now(timezone.utc).isoformat(),
                }
                if action == "delete"
                else {"status": "activated", "delete_record_id": "", "delete_time": ""}
            )
            affected = 0
            for row in rows:
                node = self._decode_node(row, scope, False)
                metadata = {**node["metadata"], **changes}
                payload = self._encode_node(node["id"], node["memory"], metadata, scope)[4]
                cursor.execute(
                    f"UPDATE ONLY {_TABLE} SET properties = %(properties)s::ag_catalog.agtype "
                    "WHERE scope = %(scope)s AND business_id = %(id)s",
                    {"scope": scope, "id": node["id"], "properties": payload},
                )
                affected += cursor.rowcount
            return affected

    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int | str, user_name: str | None = None
    ) -> None:
        """Trim atomically; digit strings are limited to 64 characters, including zeros."""
        scope = self._capacity_scope(memory_type, user_name)
        if isinstance(keep_latest, str) and len(keep_latest) > 64:
            raise ValueError("keep_latest digit strings must contain at most 64 characters")
        if isinstance(keep_latest, str) and re.fullmatch(r"[0-9]+", keep_latest):
            keep_latest = int(keep_latest)
        if type(keep_latest) is not int or keep_latest < 0:
            raise ValueError("keep_latest must be a nonnegative integer or ASCII digit string")
        kind, params = self._build_equal_condition(
            ["memory_type"], memory_type, prefix="memos_type"
        )
        params = self._merge_bindings(params, {"scope": scope})
        with self._cursor(lock=2) as cursor:
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} WHERE scope = %(scope)s "
                f"AND {kind} ORDER BY business_id FOR UPDATE",
                params,
            )
            locked = [row[0] for row in cursor.fetchall()]
            if not locked:
                return
            cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            instant, time_params = self._text_field_expr(["updated_at"], prefix="memos_time")
            cursor.execute(
                f"SELECT business_id FROM ONLY {_TABLE} "
                "WHERE scope = %(scope)s AND business_id = ANY(%(ids)s) "
                f"ORDER BY {instant}::timestamptz DESC NULLS LAST, "
                'business_id COLLATE "C" DESC',
                self._merge_bindings(time_params, {"scope": scope, "ids": locked}),
            )
            # Fetch the full ranking even when keep=0 or keep>=len(S): every
            # locked timestamp must be parsed before any deletion can occur.
            ranked = [row[0] for row in cursor.fetchall()]
            deleted = sorted(ranked[min(keep_latest, len(ranked)) :])
            for offset in range(0, len(deleted), 500):
                batch = deleted[offset : offset + 500]
                self._cypher(
                    cursor,
                    "MATCH (a:Memory)-[r]->(b:Memory) WHERE "
                    "(a.user_name = $scope AND a.id IN $ids) OR "
                    "(b.user_name = $scope AND b.id IN $ids) DELETE r",
                    {"scope": scope, "ids": batch},
                )
                cursor.execute(
                    f"DELETE FROM ONLY {_TABLE} WHERE scope = %(scope)s AND business_id = ANY(%(ids)s)",
                    {"scope": scope, "ids": batch},
                )

    @staticmethod
    def _merge_bindings(*parts: dict[str, Any]) -> dict[str, Any]:
        """Compose independent fragments without silently replacing a parameter."""
        result = {}
        for part in parts:
            if result.keys() & part.keys():
                raise ValueError("Duplicate SQL parameter names")
            result.update(part)
        return result

    def _join_fragments(
        self, parts: list[tuple[str, dict[str, Any]]], separator: str
    ) -> tuple[str, dict[str, Any]]:
        return separator.join(sql for sql, _ in parts), self._merge_bindings(
            *(params for _, params in parts)
        )

    def _field_expr(self, path: list[str], *, prefix: str) -> tuple[str, dict[str, Any]]:
        """Bind field paths; prefixes are internal names supplied by the query builder."""
        params = {f"{prefix}_root": _encode_filter_value(path[0])}
        root = (
            f"ag_catalog.agtype_access_operator(properties, %({prefix}_root)s::ag_catalog.agtype)"
        )
        if len(path) == 1:
            return root, params
        params[f"{prefix}_child"] = _encode_filter_value(path[1])
        # Serialized info strings are preserved by storage, but are not maps.
        return (
            f"(CASE WHEN left(ag_catalog.agtype_out({root})::text, 1) = '{{' "
            f"THEN ag_catalog.agtype_access_operator({root}, %({prefix}_child)s::ag_catalog.agtype) END)",
            params,
        )

    def _text_field_expr(self, path: list[str], *, prefix: str) -> tuple[str, dict[str, Any]]:
        value, params = self._field_expr(path, prefix=prefix)
        return (
            f"(CASE WHEN left(ag_catalog.agtype_out({value})::text, 1) = '\"' "
            f"THEN {value}::text END)",
            params,
        )

    def _build_equal_condition(
        self, path: list[str], value: Any, *, prefix: str
    ) -> tuple[str, dict[str, Any]]:
        # AGE access returns SQL NULL for both missing fields and JSON null.
        # Containment distinguishes them without converting AGE maps to JSON.
        if value is None:
            nested = value
            for key in reversed(path):
                nested = {key: nested}
            return f"(properties @> %({prefix}_value)s::ag_catalog.agtype)", {
                f"{prefix}_value": _encode_filter_value(nested)
            }
        expr, params = self._field_expr(path, prefix=prefix)
        return f"({expr} = %({prefix}_value)s::ag_catalog.agtype)", self._merge_bindings(
            params, {f"{prefix}_value": _encode_filter_value(value)}
        )

    def _build_filter_condition(
        self, field: str, op: str, value: Any, *, prefix: str
    ) -> tuple[str, dict[str, Any]]:
        if not isinstance(field, str) or not re.fullmatch(
            r"(?:info\.)?[A-Za-z_][A-Za-z0-9_]*", field
        ):
            raise ValueError("Invalid filter field")
        if not isinstance(op, str):
            raise ValueError("Invalid filter operator")
        path = field.split(".")
        _encode_filter_value(value)
        operator = _OPERATORS.get(op, op)
        temporal = path[-1].endswith("_at") or path[-1] == "delete_time"
        bound = f"%({prefix}_value)s"
        if operator in {">", ">=", "<", "<="} or (operator == "=" and temporal):
            if temporal:
                try:
                    if not isinstance(value, str):
                        raise ValueError("Time filter must be an ISO date/time string")
                    instant = datetime.fromisoformat(value)
                    if instant.tzinfo is None:
                        instant = instant.replace(tzinfo=timezone.utc)
                except ValueError as exc:
                    raise ValueError("Invalid ISO date/time filter") from exc
                expr, params = self._text_field_expr(path, prefix=prefix)
                return (
                    f"({expr}::timestamptz {operator} {bound}::timestamptz)",
                    self._merge_bindings(params, {f"{prefix}_value": instant.isoformat()}),
                )
            try:
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError("Numeric filter requires a finite number")
            except OverflowError as exc:
                raise ValueError("Numeric filter is too large") from exc
            expr, params = self._field_expr(path, prefix=prefix)
            return (
                f"((CASE WHEN ag_catalog.agtype_out({expr})::text ~ '^[-.0-9]' "
                f"THEN ag_catalog.agtype_out({expr})::text::numeric END) {operator} {bound})",
                self._merge_bindings(params, {f"{prefix}_value": value}),
            )
        if operator == "=":
            return self._build_equal_condition(path, value, prefix=prefix)
        if operator in {"in", "contains", "all"}:
            if operator == "in" and not isinstance(value, list):
                raise ValueError("in requires a list")
            values = value if isinstance(value, list) else [value]
            if operator == "all":
                expr, params = self._field_expr(path, prefix=prefix)
                return f"({expr} @> {bound}::ag_catalog.agtype)", self._merge_bindings(
                    params, {f"{prefix}_value": _encode_filter_value(values)}
                )
            if not values:
                return "FALSE", {}
            array = operator == "contains" or path[-1] in _ARRAY_FIELDS
            parts = []
            for index, item in enumerate(values):
                child = f"{prefix}_item_{index}"
                if array:
                    expr, params = self._field_expr(path, prefix=child)
                    parts.append(
                        (
                            f"{expr} @> %({child}_value)s::ag_catalog.agtype",
                            self._merge_bindings(
                                params, {f"{child}_value": _encode_filter_value([item])}
                            ),
                        )
                    )
                else:
                    parts.append(self._build_equal_condition(path, item, prefix=child))
            sql, params = self._join_fragments(parts, " OR ")
            return f"({sql})", params
        if operator in {"like", "nolike", "starts_with", "ends_with"}:
            if not isinstance(value, str):
                raise ValueError("String filter requires a string")
            escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = ("" if operator == "starts_with" else "%") + escaped
            pattern += "" if operator == "ends_with" else "%"
            expr, params = self._text_field_expr(path, prefix=prefix)
            comparison = "NOT LIKE" if operator == "nolike" else "LIKE"
            return f"({expr} {comparison} {bound})", self._merge_bindings(
                params, {f"{prefix}_value": pattern}
            )
        raise ValueError(f"Unsupported filter operator: {op}")

    def _build_metadata_conditions(
        self, filters: list[dict[str, Any]], *, prefix: str = "memos_metadata"
    ) -> tuple[str, dict[str, Any]]:
        """Compile the existing field/op/value list as independent AND fragments."""
        if not isinstance(filters, list):
            raise ValueError("filters must be a list")
        parts = []
        for index, item in enumerate(filters):
            if (
                not isinstance(item, dict)
                or not {"field", "value"} <= item.keys()
                or (item.keys() - {"field", "op", "value"})
            ):
                raise ValueError("Invalid metadata filter")
            parts.append(
                self._build_filter_condition(
                    item["field"], item.get("op", "="), item["value"], prefix=f"{prefix}_{index}"
                )
            )
        sql, params = self._join_fragments(parts, " AND ")
        return sql or "TRUE", params

    @staticmethod
    def parse_filter(filter_dict: dict | None = None) -> dict | None:
        """Route business fields to info.*, as in PostgreSQL and PolarDB."""
        if filter_dict is None:
            return None
        if not isinstance(filter_dict, dict):
            raise ValueError("filter must be an object")
        normalized = {}
        for key, value in filter_dict.items():
            if not isinstance(key, str):
                raise ValueError("Invalid filter field")
            if key in ("and", "or"):
                if not isinstance(value, list) or not value:
                    raise ValueError("and/or requires a nonempty list")
                normalized[key] = [OpenGaussGraphDB.parse_filter(item) for item in value]
            else:
                field = key if key in _ROOT_FIELDS or key.startswith("info.") else f"info.{key}"
                normalized[field] = value
        return normalized

    def _build_single_filter_condition(
        self, condition_dict: dict[str, Any], *, prefix: str
    ) -> tuple[str, dict[str, Any]]:
        """Assign each field/operator occurrence its own binding namespace."""
        parts = []
        for index, (field, value) in enumerate(condition_dict.items()):
            child = f"{prefix}_{index}"
            if isinstance(value, dict):
                if not value:
                    raise ValueError("Filter operators cannot be empty")
                parts.extend(
                    self._build_filter_condition(field, op, val, prefix=f"{child}_{op_index}")
                    for op_index, (op, val) in enumerate(value.items())
                )
            else:
                op = "all" if field in _ARRAY_FIELDS else "="
                parts.append(self._build_filter_condition(field, op, value, prefix=child))
        return self._join_fragments(parts, " AND ")

    def _build_filter_where_clause(
        self, filter_dict: dict | None, *, prefix: str = "memos_filter", nested: bool = False
    ) -> tuple[str, dict[str, Any]]:
        """Build named predicates without sharing a mutable parameter accumulator."""
        condition = self.parse_filter(filter_dict)
        if nested and not condition:
            raise ValueError("Nested filter conditions cannot be empty")
        if condition is None:
            return "TRUE", {}
        parts = []
        for index, (field, value) in enumerate(condition.items()):
            child_prefix = f"{prefix}_{index}"
            if field in ("and", "or"):
                children = [
                    self._build_filter_where_clause(
                        child, prefix=f"{child_prefix}_{child_index}", nested=True
                    )
                    for child_index, child in enumerate(value)
                ]
                sql, params = self._join_fragments(children, f" {field.upper()} ")
                parts.append((f"({sql})", params))
            else:
                parts.append(
                    self._build_single_filter_condition({field: value}, prefix=child_prefix)
                )
        sql, params = self._join_fragments(parts, " AND ")
        return f"({sql})" if parts else "TRUE", params
