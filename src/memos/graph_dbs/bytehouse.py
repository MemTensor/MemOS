import json

from datetime import datetime
from typing import Any, Literal, Tuple

from memos.configs.graph_db import ByteHouseGraphDBConfig
from memos.log import get_logger
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.utils import timed


logger = get_logger(__name__)


def _prepare_node_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Ensure metadata has proper datetime fields and normalized types."""
    now = datetime.now().isoformat()
    metadata.setdefault("created_at", now)
    metadata.setdefault("updated_at", now)

    # Normalize embedding type
    embedding = metadata.get("embedding")
    if embedding and isinstance(embedding, list):
        metadata["embedding"] = [float(x) for x in embedding]

    return metadata


class ByteHouseGraphDB(BaseGraphDB):
    @require_python_package(
        import_name="clickhouse_connect",
        install_command="pip install clickhouse-connect",
        install_link="https://pypi.org/project/clickhouse-connect/",
    )
    def __init__(self, config: ByteHouseGraphDBConfig):
        """Initialize ByteHouse connection."""
        import clickhouse_connect

        self.config = config
        self.db_name = config.db_name
        self.user_name = config.user_name
        self.embedding_dimension = config.embedding_dimension

        logger.info(
            f"Connecting to ByteHouse: {config.host}:{config.port}/{config.db_name}"
        )

        # Create ClickHouse client
        self.client = clickhouse_connect.get_client(
            host=config.host,
            port=config.port,
            username="bytehouse",
            password=config.password,
            secure=True,
            compress=False,
            autogenerate_session_id=False,
        )

        # Initialize schema and tables
        self._init_schema()

    @timed
    def _init_schema(self):
        """Create schema and tables if they don't exist."""
        try:
            # Create schema
            self.client.command(f"CREATE DATABASE IF NOT EXISTS {self.db_name}")

            # Create memories table
            dim = self.embedding_dimension
            self.client.command(
                f"""
                CREATE TABLE IF NOT EXISTS {self.db_name}.memories (
                    user_name String,
                    id String,
                    memory String,
                    properties String,
                    embedding Array(Float32) DEFAULT arrayWithConstant({dim},0),
                    created_at DateTime DEFAULT now(),
                    updated_at DateTime DEFAULT now(),
                    INDEX vec_idx_embedding embedding TYPE HNSW_SQ('DIM={dim}', 'METRIC=COSINE') GRANULARITY 1,
                    INDEX idx_id id TYPE inverted('noop','{{"version":"v2"}}') GRANULARITY 64,
                    INDEX idx_memory memory TYPE inverted('standard','{{"version":"v4"}}') GRANULARITY 64
                ) ENGINE = CnchMergeTree()
                PARTITION BY user_name
                ORDER BY created_at
                UNIQUE KEY id SETTINGS index_granularity = 128, index_granularity_bytes = 0, 
                enable_unique_partial_update = 1, partition_level_unique_keys = 1
            """
            )

            # Create edges table
            self.client.command(
                f"""
                CREATE TABLE IF NOT EXISTS {self.db_name}.edges (
                    user_name String,
                    id String,
                    source_id String,
                    target_id String,
                    edge_type String,
                    created_at DateTime DEFAULT now(),
                    INDEX idx_source_id source_id TYPE inverted('noop','{{"version":"v2"}}') GRANULARITY 1,
                    INDEX idx_target_id target_id TYPE inverted('noop','{{"version":"v2"}}') GRANULARITY 1
                ) ENGINE = CnchMergeTree()
                PARTITION BY user_name
                ORDER BY created_at
                UNIQUE KEY id 
                SETTINGS enable_unique_partial_update = 1, partition_level_unique_keys = 1
            """
            )

            logger.info(f"Schema {self.db_name} initialized successfully")
        except Exception as e:
            logger.error(f"Failed to init schema: {e}")
            raise

    def _parse_row(self, row, include_embedding: bool = False) -> dict[str, Any]:
        """Parse database row to node dict."""
        idx = 0
        result_id = row[idx]
        idx += 1
        result_memory = row[idx] or ""
        idx += 1
        props = json.loads(row[idx] or "{}")
        idx += 1
        props["created_at"] = row[idx].isoformat() if row[idx] else None
        idx += 1
        props["updated_at"] = row[idx].isoformat() if row[idx] else None
        idx += 1

        result = {
            "id": result_id,
            "memory": result_memory,
            "metadata": props,
        }

        if include_embedding and idx < len(row):
            result["metadata"]["embedding"] = row[idx]
        return result

    def _build_user_name_and_kb_ids_condition(
        self, user_name: str, knowledgebase_ids: list[str]
    ) -> str:
        """Build ClickHouse condition for user_name and knowledgebase_ids."""
        if not knowledgebase_ids:
            return f"user_name = '{user_name}'"
        else:
            return f"user_name IN ['{'\',\''.join(knowledgebase_ids)}','{user_name}']"

    def close(self):
        """Close the ClickHouse client connection."""
        if hasattr(self, "client") and self.client:
            self.client.close()
            logger.info("ByteHouse connection closed")

    # =========================================================================
    # Node Management
    # =========================================================================

    @timed
    def add_node(
        self,
        id: str,
        memory: str,
        metadata: dict[str, Any],
        user_name: str | None = None,
    ) -> None:
        """Add a memory node."""
        user_name = user_name or self.user_name
        metadata = _prepare_node_metadata(metadata.copy())

        # Extract embedding
        embedding = metadata.pop("embedding", None)

        # Parse ISO strings to datetime objects
        created_at = datetime.now()
        updated_at = datetime.now()

        # If embedding is empty, fill with zeros
        if not embedding:
            embedding = [0.0 for _ in range(self.embedding_dimension)]

        # Serialize sources if present
        if metadata.get("sources"):
            metadata["sources"] = [
                json.dumps(s) if not isinstance(s, str) else s
                for s in metadata["sources"]
            ]

        try:
            self.client.insert(
                f"{self.db_name}.memories",
                [
                    (
                        id,
                        memory,
                        json.dumps(metadata),
                        embedding,
                        user_name,
                        created_at,
                        updated_at,
                    )
                ],
                column_names=[
                    "id",
                    "memory",
                    "properties",
                    "embedding",
                    "user_name",
                    "created_at",
                    "updated_at",
                ],
                column_type_names=[
                    "String",
                    "String",
                    "String",
                    "Array(Float32)",
                    "String",
                    "DateTime",
                    "DateTime",
                ],
            )
        except Exception as e:
            logger.error(f"Failed to add node: {e}")
            raise

    @timed
    def add_nodes_batch(
        self, nodes: list[dict[str, Any]], user_name: str | None = None
    ) -> None:
        """Batch add memory nodes."""
        for node in nodes:
            self.add_node(
                id=node["id"],
                memory=node["memory"],
                metadata=node.get("metadata", {}),
                user_name=user_name,
            )

    @timed
    def update_node(
        self, id: str, fields: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Update node fields using ByteHouse partial column update."""
        user_name = user_name or self.user_name
        if not fields:
            return

        current = self.get_node(id, user_name=user_name)
        if not current:
            return

        # Merge properties
        props = current.get("metadata", {}).copy()
        embedding = fields.pop("embedding", None)
        memory = fields.pop("memory", current.get("memory", ""))
        props.update(fields)
        props["updated_at"] = datetime.now().isoformat()

        try:
            if embedding:
                self.client.insert(
                    f"{self.db_name}.memories",
                    [
                        (
                            id,
                            memory,
                            json.dumps(props),
                            embedding,
                            user_name,
                            datetime.now(),
                        )
                    ],
                    column_names=[
                        "id",
                        "memory",
                        "properties",
                        "embedding",
                        "user_name",
                        "updated_at",
                    ],
                    column_type_names=[
                        "String",
                        "String",
                        "String",
                        "Array(Float32)",
                        "String",
                        "DateTime",
                    ],
                )

            else:
                self.client.insert(
                    f"{self.db_name}.memories",
                    [(id, memory, json.dumps(props), user_name, datetime.now())],
                    column_names=[
                        "id",
                        "memory",
                        "properties",
                        "user_name",
                        "updated_at",
                    ],
                    column_type_names=[
                        "String",
                        "String",
                        "String",
                        "String",
                        "DateTime",
                    ],
                )

        except Exception as e:
            logger.error(f"Failed to update node: {e}")
            raise

    @timed
    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """Delete a node and its edges using _delete_flag_."""
        user_name = user_name or self.user_name
        try:
            self.client.insert(
                f"{self.db_name}.memories",
                [(id, user_name, 1)],
                column_names=["id", "user_name", "_delete_flag_"],
                column_type_names=["String", "String", "UInt8"],
            )

            # Get related edges unique keys
            edge_result = self.client.query(
                f"""
                SELECT id
                FROM {self.db_name}.edges
                WHERE (source_id = '{id}' OR target_id = '{id}') AND user_name = '{user_name}'
            """,
            ).result_set

            # Delete edges using INSERT with _delete_flag_ = 1 (only unique key needed)
            if edge_result:
                edge_values = [(edge_id, user_name, 1) for (edge_id) in edge_result]
                self.client.insert(
                    f"{self.db_name}.edges",
                    edge_values,
                    column_names=["id", "user_name", "_delete_flag_"],
                    column_type_names=["String", "String", "UInt8"],
                )
        except Exception as e:
            logger.error(f"Failed to delete node: {e}")
            raise

    @timed
    def get_node(
        self, id: str, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any] | None:
        """Get a single node by ID."""
        user_name = user_name or self.user_name
        try:
            cols = "id, memory, properties, created_at, updated_at"
            if include_embedding:
                cols += ", embedding"
            result = self.client.query(
                f"SELECT {cols} FROM {self.db_name}.memories WHERE id = '{id}' AND user_name = '{user_name}'",
            ).result_set
            if not result:
                return None
            return self._parse_row(result[0], include_embedding)
        except Exception as e:
            logger.error(f"Failed to get node: {e}")
            return None

    @timed
    def get_nodes(
        self,
        ids: list[str],
        include_embedding: bool = False,
        user_name: str | None = None,
        **kwargs,
    ) -> list[dict[str, Any]]:
        """Get multiple nodes by IDs."""
        if not ids:
            return []
        user_name = user_name or self.user_name
        try:
            cols = "id, memory, properties, created_at, updated_at"
            if include_embedding:
                cols += ", embedding"
            ids_str = "','".join(ids)
            result = self.client.query(
                f"SELECT {cols} FROM {self.db_name}.memories WHERE id IN ('{ids_str}') AND user_name = '{user_name}'",
            ).result_set
            return [self._parse_row(row, include_embedding) for row in result]
        except Exception as e:
            logger.error(f"Failed to get nodes: {e}")
            return []

    @timed
    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Create an edge between nodes."""
        user_name = user_name or self.user_name
        edge_id = f"{source_id}_{target_id}_{type}"

        try:
            self.client.insert(
                f"{self.db_name}.edges",
                [(edge_id, source_id, target_id, type, user_name, datetime.now())],
                column_names=[
                    "id",
                    "source_id",
                    "target_id",
                    "edge_type",
                    "user_name",
                    "created_at",
                ],
                column_type_names=[
                    "String",
                    "String",
                    "String",
                    "String",
                    "String",
                    "DateTime",
                ],
            )
        except Exception as e:
            logger.error(f"Failed to add edge: {e}")
            raise

    @timed
    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """Delete an edge using _delete_flag_."""
        user_name = user_name or self.user_name
        try:
            edge_id = f"{source_id}_{target_id}_{type}"

            self.client.insert(
                f"{self.db_name}.edges",
                [(user_name, edge_id, 1)],
                column_names=["user_name", "id", "_delete_flag_"],
                column_type_names=["String", "String", "UInt8"],
            )
        except Exception as e:
            logger.error(f"Failed to delete edge: {e}")
            raise

    @timed
    def edge_exists(
        self,
        source_id: str,
        target_id: str,
        type: str = "ANY",
        direction: str = "OUTGOING",
        user_name: str | None = None,
    ) -> bool:
        """
        Check if an edge exists between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type. Use "ANY" to match any relationship type.
            direction: Direction of the edge.
                       Use "OUTGOING" (default), "INCOMING", or "ANY".
            user_name (str, optional): User name for filtering in non-multi-db mode
        Returns:
            True if the edge exists, otherwise False.
        """
        user_name = user_name or self.user_name

        try:
            if direction == "ANY":
                # Check both directions
                if type == "ANY":
                    result = self.client.query(
                        f"""
                        SELECT 1 FROM {self.db_name}.edges
                        WHERE ((source_id = '{source_id}' AND target_id = '{target_id}') OR 
                               (source_id = '{target_id}' AND target_id = '{source_id}')) 
                        AND user_name = '{user_name}'
                        LIMIT 1
                    """,
                    ).result_set
                else:
                    result = self.client.query(
                        f"""
                        SELECT 1 FROM {self.db_name}.edges
                        WHERE ((source_id = '{source_id}' AND target_id = '{target_id}') OR 
                               (source_id = '{target_id}' AND target_id = '{source_id}')) 
                        AND edge_type = '{type}' AND user_name = '{user_name}'
                        LIMIT 1
                    """,
                    ).result_set
            else:
                # Handle INCOMING direction by swapping source and target
                if direction == "INCOMING":
                    source_id, target_id = target_id, source_id

                if type == "ANY":
                    result = self.client.query(
                        f"""
                        SELECT 1 FROM {self.db_name}.edges
                        WHERE source_id = '{source_id}' AND target_id = '{target_id}' 
                        AND user_name = '{user_name}'
                        LIMIT 1
                    """,
                    ).result_set
                else:
                    result = self.client.query(
                        f"""
                        SELECT 1 FROM {self.db_name}.edges
                        WHERE source_id = '{source_id}' AND target_id = '{target_id}' 
                        AND edge_type = '{type}' AND user_name = '{user_name}'
                        LIMIT 1
                    """,
                    ).result_set
            return len(result) > 0
        except Exception as e:
            logger.error(f"Failed to check edge existence: {e}")
            return False

    @timed
    def get_neighbors(
        self,
        id: str,
        type: str,
        direction: Literal["in", "out", "both"] = "out",
        **kwargs,
    ) -> list[str]:
        """Get neighboring node IDs."""
        user_name = kwargs.get("user_name") or self.user_name
        try:
            if direction == "out":
                result = self.client.query(
                    f"""
                    SELECT 
                        target_id 
                    FROM {self.db_name}.edges
                    WHERE source_id = '{id}' AND edge_type = '{type}' AND user_name = '{user_name}'
                """,
                ).result_set
                return [row[0] for row in result]
            elif direction == "in":
                result = self.client.query(
                    f"""
                    SELECT 
                        source_id 
                    FROM {self.db_name}.edges
                    WHERE target_id = '{id}' AND edge_type = '{type}' AND user_name = '{user_name}'
                """,
                ).result_set
                return [row[0] for row in result]
            else:  # both
                result = self.client.query(
                    f"""
                    SELECT 
                        target_id,
                        source_id
                    FROM {self.db_name}.edges
                    WHERE ((source_id = '{id}' AND edge_type = '{type}') 
                    OR (target_id = '{id}' AND edge_type = '{type}')) 
                    AND user_name = '{user_name}'
                """,
                ).result_set
                # Remove duplicates and self loop
                result_set = set()
                for row in result:
                    result_set.add(row[0])
                    result_set.add(row[1])
                result_set.remove(id)
                return list(result_set)

        except Exception as e:
            logger.error(f"Failed to get neighbors: {e}")
            return []

    def get_path(
        self, source_id: str, target_id: str, max_depth: int = 3, **kwargs
    ) -> list[str]:
        """Get the path of nodes from source to target within a limited depth"""
        raise NotImplementedError

    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str = "activated",
        user_name: str | None = None,
    ) -> dict[str, Any]:
        """Get subgraph around center node using iterative BFS."""
        raise NotImplementedError

    def get_context_chain(self, id: str, type: str = "FOLLOWS", **kwargs) -> list[str]:
        """Get ordered chain following relationship type."""
        return self.get_neighbors(id, type, "out", **kwargs)

    @timed
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
        """Search nodes by vector similarity using ByteHouse vector search."""
        user_name = user_name or self.user_name

        if not user_name:
            return []

        # Build WHERE clause and parameters
        conditions = [self._build_user_name_and_kb_ids_condition(user_name, knowledgebase_ids)]

        params = {"vector": vector, "top_k": top_k, "user_name": user_name}

        if scope:
            conditions.append(
                "JSONExtractString(properties, 'memory_type') = {scope:String}"
            )
            params["scope"] = scope

        if status:
            conditions.append(
                "JSONExtractString(properties, 'status') = {status:String}"
            )
            params["status"] = status
        else:
            conditions.append(
                "(JSONExtractString(properties, 'status') IN ['activated', ''])"
            )

        if search_filter:
            for k, v in search_filter.items():
                param_name = f"filter_{k}"
                conditions.append(
                    f"JSONExtractString(properties, '{k}') = {{{param_name}:String}}"
                )
                params[param_name] = str(v)

        where_clause = " AND ".join(conditions)

        try:
            # ByteHouse vector search using cosineDistance with QueryContext
            qc = self.client.create_query_context(
                query=f"""
                SELECT 
                    id, 
                    1 - distance / 2 as score
                FROM 
                    {self.db_name}.memories
                PREWHERE 
                    {where_clause}
                ORDER BY 
                    cosineDistance(embedding, {{vector:Array(Float32)}}) AS distance ASC
                LIMIT 
                    {{top_k:UInt32}}
                SETTINGS enable_new_ann=1
            """,
                parameters=params,
            )
            query_result = self.client.query(context=qc)
            result = query_result.result_set

            results = []
            for row in result:
                score = float(row[1])
                if threshold is None or score >= threshold:
                    results.append({"id": row[0], "score": score})
            return results
        except Exception as e:
            logger.error(f"Failed to search by embedding: {e}")
            return []

    @timed
    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        status: str | None = None,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
    ) -> list[str]:
        """Get node IDs matching metadata filters."""
        user_name = user_name or self.user_name

        conditions = []
        params = {}

        conditions.append(
            self._build_user_name_and_kb_ids_condition(user_name, knowledgebase_ids)
        )

        if status:
            conditions.append(f"JSONExtractString(properties, 'status') = '{status}'")

        where_clause = " AND ".join(conditions)

        try:
            result = self.client.query(
                f"SELECT id FROM {self.db_name}.memories WHERE {where_clause}"
            ).result_set
            return [row[0] for row in result]
        except Exception as e:
            logger.error(f"Failed to get by metadata: {e}")
            return []

    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False, **kwargs
    ) -> list[dict]:
        """Find isolated nodes (no edges)."""
        user_name = kwargs.get("user_name") or self.user_name
        try:
            cols = "m.id, m.memory, m.properties, m.created_at, m.updated_at"
            if include_embedding:
                cols += ", m.embedding"
            result = self.client.query(
                f"""
                SELECT {cols}
                FROM {self.db_name}.memories m
                LEFT JOIN {self.db_name}.edges e1 ON m.id = e1.source_id AND m.user_name = e1.user_name
                LEFT JOIN {self.db_name}.edges e2 ON m.id = e2.target_id AND m.user_name = e2.user_name
                WHERE JSONExtractString(m.properties, 'memory_type') = '{scope}'
                  AND m.user_name = '{user_name}'
                  AND (JSONExtractString(m.properties, 'status') IN ['activated', ''])
                  AND e1.id IS NULL
                  AND e2.id IS NULL
            """,
            ).result_set
            return [self._parse_row(row, include_embedding) for row in result]
        except Exception as e:
            logger.error(f"Failed to get structure optimization candidates: {e}")
            return []

    def deduplicate_nodes(self, **kwargs) -> None:
        """Not implemented - handled at application level."""

    def detect_conflicts(self, **kwargs) -> list[Tuple[str, str]]:
        """Not implemented."""
        return []

    def merge_nodes(self, id1: str, id2: str, **kwargs) -> str:
        """Not implemented."""
        raise NotImplementedError

    def clear(self, user_name: str | None = None) -> None:
        """Clear all data for user using ALTER Drop"""
        user_name = user_name or self.user_name
        if not user_name:
            return

        try:
            self.client.command(
                f"""
                ALTER TABLE {self.db_name}.memories DROP PARTITION '{user_name}'
            """,
            )

            self.client.command(
                f"""
                ALTER TABLE {self.db_name}.edges DROP PARTITION '{user_name}'
            """,
            )

        except Exception as e:
            logger.error(f"Failed to clear data: {e}")
            raise

    def export_graph(self, include_embedding: bool = False, **kwargs) -> dict[str, Any]:
        """Export all data."""
        user_name = kwargs.get("user_name") or self.user_name
        try:
            # Get nodes
            cols = "id, memory, properties, created_at, updated_at"
            if include_embedding:
                cols += ", embedding"
            result = self.client.query(
                f"""
                SELECT {cols} FROM {self.db_name}.memories
                WHERE user_name = '{user_name}'
                ORDER BY created_at DESC
            """,
            ).result_set
            nodes = [self._parse_row(row, include_embedding) for row in result]

            # Get edges
            node_ids = [n["id"] for n in nodes]
            edges = []
            if node_ids:
                node_ids_str = "','".join(node_ids)
                edge_result = self.client.query(
                    f"""
                    SELECT source_id, target_id, edge_type
                    FROM {self.db_name}.edges
                    WHERE (source_id IN ('{node_ids_str}') OR target_id IN ('{node_ids_str}')) AND user_name = '{user_name}'
                """,
                ).result_set
                edges = [
                    {"source": row[0], "target": row[1], "type": row[2]}
                    for row in edge_result
                ]

            return {
                "nodes": nodes,
                "edges": edges,
                "total_nodes": len(nodes),
                "total_edges": len(edges),
            }
        except Exception as e:
            logger.error(f"Failed to export graph: {e}")
            return {"nodes": [], "edges": [], "total_nodes": 0, "total_edges": 0}

    def import_graph(self, data: dict[str, Any]) -> None:
        """Import graph data."""
        try:
            for node in data.get("nodes", []):
                self.add_node(
                    id=node["id"],
                    memory=node.get("memory", ""),
                    metadata=node.get("metadata", {}),
                )

            for edge in data.get("edges", []):
                self.add_edge(
                    source_id=edge["source"],
                    target_id=edge["target"],
                    type=edge["type"],
                )
        except Exception as e:
            logger.error(f"Failed to import graph: {e}")
            raise

    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        status: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Get all memory items of a specific type."""
        user_name = kwargs.get("user_name") or self.user_name

        conditions = [
            f"JSONExtractString(properties, 'memory_type') = '{scope}'",
            f"user_name = '{user_name}'",
        ]

        if status:
            conditions.append(f"JSONExtractString(properties, 'status') = '{status}'")

        if filter:
            for key, value in filter.items():
                conditions.append(f"JSONExtractString(properties, '{key}') = '{value}'")

        where_clause = " AND ".join(conditions)

        try:
            cols = "id, memory, properties, created_at, updated_at"
            if include_embedding:
                cols += ", embedding"
            result = self.client.query(
                f"SELECT {cols} FROM {self.db_name}.memories WHERE {where_clause}",
            ).result_set
            return [self._parse_row(row, include_embedding) for row in result]
        except Exception as e:
            logger.error(f"Failed to get all memory items: {e}")
            return []

    @timed
    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """
        Remove all memories of a given type except the latest `keep_latest` entries.

        Args:
            memory_type: Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest: Number of latest entries to keep.
            user_name: User to filter by.
        """
        user_name = user_name or self.user_name
        try:
            # query count
            count_result = self.client.query(
                f"SELECT COUNT(*) FROM {self.db_name}.memories WHERE JSONExtractString(properties, 'memory_type') = '{memory_type}' AND user_name = '{user_name}'"
            ).result_set
            total_count = count_result[0][0]

            if total_count <= keep_latest:
                return

            # Get IDs of memories to delete (all except the latest keep_latest)
            result = self.client.query(
                f"""
                SELECT id
                FROM {self.db_name}.memories
                WHERE JSONExtractString(properties, 'memory_type') = '{memory_type}'
                AND user_name = '{user_name}'
                ORDER BY created_at ASC
                LIMIT {total_count - keep_latest}
                """,
            ).result_set

            # Delete memories using _delete_flag_
            if result:
                memory_ids = [row[0] for row in result]
                for memory_id in memory_ids:
                    self.client.insert(
                        f"{self.db_name}.memories",
                        [(memory_id, user_name, 1)],
                        column_names=["id", "user_name", "_delete_flag_"],
                        column_type_names=["String", "String", "UInt8"],
                    )

                    # Get related edges unique keys
                    edge_result = self.client.query(
                        f"""
                        SELECT id
                        FROM {self.db_name}.edges
                        WHERE (source_id = '{memory_id}' OR target_id = '{memory_id}') AND user_name = '{user_name}'
                        """,
                    ).result_set

                    # Delete edges using INSERT with _delete_flag_ = 1
                    if edge_result:
                        edge_values = [
                            (edge_id, user_name, 1) for (edge_id,) in edge_result
                        ]
                        self.client.insert(
                            f"{self.db_name}.edges",
                            edge_values,
                            column_names=["id", "user_name", "_delete_flag_"],
                            column_type_names=["String", "String", "UInt8"],
                        )
        except Exception as e:
            logger.error(f"Failed to remove oldest memory: {e}")
            raise

    @timed
    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Count nodes grouped by specified fields.

        Args:
            group_fields: Fields to group by, e.g., ["memory_type", "status"]
            where_clause: Extra WHERE condition
            params: Parameters for WHERE clause
            user_name: User to filter by

        Returns:
            list[dict]: e.g., [{'memory_type': 'WorkingMemory', 'count': 10}, ...]
        """
        user_name = user_name or self.user_name
        try:
            # Build GROUP BY clause
            group_by_clause = ", ".join([f"JSONExtractString(properties, '{field}') as {field}" for field in group_fields])

            # Build WHERE clause
            where_conditions = [f"user_name = '{user_name}'"]
            if where_clause:
                where_conditions.append(where_clause)
            where_clause_full = " WHERE " + " AND ".join(where_conditions) if where_conditions else ""

            # Execute query
            query = f"""
            SELECT 
                {group_by_clause}, 
                COUNT(*) as count
            FROM {self.db_name}.memories
            {where_clause_full}
            GROUP BY {group_by_clause}
            """

            result = self.client.query(query).result_set

            # Parse results
            counts = []
            for row in result:
                count_dict = {}
                for i, field in enumerate(group_fields):
                    count_dict[field] = row[i]
                count_dict['count'] = row[len(group_fields)]
                counts.append(count_dict)

            return counts
        except Exception as e:
            logger.error(f"Failed to get grouped counts: {e}")
            return []
