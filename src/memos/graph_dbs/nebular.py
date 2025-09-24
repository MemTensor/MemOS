import json
import traceback

from contextlib import suppress
from datetime import datetime
from threading import Lock
from typing import TYPE_CHECKING, Any, ClassVar, Literal

import numpy as np

from memos.configs.graph_db import NebulaGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger
from memos.utils import timed


if TYPE_CHECKING:
    from nebulagraph_python import (
        NebulaClient,
    )


logger = get_logger(__name__)


_TRANSIENT_ERR_KEYS = (
    "Session not found",
    "Connection not established",
    "timeout",
    "deadline exceeded",
    "Broken pipe",
    "EOFError",
    "socket closed",
    "connection reset",
    "connection refused",
)


@timed
def _normalize(vec: list[float]) -> list[float]:
    v = np.asarray(vec, dtype=np.float32)
    norm = np.linalg.norm(v)
    return (v / (norm if norm else 1.0)).tolist()


@timed
def _compose_node(item: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    node_id = item["id"]
    memory = item["memory"]
    metadata = item.get("metadata", {})
    return node_id, memory, metadata


@timed
def _escape_str(value: str) -> str:
    out = []
    for ch in value:
        code = ord(ch)
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif code < 0x20 or code in (0x2028, 0x2029):
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    return "".join(out)


@timed
def _format_datetime(value: str | datetime) -> str:
    """Ensure datetime is in ISO 8601 format string."""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


@timed
def _normalize_datetime(val):
    """
    Normalize datetime to ISO 8601 UTC string with +00:00.
    - If val is datetime object -> keep isoformat() (Neo4j)
    - If val is string without timezone -> append +00:00 (Nebula)
    - Otherwise just str()
    """
    if hasattr(val, "isoformat"):
        return val.isoformat()
    if isinstance(val, str) and not val.endswith(("+00:00", "Z", "+08:00")):
        return val + "+08:00"
    return str(val)


class NebulaGraphDB(BaseGraphDB):
    """
    NebulaGraph-based implementation of a graph memory store.
    """

    # ====== shared pool cache & refcount ======
    # These are process-local; in a multi-process model each process will
    # have its own cache.
    _CLIENT_CACHE: ClassVar[dict[str, "NebulaClient"]] = {}
    _CLIENT_REFCOUNT: ClassVar[dict[str, int]] = {}
    _CLIENT_LOCK: ClassVar[Lock] = Lock()
    _CLIENT_INIT_DONE: ClassVar[set[str]] = set()

    @staticmethod
    def _get_hosts_from_cfg(cfg: NebulaGraphDBConfig) -> list[str]:
        hosts = getattr(cfg, "uri", None) or getattr(cfg, "hosts", None)
        if isinstance(hosts, str):
            return [hosts]
        return list(hosts or [])

    @staticmethod
    def _make_client_key(cfg: NebulaGraphDBConfig) -> str:
        hosts = NebulaGraphDB._get_hosts_from_cfg(cfg)
        return "|".join(
            [
                "nebula-sync",
                ",".join(hosts),
                str(getattr(cfg, "user", "")),
                str(getattr(cfg, "use_multi_db", False)),
                str(getattr(cfg, "space", "")),
            ]
        )

    @classmethod
    def _bootstrap_admin(cls, cfg: NebulaGraphDBConfig, client: "NebulaClient") -> "NebulaGraphDB":
        tmp = object.__new__(NebulaGraphDB)
        tmp.config = cfg
        tmp.db_name = cfg.space
        tmp.user_name = getattr(cfg, "user_name", None)
        tmp.embedding_dimension = getattr(cfg, "embedding_dimension", 3072)
        tmp.default_memory_dimension = 3072
        tmp.common_fields = {
            "id",
            "memory",
            "user_name",
            "user_id",
            "session_id",
            "status",
            "key",
            "confidence",
            "tags",
            "created_at",
            "updated_at",
            "memory_type",
            "sources",
            "source",
            "node_type",
            "visibility",
            "usage",
            "background",
        }
        tmp.base_fields = set(tmp.common_fields) - {"usage"}
        tmp.heavy_fields = {"usage"}
        tmp.dim_field = (
            f"embedding_{tmp.embedding_dimension}"
            if str(tmp.embedding_dimension) != str(tmp.default_memory_dimension)
            else "embedding"
        )
        tmp.system_db_name = "system" if getattr(cfg, "use_multi_db", False) else cfg.space
        tmp._client = client
        tmp._owns_client = False
        return tmp

    @classmethod
    def _get_or_create_shared_client(cls, cfg: NebulaGraphDBConfig) -> tuple[str, "NebulaClient"]:
        from nebulagraph_python import (
            ConnectionConfig,
            NebulaClient,
            SessionConfig,
            SessionPoolConfig,
        )

        key = cls._make_client_key(cfg)
        with cls._CLIENT_LOCK:
            client = cls._CLIENT_CACHE.get(key)
            if client is None:
                # Connection setting
                conn_conf: ConnectionConfig | None = getattr(cfg, "conn_config", None)
                if conn_conf is None:
                    conn_conf = ConnectionConfig.from_defults(
                        cls._get_hosts_from_cfg(cfg),
                        getattr(cfg, "ssl_param", None),
                    )

                sess_conf = SessionConfig(graph=getattr(cfg, "space", None))
                pool_conf = SessionPoolConfig(
                    size=int(getattr(cfg, "max_client", 1000)), wait_timeout=5000
                )

                client = NebulaClient(
                    hosts=conn_conf.hosts,
                    username=cfg.user,
                    password=cfg.password,
                    conn_config=conn_conf,
                    session_config=sess_conf,
                    session_pool_config=pool_conf,
                )
                cls._CLIENT_CACHE[key] = client
                cls._CLIENT_REFCOUNT[key] = 0
                logger.info(f"[NebulaGraphDBSync] Created shared NebulaClient key={key}")

            cls._CLIENT_REFCOUNT[key] = cls._CLIENT_REFCOUNT.get(key, 0) + 1

            if getattr(cfg, "auto_create", False) and key not in cls._CLIENT_INIT_DONE:
                try:
                    pass
                finally:
                    pass

        if getattr(cfg, "auto_create", False) and key not in cls._CLIENT_INIT_DONE:
            with cls._CLIENT_LOCK:
                if key not in cls._CLIENT_INIT_DONE:
                    admin = cls._bootstrap_admin(cfg, client)
                    try:
                        admin._ensure_database_exists()
                        admin._create_basic_property_indexes()
                        admin._create_vector_index(
                            dimensions=int(
                                admin.embedding_dimension or admin.default_memory_dimension
                            ),
                        )
                        cls._CLIENT_INIT_DONE.add(key)
                        logger.info("[NebulaGraphDBSync] One-time init done")
                    except Exception:
                        logger.exception("[NebulaGraphDBSync] One-time init failed")

        return key, client

    def _refresh_client(self):
        """
        refresh NebulaClient:
        """
        old_key = getattr(self, "_client_key", None)
        if not old_key:
            return

        cls = self.__class__
        with cls._CLIENT_LOCK:
            try:
                if old_key in cls._CLIENT_CACHE:
                    try:
                        cls._CLIENT_CACHE[old_key].close()
                    except Exception as e:
                        logger.warning(f"[refresh_client] close old client error: {e}")
                    finally:
                        cls._CLIENT_CACHE.pop(old_key, None)
            finally:
                cls._CLIENT_REFCOUNT[old_key] = 0

            new_key, new_client = cls._get_or_create_shared_client(self.config)
            self._client_key = new_key
            self._client = new_client
            logger.info(f"[NebulaGraphDBSync] client refreshed: {old_key} -> {new_key}")

    @classmethod
    def _release_shared_client(cls, key: str):
        with cls._CLIENT_LOCK:
            if key not in cls._CLIENT_CACHE:
                return
            cls._CLIENT_REFCOUNT[key] = max(0, cls._CLIENT_REFCOUNT.get(key, 0) - 1)
            if cls._CLIENT_REFCOUNT[key] == 0:
                try:
                    cls._CLIENT_CACHE[key].close()
                except Exception as e:
                    logger.warning(f"[NebulaGraphDBSync] Error closing client: {e}")
                finally:
                    cls._CLIENT_CACHE.pop(key, None)
                    cls._CLIENT_REFCOUNT.pop(key, None)
                    logger.info(f"[NebulaGraphDBSync] Closed & removed client key={key}")

    @classmethod
    def close_all_shared_clients(cls):
        with cls._CLIENT_LOCK:
            for key, client in list(cls._CLIENT_CACHE.items()):
                try:
                    client.close()
                except Exception as e:
                    logger.warning(f"[NebulaGraphDBSync] Error closing client {key}: {e}")
                finally:
                    logger.info(f"[NebulaGraphDBSync] Closed client key={key}")
            cls._CLIENT_CACHE.clear()
            cls._CLIENT_REFCOUNT.clear()

    @require_python_package(
        import_name="nebulagraph_python",
        install_command="pip install nebulagraph-python>=5.1.1",
        install_link=".....",
    )
    def __init__(self, config: NebulaGraphDBConfig):
        """
        NebulaGraph DB client initialization.

        Required config attributes:
        - hosts: list[str] like ["host1:port", "host2:port"]
        - user: str
        - password: str
        - db_name: str (optional for basic commands)

        Example config:
            {
                "hosts": ["xxx.xx.xx.xxx:xxxx"],
                "user": "root",
                "password": "nebula",
                "space": "test"
            }
        """

        self.config = config
        self.db_name = config.space
        self.user_name = config.user_name
        self.embedding_dimension = config.embedding_dimension
        self.default_memory_dimension = 3072
        self.common_fields = {
            "id",
            "memory",
            "user_name",
            "user_id",
            "session_id",
            "status",
            "key",
            "confidence",
            "tags",
            "created_at",
            "updated_at",
            "memory_type",
            "sources",
            "source",
            "node_type",
            "visibility",
            "usage",
            "background",
        }
        self.base_fields = set(self.common_fields) - {"usage"}
        self.heavy_fields = {"usage"}
        self.dim_field = (
            f"embedding_{self.embedding_dimension}"
            if (str(self.embedding_dimension) != str(self.default_memory_dimension))
            else "embedding"
        )
        self.system_db_name = "system" if config.use_multi_db else config.space

        # ---- NEW: pool acquisition strategy
        # Get or create a shared pool from the class-level cache
        self._client_key, self._client = self._get_or_create_shared_client(config)
        self._owns_client = True

        logger.info("Connected to NebulaGraph successfully.")

    @timed
    def execute_query(self, gql: str, timeout: float = 60.0, auto_set_db: bool = True):
        def _wrap_use_db(q: str) -> str:
            if auto_set_db and self.db_name:
                return f"USE `{self.db_name}`\n{q}"
            return q

        try:
            return self._client.execute(_wrap_use_db(gql), timeout=timeout)

        except Exception as e:
            emsg = str(e)
            if any(k.lower() in emsg.lower() for k in _TRANSIENT_ERR_KEYS):
                logger.warning(f"[execute_query] {e!s} → refreshing session pool and retry once...")
                try:
                    self._refresh_client()
                    return self._client.execute(_wrap_use_db(gql), timeout=timeout)
                except Exception:
                    logger.exception("[execute_query] retry after refresh failed")
                    raise
            raise

    @timed
    def close(self):
        """
        Close the connection resource if this instance owns it.

        - If pool was injected (`shared_pool`), do nothing.
        - If pool was acquired via shared cache, decrement refcount and close
          when the last owner releases it.
        """
        if not self._owns_client:
            logger.debug("[NebulaGraphDBSync] close() skipped (injected client).")
            return
        if self._client_key:
            self._release_shared_client(self._client_key)
            self._client_key = None
            self._client = None

    # NOTE: __del__ is best-effort; do not rely on GC order.
    def __del__(self):
        with suppress(Exception):
            self.close()

    @timed
    def create_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 3072,
        index_name: str = "memory_vector_index",
    ) -> None:
        # Create vector index
        self._create_vector_index(label, vector_property, dimensions, index_name)
        # Create indexes
        self._create_basic_property_indexes()

    @timed
    def remove_oldest_memory(self, memory_type: str, keep_latest: int) -> None:
        """
        Remove all WorkingMemory nodes except the latest `keep_latest` entries.

        Args:
            memory_type (str): Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest (int): Number of latest WorkingMemory entries to keep.
        """
        optional_condition = ""
        if not self.config.use_multi_db and self.config.user_name:
            optional_condition = f"AND n.user_name = '{self.config.user_name}'"

        query = f"""
            MATCH (n@Memory)
            WHERE n.memory_type = '{memory_type}'
            {optional_condition}
            ORDER BY n.updated_at DESC
            OFFSET {keep_latest}
            DETACH DELETE n
        """
        self.execute_query(query)

    @timed
    def add_node(self, id: str, memory: str, metadata: dict[str, Any]) -> None:
        """
        Insert or update a Memory node in NebulaGraph.
        """
        if not self.config.use_multi_db and self.config.user_name:
            metadata["user_name"] = self.config.user_name

        now = datetime.utcnow()
        metadata = metadata.copy()
        metadata.setdefault("created_at", now)
        metadata.setdefault("updated_at", now)
        metadata["node_type"] = metadata.pop("type")
        metadata["id"] = id
        metadata["memory"] = memory

        if "embedding" in metadata and isinstance(metadata["embedding"], list):
            assert len(metadata["embedding"]) == self.embedding_dimension, (
                f"input embedding dimension must equal to {self.embedding_dimension}"
            )
            embedding = metadata.pop("embedding")
            metadata[self.dim_field] = _normalize(embedding)

        metadata = self._metadata_filter(metadata)
        properties = ", ".join(f"{k}: {self._format_value(v, k)}" for k, v in metadata.items())
        gql = f"INSERT OR IGNORE (n@Memory {{{properties}}})"

        try:
            self.execute_query(gql)
            logger.info("insert success")
        except Exception as e:
            logger.error(
                f"Failed to insert vertex {id}: gql: {gql}, {e}\ntrace: {traceback.format_exc()}"
            )

    @timed
    def node_not_exist(self, scope: str) -> int:
        if not self.config.use_multi_db and self.config.user_name:
            filter_clause = f'n.memory_type = "{scope}" AND n.user_name = "{self.config.user_name}"'
        else:
            filter_clause = f'n.memory_type = "{scope}"'
        query = f"""
        MATCH (n@Memory)
        WHERE {filter_clause}
        RETURN n.id AS id
        LIMIT 1
        """

        try:
            result = self.execute_query(query)
            return result.size == 0
        except Exception as e:
            logger.error(f"[node_not_exist] Query failed: {e}", exc_info=True)
            raise

    @timed
    def update_node(self, id: str, fields: dict[str, Any]) -> None:
        """
        Update node fields in Nebular, auto-converting `created_at` and `updated_at` to datetime type if present.
        """
        fields = fields.copy()
        set_clauses = []
        for k, v in fields.items():
            set_clauses.append(f"n.{k} = {self._format_value(v, k)}")

        set_clause_str = ",\n    ".join(set_clauses)

        query = f"""
            MATCH (n@Memory {{id: "{id}"}})
            """

        if not self.config.use_multi_db and self.config.user_name:
            query += f'WHERE n.user_name = "{self.config.user_name}"'

        query += f"\nSET {set_clause_str}"
        self.execute_query(query)

    @timed
    def delete_node(self, id: str) -> None:
        """
        Delete a node from the graph.
        Args:
            id: Node identifier to delete.
        """
        query = f"""
            MATCH (n@Memory {{id: "{id}"}})
            """
        if not self.config.use_multi_db and self.config.user_name:
            user_name = self.config.user_name
            query += f" WHERE n.user_name = {self._format_value(user_name)}"
        query += "\n DETACH DELETE n"
        self.execute_query(query)

    @timed
    def add_edge(self, source_id: str, target_id: str, type: str):
        """
        Create an edge from source node to target node.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type (e.g., 'RELATE_TO', 'PARENT').
        """
        if not source_id or not target_id:
            raise ValueError("[add_edge] source_id and target_id must be provided")

        props = ""
        if not self.config.use_multi_db and self.config.user_name:
            props = f'{{user_name: "{self.config.user_name}"}}'

        insert_stmt = f'''
               MATCH (a@Memory {{id: "{source_id}"}}), (b@Memory {{id: "{target_id}"}})
               INSERT (a) -[e@{type} {props}]-> (b)
           '''
        try:
            self.execute_query(insert_stmt)
        except Exception as e:
            logger.error(f"Failed to insert edge: {e}", exc_info=True)

    @timed
    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Delete a specific edge between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type to remove.
        """
        query = f"""
                   MATCH (a@Memory) -[r@{type}]-> (b@Memory)
                   WHERE a.id = {self._format_value(source_id)} AND b.id = {self._format_value(target_id)}
               """

        if not self.config.use_multi_db and self.config.user_name:
            user_name = self.config.user_name
            query += f" AND a.user_name = {self._format_value(user_name)} AND b.user_name = {self._format_value(user_name)}"

        query += "\nDELETE r"
        self.execute_query(query)

    @timed
    def get_memory_count(self, memory_type: str) -> int:
        query = f"""
                MATCH (n@Memory)
                WHERE n.memory_type = "{memory_type}"
                """
        if not self.config.use_multi_db and self.config.user_name:
            user_name = self.config.user_name
            query += f"\nAND n.user_name = '{user_name}'"
        query += "\nRETURN COUNT(n) AS count"

        try:
            result = self.execute_query(query)
            return result.one_or_none()["count"].value
        except Exception as e:
            logger.error(f"[get_memory_count] Failed: {e}")
            return -1

    @timed
    def count_nodes(self, scope: str) -> int:
        query = f"""
                MATCH (n@Memory)
                WHERE n.memory_type = "{scope}"
                """
        if not self.config.use_multi_db and self.config.user_name:
            user_name = self.config.user_name
            query += f"\nAND n.user_name = '{user_name}'"
        query += "\nRETURN count(n) AS count"

        result = self.execute_query(query)
        return result.one_or_none()["count"].value

    @timed
    def edge_exists(
        self, source_id: str, target_id: str, type: str = "ANY", direction: str = "OUTGOING"
    ) -> bool:
        """
        Check if an edge exists between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type. Use "ANY" to match any relationship type.
            direction: Direction of the edge.
                       Use "OUTGOING" (default), "INCOMING", or "ANY".
        Returns:
            True if the edge exists, otherwise False.
        """
        # Prepare the relationship pattern
        rel = "r" if type == "ANY" else f"r@{type}"

        # Prepare the match pattern with direction
        if direction == "OUTGOING":
            pattern = f"(a@Memory {{id: '{source_id}'}})-[{rel}]->(b@Memory {{id: '{target_id}'}})"
        elif direction == "INCOMING":
            pattern = f"(a@Memory {{id: '{source_id}'}})<-[{rel}]-(b@Memory {{id: '{target_id}'}})"
        elif direction == "ANY":
            pattern = f"(a@Memory {{id: '{source_id}'}})-[{rel}]-(b@Memory {{id: '{target_id}'}})"
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )
        query = f"MATCH {pattern}"
        if not self.config.use_multi_db and self.config.user_name:
            user_name = self.config.user_name
            query += f"\nWHERE a.user_name = '{user_name}' AND b.user_name = '{user_name}'"
        query += "\nRETURN r"

        # Run the Cypher query
        result = self.execute_query(query)
        record = result.one_or_none()
        if record is None:
            return False
        return record.values() is not None

    @timed
    # Graph Query & Reasoning
    def get_node(self, id: str, include_embedding: bool = False) -> dict[str, Any] | None:
        """
        Retrieve a Memory node by its unique ID.

        Args:
            id (str): Node ID (Memory.id)
            include_embedding: with/without embedding

        Returns:
            dict: Node properties as key-value pairs, or None if not found.
        """
        if not self.config.use_multi_db and self.config.user_name:
            filter_clause = f'n.user_name = "{self.config.user_name}" AND n.id = "{id}"'
        else:
            filter_clause = f'n.id = "{id}"'

        return_fields = self._build_return_fields(include_embedding)
        gql = f"""
            MATCH (n@Memory)
            WHERE {filter_clause}
            RETURN {return_fields}
        """

        try:
            result = self.execute_query(gql)
            for row in result:
                props = {k: v.value for k, v in row.items()}
                node = self._parse_node(props)
                return node

        except Exception as e:
            logger.error(
                f"[get_node] Failed to retrieve node '{id}': {e}, trace: {traceback.format_exc()}"
            )
            return None

    @timed
    def get_nodes(
        self, ids: list[str], include_embedding: bool = False, **kwargs
    ) -> list[dict[str, Any]]:
        """
        Retrieve the metadata and memory of a list of nodes.
        Args:
            ids: List of Node identifier.
            include_embedding: with/without embedding
        Returns:
        list[dict]: Parsed node records containing 'id', 'memory', and 'metadata'.

        Notes:
            - Assumes all provided IDs are valid and exist.
            - Returns empty list if input is empty.
        """
        if not ids:
            return []

        where_user = ""
        if not self.config.use_multi_db and self.config.user_name:
            if kwargs.get("cube_name"):
                where_user = f" AND n.user_name = '{kwargs['cube_name']}'"
            else:
                where_user = f" AND n.user_name = '{self.config.user_name}'"

        # Safe formatting of the ID list
        id_list = ",".join(f'"{_id}"' for _id in ids)

        return_fields = self._build_return_fields(include_embedding)
        query = f"""
            MATCH (n@Memory)
            WHERE n.id IN [{id_list}] {where_user}
            RETURN {return_fields}
        """
        nodes = []
        try:
            results = self.execute_query(query)
            for row in results:
                props = {k: v.value for k, v in row.items()}
                nodes.append(self._parse_node(props))
        except Exception as e:
            logger.error(
                f"[get_nodes] Failed to retrieve nodes {ids}: {e}, trace: {traceback.format_exc()}"
            )
        return nodes

    @timed
    def get_edges(self, id: str, type: str = "ANY", direction: str = "ANY") -> list[dict[str, str]]:
        """
        Get edges connected to a node, with optional type and direction filter.

        Args:
            id: Node ID to retrieve edges for.
            type: Relationship type to match, or 'ANY' to match all.
            direction: 'OUTGOING', 'INCOMING', or 'ANY'.

        Returns:
            List of edges:
            [
              {"from": "source_id", "to": "target_id", "type": "RELATE"},
              ...
            ]
        """
        # Build relationship type filter
        rel_type = "" if type == "ANY" else f"@{type}"

        # Build Cypher pattern based on direction
        if direction == "OUTGOING":
            pattern = f"(a@Memory)-[r{rel_type}]->(b@Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "INCOMING":
            pattern = f"(a@Memory)<-[r{rel_type}]-(b@Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "ANY":
            pattern = f"(a@Memory)-[r{rel_type}]-(b@Memory)"
            where_clause = f"a.id = '{id}' OR b.id = '{id}'"
        else:
            raise ValueError("Invalid direction. Must be 'OUTGOING', 'INCOMING', or 'ANY'.")

        if not self.config.use_multi_db and self.config.user_name:
            where_clause += f" AND a.user_name = '{self.config.user_name}' AND b.user_name = '{self.config.user_name}'"

        query = f"""
            MATCH {pattern}
            WHERE {where_clause}
            RETURN a.id AS from_id, b.id AS to_id, type(r) AS edge_type
        """

        result = self.execute_query(query)
        edges = []
        for record in result:
            edges.append(
                {
                    "from": record["from_id"].value,
                    "to": record["to_id"].value,
                    "type": record["edge_type"].value,
                }
            )
        return edges

    @timed
    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.
            include_embedding: with/without embedding

        Returns:
            List of dicts with node details and overlap count.
        """
        if not tags:
            return []

        where_clauses = [
            'n.status = "activated"',
            'NOT (n.node_type = "reasoning")',
            'NOT (n.memory_type = "WorkingMemory")',
        ]
        if exclude_ids:
            where_clauses.append(f"NOT (n.id IN {exclude_ids})")

        if not self.config.use_multi_db and self.config.user_name:
            where_clauses.append(f'n.user_name = "{self.config.user_name}"')

        where_clause = " AND ".join(where_clauses)
        tag_list_literal = "[" + ", ".join(f'"{_escape_str(t)}"' for t in tags) + "]"

        return_fields = self._build_return_fields(include_embedding)
        query = f"""
            LET tag_list = {tag_list_literal}

            MATCH (n@Memory)
            WHERE {where_clause}
            RETURN {return_fields},
               size( filter( n.tags, t -> t IN tag_list ) ) AS overlap_count
            ORDER BY overlap_count DESC
            LIMIT {top_k}
            """

        result = self.execute_query(query)
        neighbors: list[dict[str, Any]] = []
        for r in result:
            props = {k: v.value for k, v in r.items() if k != "overlap_count"}
            parsed = self._parse_node(props)
            parsed["overlap_count"] = r["overlap_count"].value
            neighbors.append(parsed)

        neighbors.sort(key=lambda x: x["overlap_count"], reverse=True)
        neighbors = neighbors[:top_k]
        result = []
        for neighbor in neighbors[:top_k]:
            neighbor.pop("overlap_count")
            result.append(neighbor)
        return result

    @timed
    def get_children_with_embeddings(self, id: str) -> list[dict[str, Any]]:
        where_user = ""

        if not self.config.use_multi_db and self.config.user_name:
            user_name = self.config.user_name
            where_user = f"AND p.user_name = '{user_name}' AND c.user_name = '{user_name}'"

        query = f"""
            MATCH (p@Memory)-[@PARENT]->(c@Memory)
            WHERE p.id = "{id}" {where_user}
            RETURN c.id AS id, c.{self.dim_field} AS {self.dim_field}, c.memory AS memory
        """
        result = self.execute_query(query)
        children = []
        for row in result:
            eid = row["id"].value  # STRING
            emb_v = row[self.dim_field].value  # NVector
            emb = list(emb_v.values) if emb_v else []
            mem = row["memory"].value  # STRING

            children.append({"id": eid, "embedding": emb, "memory": mem})
        return children

    @timed
    def get_subgraph(
        self, center_id: str, depth: int = 2, center_status: str = "activated"
    ) -> dict[str, Any]:
        """
        Retrieve a local subgraph centered at a given node.
        Args:
            center_id: The ID of the center node.
            depth: The hop distance for neighbors.
            center_status: Required status for center node.
        Returns:
            {
                "core_node": {...},
                "neighbors": [...],
                "edges": [...]
            }
        """
        if not 1 <= depth <= 5:
            raise ValueError("depth must be 1-5")

        user_name = self.config.user_name
        gql = f"""
             MATCH (center@Memory)
            WHERE center.id = '{center_id}'
              AND center.status = '{center_status}'
              AND center.user_name = '{user_name}'
            OPTIONAL MATCH p = (center)-[e]->{{1,{depth}}}(neighbor@Memory)
            WHERE neighbor.user_name = '{user_name}'
            RETURN center,
                   collect(DISTINCT neighbor) AS neighbors,
                   collect(EDGES(p)) AS edge_chains
            """

        result = self.execute_query(gql).one_or_none()
        if not result or result.size == 0:
            return {"core_node": None, "neighbors": [], "edges": []}

        core_node_props = result["center"].as_node().get_properties()
        core_node = self._parse_node(core_node_props)
        neighbors = []
        vid_to_id_map = {result["center"].as_node().node_id: core_node["id"]}
        for n in result["neighbors"].value:
            n_node = n.as_node()
            n_props = n_node.get_properties()
            node_parsed = self._parse_node(n_props)
            neighbors.append(node_parsed)
            vid_to_id_map[n_node.node_id] = node_parsed["id"]

        edges = []
        for chain_group in result["edge_chains"].value:
            for edge_wr in chain_group.value:
                edge = edge_wr.value
                edges.append(
                    {
                        "type": edge.get_type(),
                        "source": vid_to_id_map.get(edge.get_src_id()),
                        "target": vid_to_id_map.get(edge.get_dst_id()),
                    }
                )

        return {"core_node": core_node, "neighbors": neighbors, "edges": edges}

    @timed
    # Search / recall operations
    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        **kwargs,
    ) -> list[dict]:
        """
        Retrieve node IDs based on vector similarity.

        Args:
            vector (list[float]): The embedding vector representing query semantics.
            top_k (int): Number of top similar nodes to retrieve.
            scope (str, optional): Memory type filter (e.g., 'WorkingMemory', 'LongTermMemory').
            status (str, optional): Node status filter (e.g., 'active', 'archived').
                            If provided, restricts results to nodes with matching status.
            threshold (float, optional): Minimum similarity score threshold (0 ~ 1).
            search_filter (dict, optional): Additional metadata filters for search results.
                            Keys should match node properties, values are the expected values.

        Returns:
            list[dict]: A list of dicts with 'id' and 'score', ordered by similarity.

        Notes:
            - This method uses Neo4j native vector indexing to search for similar nodes.
            - If scope is provided, it restricts results to nodes with matching memory_type.
            - If 'status' is provided, only nodes with the matching status will be returned.
            - If threshold is provided, only results with score >= threshold will be returned.
            - If search_filter is provided, additional WHERE clauses will be added for metadata filtering.
            - Typical use case: restrict to 'status = activated' to avoid
            matching archived or merged nodes.
        """
        vector = _normalize(vector)
        dim = len(vector)
        vector_str = ",".join(f"{float(x)}" for x in vector)
        gql_vector = f"VECTOR<{dim}, FLOAT>([{vector_str}])"

        where_clauses = []
        if scope:
            where_clauses.append(f'n.memory_type = "{scope}"')
        if status:
            where_clauses.append(f'n.status = "{status}"')
        if not self.config.use_multi_db and self.config.user_name:
            if kwargs.get("cube_name"):
                where_clauses.append(f'n.user_name = "{kwargs["cube_name"]}"')
            else:
                where_clauses.append(f'n.user_name = "{self.config.user_name}"')

                # Add search_filter conditions
                if search_filter:
                    for key, value in search_filter.items():
                        if isinstance(value, str):
                            where_clauses.append(f'n.{key} = "{value}"')
                        else:
                            where_clauses.append(f"n.{key} = {value}")

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        gql = f"""
               MATCH (n@Memory)
               {where_clause}
               ORDER BY inner_product(n.{self.dim_field}, {gql_vector}) DESC
               APPROXIMATE
               LIMIT {top_k}
               OPTIONS {{ METRIC: IP, TYPE: IVF, NPROBE: 8 }}
               RETURN n.id AS id, inner_product(n.{self.dim_field}, {gql_vector}) AS score
           """

        try:
            result = self.execute_query(gql)
        except Exception as e:
            logger.error(f"[search_by_embedding] Query failed: {e}")
            return []

        try:
            output = []
            for row in result:
                values = row.values()
                id_val = values[0].as_string()
                score_val = values[1].as_double()
                score_val = (score_val + 1) / 2  # align to neo4j, Normalized Cosine Score
                if threshold is None or score_val >= threshold:
                    output.append({"id": id_val, "score": score_val})
            return output
        except Exception as e:
            logger.error(f"[search_by_embedding] Result parse failed: {e}")
            return []

    @timed
    def get_by_metadata(self, filters: list[dict[str, Any]]) -> list[str]:
        """
        1. ADD logic: "AND" vs "OR"(support logic combination);
        2. Support nested conditional expressions;

        Retrieve node IDs that match given metadata filters.
        Supports exact match.

        Args:
        filters: List of filter dicts like:
            [
                {"field": "key", "op": "in", "value": ["A", "B"]},
                {"field": "confidence", "op": ">=", "value": 80},
                {"field": "tags", "op": "contains", "value": "AI"},
                ...
            ]

        Returns:
            list[str]: Node IDs whose metadata match the filter conditions. (AND logic).

        Notes:
            - Supports structured querying such as tag/category/importance/time filtering.
            - Can be used for faceted recall or prefiltering before embedding rerank.
        """
        where_clauses = []

        for _i, f in enumerate(filters):
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]

            escaped_value = self._format_value(value)

            # Build WHERE clause
            if op == "=":
                where_clauses.append(f"n.{field} = {escaped_value}")
            elif op == "in":
                where_clauses.append(f"n.{field} IN {escaped_value}")
            elif op == "contains":
                where_clauses.append(f"size(filter(n.{field}, t -> t IN {escaped_value})) > 0")
            elif op == "starts_with":
                where_clauses.append(f"n.{field} STARTS WITH {escaped_value}")
            elif op == "ends_with":
                where_clauses.append(f"n.{field} ENDS WITH {escaped_value}")
            elif op in [">", ">=", "<", "<="]:
                where_clauses.append(f"n.{field} {op} {escaped_value}")
            else:
                raise ValueError(f"Unsupported operator: {op}")

        if not self.config.use_multi_db and self.user_name:
            where_clauses.append(f'n.user_name = "{self.config.user_name}"')

        where_str = " AND ".join(where_clauses)
        gql = f"MATCH (n@Memory) WHERE {where_str} RETURN n.id AS id"
        ids = []
        try:
            result = self.execute_query(gql)
            ids = [record["id"].value for record in result]
        except Exception as e:
            logger.error(f"Failed to get metadata: {e}, gql is {gql}")
        return ids

    @timed
    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Count nodes grouped by any fields.

        Args:
            group_fields (list[str]): Fields to group by, e.g., ["memory_type", "status"]
            where_clause (str, optional): Extra WHERE condition. E.g.,
            "WHERE n.status = 'activated'"
            params (dict, optional): Parameters for WHERE clause.

        Returns:
            list[dict]: e.g., [{ 'memory_type': 'WorkingMemory', 'status': 'active', 'count': 10 }, ...]
        """
        if not group_fields:
            raise ValueError("group_fields cannot be empty")

            # GQL-specific modifications
        if not self.config.use_multi_db and self.config.user_name:
            user_clause = f"n.user_name = '{self.config.user_name}'"
            if where_clause:
                where_clause = where_clause.strip()
                if where_clause.upper().startswith("WHERE"):
                    where_clause += f" AND {user_clause}"
                else:
                    where_clause = f"WHERE {where_clause} AND {user_clause}"
            else:
                where_clause = f"WHERE {user_clause}"

        # Inline parameters if provided
        if params:
            for key, value in params.items():
                # Handle different value types appropriately
                if isinstance(value, str):
                    value = f"'{value}'"
                where_clause = where_clause.replace(f"${key}", str(value))

        return_fields = []
        group_by_fields = []

        for field in group_fields:
            alias = field.replace(".", "_")
            return_fields.append(f"n.{field} AS {alias}")
            group_by_fields.append(alias)
        # Full GQL query construction
        gql = f"""
            MATCH (n)
            {where_clause}
            RETURN {", ".join(return_fields)}, COUNT(n) AS count
            GROUP BY {", ".join(group_by_fields)}
            """
        result = self.execute_query(gql)  # Pure GQL string execution

        output = []
        for record in result:
            group_values = {}
            for i, field in enumerate(group_fields):
                value = record.values()[i].as_string()
                group_values[field] = value
            count_value = record["count"].value
            output.append({**group_values, "count": count_value})

        return output

    @timed
    def clear(self) -> None:
        """
        Clear the entire graph if the target database exists.
        """
        try:
            if not self.config.use_multi_db and self.config.user_name:
                query = f"MATCH (n@Memory) WHERE n.user_name = '{self.config.user_name}' DETACH DELETE n"
            else:
                query = "MATCH (n) DETACH DELETE n"

            self.execute_query(query)
            logger.info("Cleared all nodes from database.")

        except Exception as e:
            logger.error(f"[ERROR] Failed to clear database: {e}")

    @timed
    def export_graph(self, include_embedding: bool = False) -> dict[str, Any]:
        """
        Export all graph nodes and edges in a structured form.
        Args:
        include_embedding (bool): Whether to include the large embedding field.

        Returns:
            {
                "nodes": [ { "id": ..., "memory": ..., "metadata": {...} }, ... ],
                "edges": [ { "source": ..., "target": ..., "type": ... }, ... ]
            }
        """
        node_query = "MATCH (n@Memory)"
        edge_query = "MATCH (a@Memory)-[r]->(b@Memory)"

        if not self.config.use_multi_db and self.config.user_name:
            username = self.config.user_name
            node_query += f' WHERE n.user_name = "{username}"'
            edge_query += f' WHERE r.user_name = "{username}"'

        try:
            if include_embedding:
                return_fields = "n"
            else:
                return_fields = ",".join(
                    [
                        "n.id AS id",
                        "n.memory AS memory",
                        "n.user_name AS user_name",
                        "n.user_id AS user_id",
                        "n.session_id AS session_id",
                        "n.status AS status",
                        "n.key AS key",
                        "n.confidence AS confidence",
                        "n.tags AS tags",
                        "n.created_at AS created_at",
                        "n.updated_at AS updated_at",
                        "n.memory_type AS memory_type",
                        "n.sources AS sources",
                        "n.source AS source",
                        "n.node_type AS node_type",
                        "n.visibility AS visibility",
                        "n.usage AS usage",
                        "n.background AS background",
                    ]
                )

            full_node_query = f"{node_query} RETURN {return_fields}"
            node_result = self.execute_query(full_node_query, timeout=20)
            nodes = []
            logger.debug(f"Debugging: {node_result}")
            for row in node_result:
                if include_embedding:
                    props = row.values()[0].as_node().get_properties()
                else:
                    props = {k: v.value for k, v in row.items()}
                node = self._parse_node(props)
                nodes.append(node)
        except Exception as e:
            raise RuntimeError(f"[EXPORT GRAPH - NODES] Exception: {e}") from e

        try:
            full_edge_query = f"{edge_query} RETURN a.id AS source, b.id AS target, type(r) as edge"
            edge_result = self.execute_query(full_edge_query, timeout=20)
            edges = [
                {
                    "source": row.values()[0].value,
                    "target": row.values()[1].value,
                    "type": row.values()[2].value,
                }
                for row in edge_result
            ]
        except Exception as e:
            raise RuntimeError(f"[EXPORT GRAPH - EDGES] Exception: {e}") from e

        return {"nodes": nodes, "edges": edges}

    @timed
    def import_graph(self, data: dict[str, Any]) -> None:
        """
        Import the entire graph from a serialized dictionary.

        Args:
            data: A dictionary containing all nodes and edges to be loaded.
        """
        for node in data.get("nodes", []):
            try:
                id, memory, metadata = _compose_node(node)

                if not self.config.use_multi_db and self.config.user_name:
                    metadata["user_name"] = self.config.user_name

                metadata = self._prepare_node_metadata(metadata)
                metadata.update({"id": id, "memory": memory})
                properties = ", ".join(
                    f"{k}: {self._format_value(v, k)}" for k, v in metadata.items()
                )
                node_gql = f"INSERT OR IGNORE (n@Memory {{{properties}}})"
                self.execute_query(node_gql)
            except Exception as e:
                logger.error(f"Fail to load node: {node}, error: {e}")

        for edge in data.get("edges", []):
            try:
                source_id, target_id = edge["source"], edge["target"]
                edge_type = edge["type"]
                props = ""
                if not self.config.use_multi_db and self.config.user_name:
                    props = f'{{user_name: "{self.config.user_name}"}}'
                edge_gql = f'''
                   MATCH (a@Memory {{id: "{source_id}"}}), (b@Memory {{id: "{target_id}"}})
                   INSERT OR IGNORE (a) -[e@{edge_type} {props}]-> (b)
               '''
                self.execute_query(edge_gql)
            except Exception as e:
                logger.error(f"Fail to load edge: {edge}, error: {e}")

    @timed
    def get_all_memory_items(self, scope: str, include_embedding: bool = False) -> (list)[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        where_clause = f"WHERE n.memory_type = '{scope}'"

        if not self.config.use_multi_db and self.config.user_name:
            where_clause += f" AND n.user_name = '{self.config.user_name}'"

        return_fields = self._build_return_fields(include_embedding)

        query = f"""
                   MATCH (n@Memory)
                   {where_clause}
                   RETURN {return_fields}
                   LIMIT 100
                   """
        nodes = []
        try:
            results = self.execute_query(query)
            for row in results:
                props = {k: v.value for k, v in row.items()}
                nodes.append(self._parse_node(props))
        except Exception as e:
            logger.error(f"Failed to get memories: {e}")
        return nodes

    @timed
    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False
    ) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """

        where_clause = f'''
            n.memory_type = "{scope}"
            AND n.status = "activated"
        '''
        if not self.config.use_multi_db and self.config.user_name:
            where_clause += f' AND n.user_name = "{self.config.user_name}"'

        return_fields = self._build_return_fields(include_embedding)
        return_fields += f", n.{self.dim_field} AS {self.dim_field}"

        query = f"""
            MATCH (n@Memory)
            WHERE {where_clause}
            OPTIONAL MATCH (n)-[@PARENT]->(c@Memory)
            OPTIONAL MATCH (p@Memory)-[@PARENT]->(n)
            WHERE c IS NULL AND p IS NULL
            RETURN {return_fields}
        """

        candidates = []
        node_ids = set()
        try:
            results = self.execute_query(query)
            for row in results:
                props = {k: v.value for k, v in row.items()}
                node = self._parse_node(props)
                node_id = node["id"]
                if node_id not in node_ids:
                    candidates.append(node)
                    node_ids.add(node_id)
        except Exception as e:
            logger.error(f"Failed : {e}, traceback: {traceback.format_exc()}")
        return candidates

    @timed
    def drop_database(self) -> None:
        """
        Permanently delete the entire database this instance is using.
        WARNING: This operation is destructive and cannot be undone.
        """
        if self.config.use_multi_db:
            self.execute_query(f"DROP GRAPH `{self.db_name}`")
            logger.info(f"Database '`{self.db_name}`' has been dropped.")
        else:
            raise ValueError(
                f"Refusing to drop protected database: `{self.db_name}` in "
                f"Shared Database Multi-Tenant mode"
            )

    @timed
    def detect_conflicts(self) -> list[tuple[str, str]]:
        """
        Detect conflicting nodes based on logical or semantic inconsistency.
        Returns:
            A list of (node_id1, node_id2) tuples that conflict.
        """
        raise NotImplementedError

    @timed
    # Structure Maintenance
    def deduplicate_nodes(self) -> None:
        """
        Deduplicate redundant or semantically similar nodes.
        This typically involves identifying nodes with identical or near-identical memory.
        """
        raise NotImplementedError

    @timed
    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """
        Get the ordered context chain starting from a node, following a relationship type.
        Args:
            id: Starting node ID.
            type: Relationship type to follow (e.g., 'FOLLOWS').
        Returns:
            List of ordered node IDs in the chain.
        """
        raise NotImplementedError

    @timed
    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """
        Get connected node IDs in a specific direction and relationship type.
        Args:
            id: Source node ID.
            type: Relationship type.
            direction: Edge direction to follow ('out', 'in', or 'both').
        Returns:
            List of neighboring node IDs.
        """
        raise NotImplementedError

    @timed
    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """
        Get the path of nodes from source to target within a limited depth.
        Args:
            source_id: Starting node ID.
            target_id: Target node ID.
            max_depth: Maximum path length to traverse.
        Returns:
            Ordered list of node IDs along the path.
        """
        raise NotImplementedError

    @timed
    def merge_nodes(self, id1: str, id2: str) -> str:
        """
        Merge two similar or duplicate nodes into one.
        Args:
            id1: First node ID.
            id2: Second node ID.
        Returns:
            ID of the resulting merged node.
        """
        raise NotImplementedError

    @timed
    def _ensure_database_exists(self):
        graph_type_name = "MemOSBgeM3Type"

        check_type_query = "SHOW GRAPH TYPES"
        result = self.execute_query(check_type_query, auto_set_db=False)

        type_exists = any(row["graph_type"].as_string() == graph_type_name for row in result)

        if not type_exists:
            create_tag = f"""
            CREATE GRAPH TYPE IF NOT EXISTS {graph_type_name} AS {{
                NODE Memory (:MemoryTag {{
                    id STRING,
                    memory STRING,
                    user_name STRING,
                    user_id STRING,
                    session_id STRING,
                    status STRING,
                    key STRING,
                    confidence FLOAT,
                    tags LIST<STRING>,
                    created_at STRING,
                    updated_at STRING,
                    memory_type STRING,
                    sources LIST<STRING>,
                    source STRING,
                    node_type STRING,
                    visibility STRING,
                    usage LIST<STRING>,
                    background STRING,
                    {self.dim_field} VECTOR<{self.embedding_dimension}, FLOAT>,
                    PRIMARY KEY(id)
                }}),
                EDGE RELATE_TO (Memory) -[{{user_name STRING}}]-> (Memory),
                EDGE PARENT (Memory) -[{{user_name STRING}}]-> (Memory),
                EDGE AGGREGATE_TO (Memory) -[{{user_name STRING}}]-> (Memory),
                EDGE MERGED_TO (Memory) -[{{user_name STRING}}]-> (Memory),
                EDGE INFERS (Memory) -[{{user_name STRING}}]-> (Memory),
                EDGE FOLLOWS (Memory) -[{{user_name STRING}}]-> (Memory)
            }}
            """
            self.execute_query(create_tag, auto_set_db=False)
        else:
            describe_query = f"DESCRIBE NODE TYPE Memory OF {graph_type_name};"
            desc_result = self.execute_query(describe_query, auto_set_db=False)

            memory_fields = []
            for row in desc_result:
                field_name = row.values()[0].as_string()
                memory_fields.append(field_name)

            if self.dim_field not in memory_fields:
                alter_query = f"""
                ALTER GRAPH TYPE {graph_type_name} {{
                    ALTER NODE TYPE Memory ADD PROPERTIES {{ {self.dim_field} VECTOR<{self.embedding_dimension}, FLOAT> }}
                }}
                """
                self.execute_query(alter_query, auto_set_db=False)
                logger.info(f"✅ Add new vector search {self.dim_field} to {graph_type_name}")
            else:
                logger.info(f"✅ Graph Type {graph_type_name} already include {self.dim_field}")

        create_graph = f"CREATE GRAPH IF NOT EXISTS `{self.db_name}` TYPED {graph_type_name}"
        try:
            self.execute_query(create_graph, auto_set_db=False)
            logger.info(f"✅ Graph ``{self.db_name}`` is now the working graph.")
        except Exception as e:
            logger.error(f"❌ Failed to create tag: {e} trace: {traceback.format_exc()}")

    @timed
    def _create_vector_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 3072,
        index_name: str = "memory_vector_index",
    ) -> None:
        """
        Create a vector index for the specified property in the label.
        """
        if str(dimensions) == str(self.default_memory_dimension):
            index_name = f"idx_{vector_property}"
            vector_name = vector_property
        else:
            index_name = f"idx_{vector_property}_{dimensions}"
            vector_name = f"{vector_property}_{dimensions}"

        create_vector_index = f"""
                CREATE VECTOR INDEX IF NOT EXISTS {index_name}
                ON NODE {label}::{vector_name}
                OPTIONS {{
                    DIM: {dimensions},
                    METRIC: IP,
                    TYPE: IVF,
                    NLIST: 100,
                    TRAINSIZE: 1000
                }}
                FOR `{self.db_name}`
            """
        self.execute_query(create_vector_index)
        logger.info(
            f"✅ Ensure {label}::{vector_property} vector index {index_name} "
            f"exists (DIM={dimensions})"
        )

    @timed
    def _create_basic_property_indexes(self) -> None:
        """
        Create standard B-tree indexes on status, memory_type, created_at
        and updated_at fields.
        Create standard B-tree indexes on user_name when use Shared Database
        Multi-Tenant Mode.
        """
        fields = ["status", "memory_type", "created_at", "updated_at"]
        if not self.config.use_multi_db:
            fields.append("user_name")

        for field in fields:
            index_name = f"idx_memory_{field}"
            gql = f"""
                CREATE INDEX IF NOT EXISTS {index_name} ON NODE Memory({field})
                FOR `{self.db_name}`
                """
            try:
                self.execute_query(gql)
                logger.info(f"✅ Created index: {index_name} on field {field}")
            except Exception as e:
                logger.error(
                    f"❌ Failed to create index {index_name}: {e}, trace: {traceback.format_exc()}"
                )

    @timed
    def _index_exists(self, index_name: str) -> bool:
        """
        Check if an index with the given name exists.
        """
        """
            Check if a vector index with the given name exists in NebulaGraph.

            Args:
                index_name (str): The name of the index to check.

            Returns:
                bool: True if the index exists, False otherwise.
            """
        query = "SHOW VECTOR INDEXES"
        try:
            result = self.execute_query(query)
            return any(row.values()[0].as_string() == index_name for row in result)
        except Exception as e:
            logger.error(f"[Nebula] Failed to check index existence: {e}")
            return False

    @timed
    def _parse_value(self, value: Any) -> Any:
        """turn Nebula ValueWrapper to Python type"""
        from nebulagraph_python.value_wrapper import ValueWrapper

        if value is None or (hasattr(value, "is_null") and value.is_null()):
            return None
        try:
            prim = value.cast_primitive() if isinstance(value, ValueWrapper) else value
        except Exception as e:
            logger.warning(f"Error when decode Nebula ValueWrapper: {e}")
            prim = value.cast() if isinstance(value, ValueWrapper) else value

        if isinstance(prim, ValueWrapper):
            return self._parse_value(prim)
        if isinstance(prim, list):
            return [self._parse_value(v) for v in prim]
        if type(prim).__name__ == "NVector":
            return list(prim.values)

        return prim  # already a Python primitive

    def _parse_node(self, props: dict[str, Any]) -> dict[str, Any]:
        parsed = {k: self._parse_value(v) for k, v in props.items()}

        for tf in ("created_at", "updated_at"):
            if tf in parsed and parsed[tf] is not None:
                parsed[tf] = _normalize_datetime(parsed[tf])

        node_id = parsed.pop("id")
        memory = parsed.pop("memory", "")
        parsed.pop("user_name", None)
        metadata = parsed
        metadata["type"] = metadata.pop("node_type")

        if self.dim_field in metadata:
            metadata["embedding"] = metadata.pop(self.dim_field)

        return {"id": node_id, "memory": memory, "metadata": metadata}

    @timed
    def _prepare_node_metadata(self, metadata: dict[str, Any]) -> dict[str, Any]:
        """
        Ensure metadata has proper datetime fields and normalized types.

        - Fill `created_at` and `updated_at` if missing (in ISO 8601 format).
        - Convert embedding to list of float if present.
        """
        now = datetime.utcnow().isoformat()
        metadata["node_type"] = metadata.pop("type")

        # Fill timestamps if missing
        metadata.setdefault("created_at", now)
        metadata.setdefault("updated_at", now)

        # Normalize embedding type
        embedding = metadata.get("embedding")
        if embedding and isinstance(embedding, list):
            metadata.pop("embedding")
            metadata[self.dim_field] = _normalize([float(x) for x in embedding])

        return metadata

    @timed
    def _format_value(self, val: Any, key: str = "") -> str:
        from nebulagraph_python.py_data_types import NVector

        # None
        if val is None:
            return "NULL"
        # bool
        if isinstance(val, bool):
            return "true" if val else "false"
        # str
        if isinstance(val, str):
            return f'"{_escape_str(val)}"'
        # num
        elif isinstance(val, (int | float)):
            return str(val)
        # time
        elif isinstance(val, datetime):
            return f'datetime("{val.isoformat()}")'
        # list
        elif isinstance(val, list):
            if key == self.dim_field:
                dim = len(val)
                joined = ",".join(str(float(x)) for x in val)
                return f"VECTOR<{dim}, FLOAT>([{joined}])"
            else:
                return f"[{', '.join(self._format_value(v) for v in val)}]"
        # NVector
        elif isinstance(val, NVector):
            if key == self.dim_field:
                dim = len(val)
                joined = ",".join(str(float(x)) for x in val)
                return f"VECTOR<{dim}, FLOAT>([{joined}])"
            else:
                logger.warning("Invalid NVector")
        # dict
        if isinstance(val, dict):
            j = json.dumps(val, ensure_ascii=False, separators=(",", ":"))
            return f'"{_escape_str(j)}"'
        else:
            return f'"{_escape_str(str(val))}"'

    @timed
    def _metadata_filter(self, metadata: dict[str, Any]) -> dict[str, Any]:
        """
        Filter and validate metadata dictionary against the Memory node schema.
        - Removes keys not in schema.
        - Warns if required fields are missing.
        """

        dim_fields = {self.dim_field}

        allowed_fields = self.common_fields | dim_fields

        missing_fields = allowed_fields - metadata.keys()
        if missing_fields:
            logger.info(f"Metadata missing required fields: {sorted(missing_fields)}")

        filtered_metadata = {k: v for k, v in metadata.items() if k in allowed_fields}

        return filtered_metadata

    def _build_return_fields(self, include_embedding: bool = False) -> str:
        fields = set(self.base_fields)
        if include_embedding:
            fields.add(self.dim_field)
        return ", ".join(f"n.{f} AS {f}" for f in fields)
