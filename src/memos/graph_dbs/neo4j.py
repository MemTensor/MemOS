import json
import time

from datetime import datetime
from typing import Any, Literal

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


def _compose_node(item: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    node_id = item["id"]
    memory = item["memory"]
    metadata = item.get("metadata", {})
    return node_id, memory, metadata


def _prepare_node_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """
    Ensure metadata has proper datetime fields and normalized types.

    - Fill `created_at` and `updated_at` if missing (in ISO 8601 format).
    - Convert embedding to list of float if present.
    """
    now = datetime.utcnow().isoformat()

    # Fill timestamps if missing
    metadata.setdefault("created_at", now)
    metadata.setdefault("updated_at", now)

    # Normalize embedding type
    embedding = metadata.get("embedding")
    if embedding and isinstance(embedding, list):
        metadata["embedding"] = [float(x) for x in embedding]

    # serialization
    if metadata["sources"]:
        for idx in range(len(metadata["sources"])):
            metadata["sources"][idx] = json.dumps(metadata["sources"][idx])
    return metadata


def _flatten_info_fields(metadata: dict[str, Any]) -> dict[str, Any]:
    """
    Flatten the 'info' field in metadata to the top level.

    If metadata contains an 'info' field that is a dictionary, all its key-value pairs
    will be moved to the top level of metadata, and the 'info' field will be removed.

    Args:
        metadata: Dictionary that may contain an 'info' field

    Returns:
        Dictionary with 'info' fields flattened to top level

    Example:
        Input:  {"user_id": "xxx", "info": {"A": "value1", "B": "value2"}}
        Output: {"user_id": "xxx", "A": "value1", "B": "value2"}
    """
    if "info" in metadata and isinstance(metadata["info"], dict):
        # Copy info fields to top level
        info_dict = metadata.pop("info")
        for key, value in info_dict.items():
            # Only add if key doesn't already exist at top level (to avoid overwriting)
            if key not in metadata:
                metadata[key] = value
    return metadata


class Neo4jGraphDB(BaseGraphDB):
    """Neo4j-based implementation of a graph memory store."""

    @require_python_package(
        import_name="neo4j",
        install_command="pip install neo4j",
        install_link="https://neo4j.com/docs/python-manual/current/install/",
    )
    def __init__(self, config: Neo4jGraphDBConfig):
        """Neo4j-based implementation of a graph memory store.

        Tenant Modes:
        - use_multi_db = True:
            Dedicated Database Mode (Multi-Database Multi-Tenant).
            Each tenant or logical scope uses a separate Neo4j database.
            `db_name` is the specific tenant database.
            `user_name` can be None (optional).

        - use_multi_db = False:
            Shared Database Multi-Tenant Mode.
            All tenants share a single Neo4j database.
            `db_name` is the shared database.
            `user_name` is required to isolate each tenant's data at the node level.
            All node queries will enforce `user_name` in WHERE conditions and store it in metadata,
            but it will be removed automatically before returning to external consumers.
        """
        from neo4j import GraphDatabase

        self.config = config
        self.driver = GraphDatabase.driver(config.uri, auth=(config.user, config.password))
        self.db_name = config.db_name
        self.user_name = config.user_name

        self.system_db_name = "system" if config.use_multi_db else config.db_name
        if config.auto_create:
            self._ensure_database_exists()

        # Create only if not exists
        self.create_index(dimensions=config.embedding_dimension)

    def create_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 1536,
        index_name: str = "memory_vector_index",
    ) -> None:
        """
        Create the vector index for embedding and datetime indexes for created_at and updated_at fields.
        """
        # Create vector index if it doesn't exist
        if not self._vector_index_exists(index_name):
            self._create_vector_index(label, vector_property, dimensions, index_name)
        # Create indexes
        self._create_basic_property_indexes()

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        user_name = user_name if user_name else self.config.user_name
        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $memory_type
        """
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += "\nAND n.user_name = $user_name"
        query += "\nRETURN COUNT(n) AS count"
        with self.driver.session(database=self.db_name) as session:
            result = session.run(
                query,
                {
                    "memory_type": memory_type,
                    "user_name": user_name,
                },
            )
            return result.single()["count"]

    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        user_name = user_name if user_name else self.config.user_name
        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $scope
        """
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += "\nAND n.user_name = $user_name"
        query += "\nRETURN n LIMIT 1"

        with self.driver.session(database=self.db_name) as session:
            result = session.run(
                query,
                {
                    "scope": scope,
                    "user_name": user_name,
                },
            )
            return result.single() is None

    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """
        Remove all WorkingMemory nodes except the latest `keep_latest` entries.

        Args:
            memory_type (str): Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest (int): Number of latest WorkingMemory entries to keep.
            user_name(str): optional user_name.
        """
        user_name = user_name if user_name else self.config.user_name
        query = f"""
        MATCH (n:Memory)
        WHERE n.memory_type = '{memory_type}'
        """
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += f"\nAND n.user_name = '{user_name}'"
        keep_latest = int(keep_latest)
        query += f"""
            WITH n ORDER BY n.updated_at DESC
            SKIP {keep_latest}
            DETACH DELETE n
        """
        with self.driver.session(database=self.db_name) as session:
            session.run(query)

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        logger.info(f"[add_node] metadata: {metadata},info: {metadata.get('info')}")

        user_name = user_name if user_name else self.config.user_name
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            metadata["user_name"] = user_name

        # Safely process metadata
        metadata = _prepare_node_metadata(metadata)

        # Flatten info fields to top level (for Neo4j flat structure)
        metadata = _flatten_info_fields(metadata)

        # Merge node and set metadata
        created_at = metadata.pop("created_at")
        updated_at = metadata.pop("updated_at")

        query = """
            MERGE (n:Memory {id: $id})
            SET n.memory = $memory,
                n.created_at = datetime($created_at),
                n.updated_at = datetime($updated_at),
                n += $metadata
        """

        # serialization
        if metadata["sources"]:
            for idx in range(len(metadata["sources"])):
                metadata["sources"][idx] = json.dumps(metadata["sources"][idx])

        with self.driver.session(database=self.db_name) as session:
            session.run(
                query,
                id=id,
                memory=memory,
                created_at=created_at,
                updated_at=updated_at,
                metadata=metadata,
            )

    def add_nodes_batch(
        self,
        nodes: list[dict[str, Any]],
        user_name: str | None = None,
    ) -> None:
        """
        Batch add multiple memory nodes to the graph.

        Args:
            nodes: List of node dictionaries, each containing:
                - id: str - Node ID
                - memory: str - Memory content
                - metadata: dict[str, Any] - Node metadata
            user_name: Optional user name (will use config default if not provided)
        """
        if not nodes:
            logger.warning("[add_nodes_batch] Empty nodes list, skipping")
            return

        logger.info(f"[add_nodes_batch] Adding {len(nodes)} nodes")

        # user_name comes from parameter; fallback to config if missing
        effective_user_name = user_name if user_name else self.config.user_name

        # Prepare all nodes
        prepared_nodes = []
        for node_data in nodes:
            try:
                id = node_data["id"]
                memory = node_data["memory"]
                metadata = node_data.get("metadata", {})

                logger.debug(f"[add_nodes_batch] Processing node id: {id}")

                # Set user_name in metadata if needed
                if not self.config.use_multi_db and (self.config.user_name or effective_user_name):
                    metadata["user_name"] = effective_user_name

                # Safely process metadata
                metadata = _prepare_node_metadata(metadata)

                # Flatten info fields to top level (for Neo4j flat structure)
                metadata = _flatten_info_fields(metadata)

                # Merge node and set metadata
                created_at = metadata.pop("created_at")
                updated_at = metadata.pop("updated_at")

                # Serialization for sources
                if metadata.get("sources"):
                    for idx in range(len(metadata["sources"])):
                        metadata["sources"][idx] = json.dumps(metadata["sources"][idx])

                prepared_nodes.append(
                    {
                        "id": id,
                        "memory": memory,
                        "created_at": created_at,
                        "updated_at": updated_at,
                        "metadata": metadata,
                    }
                )
            except Exception as e:
                logger.error(
                    f"[add_nodes_batch] Failed to prepare node {node_data.get('id', 'unknown')}: {e}",
                    exc_info=True,
                )
                # Continue with other nodes
                continue

        if not prepared_nodes:
            logger.warning("[add_nodes_batch] No valid nodes to insert after preparation")
            return

        # Batch insert using Neo4j UNWIND for better performance
        query = """
            UNWIND $nodes AS node
            MERGE (n:Memory {id: node.id})
            SET n.memory = node.memory,
                n.created_at = datetime(node.created_at),
                n.updated_at = datetime(node.updated_at),
                n += node.metadata
        """

        # Prepare nodes data for UNWIND
        nodes_data = [
            {
                "id": node["id"],
                "memory": node["memory"],
                "created_at": node["created_at"],
                "updated_at": node["updated_at"],
                "metadata": node["metadata"],
            }
            for node in prepared_nodes
        ]

        try:
            with self.driver.session(database=self.db_name) as session:
                session.run(query, nodes=nodes_data)
                logger.info(f"[add_nodes_batch] Successfully inserted {len(prepared_nodes)} nodes")
        except Exception as e:
            logger.error(f"[add_nodes_batch] Failed to add nodes: {e}", exc_info=True)
            raise

    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """
        Update node fields in Neo4j, auto-converting `created_at` and `updated_at` to datetime type if present.
        """
        user_name = user_name if user_name else self.config.user_name
        fields = fields.copy()  # Avoid mutating external dict
        set_clauses = []
        params = {"id": id, "fields": fields}

        for time_field in ("created_at", "updated_at"):
            if time_field in fields:
                # Set clause like: n.created_at = datetime($created_at)
                set_clauses.append(f"n.{time_field} = datetime(${time_field})")
                params[time_field] = fields.pop(time_field)

        set_clauses.append("n += $fields")  # Merge remaining fields
        set_clause_str = ",\n    ".join(set_clauses)

        query = """
        MATCH (n:Memory {id: $id})
        """
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += "\nWHERE n.user_name = $user_name"
            params["user_name"] = user_name

        query += f"\nSET {set_clause_str}"

        with self.driver.session(database=self.db_name) as session:
            session.run(query, **params)

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """
        Delete a node from the graph.
        Args:
            id: Node identifier to delete.
        """
        user_name = user_name if user_name else self.config.user_name
        query = "MATCH (n:Memory {id: $id})"

        params = {"id": id}
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += " WHERE n.user_name = $user_name"
            params["user_name"] = user_name

        query += " DETACH DELETE n"

        with self.driver.session(database=self.db_name) as session:
            session.run(query, **params)

    # Edge (Relationship) Management
    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """
        Create an edge from source node to target node.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type (e.g., 'RELATE_TO', 'PARENT').
        """
        user_name = user_name if user_name else self.config.user_name
        query = """
                MATCH (a:Memory {id: $source_id})
                MATCH (b:Memory {id: $target_id})
            """
        params = {"source_id": source_id, "target_id": target_id}
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += """
                    WHERE a.user_name = $user_name AND b.user_name = $user_name
                """
            params["user_name"] = user_name

        query += f"\nMERGE (a)-[:{type}]->(b)"

        with self.driver.session(database=self.db_name) as session:
            session.run(query, params)

    def delete_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        """
        Delete a specific edge between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type to remove.
        """
        user_name = user_name if user_name else self.config.user_name
        query = f"""
            MATCH (a:Memory {{id: $source}})
            -[r:{type}]->
            (b:Memory {{id: $target}})
        """
        params = {"source": source_id, "target": target_id}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += "\nWHERE a.user_name = $user_name AND b.user_name = $user_name"
            params["user_name"] = user_name

        query += "\nDELETE r"

        with self.driver.session(database=self.db_name) as session:
            session.run(query, params)

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
        Returns:
            True if the edge exists, otherwise False.
        """
        user_name = user_name if user_name else self.config.user_name
        # Prepare the relationship pattern
        rel = "r" if type == "ANY" else f"r:{type}"

        # Prepare the match pattern with direction
        if direction == "OUTGOING":
            pattern = f"(a:Memory {{id: $source}})-[{rel}]->(b:Memory {{id: $target}})"
        elif direction == "INCOMING":
            pattern = f"(a:Memory {{id: $source}})<-[{rel}]-(b:Memory {{id: $target}})"
        elif direction == "ANY":
            pattern = f"(a:Memory {{id: $source}})-[{rel}]-(b:Memory {{id: $target}})"
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )
        query = f"MATCH {pattern}"
        params = {"source": source_id, "target": target_id}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            query += "\nWHERE a.user_name = $user_name AND b.user_name = $user_name"
            params["user_name"] = user_name

        query += "\nRETURN r"

        # Run the Cypher query
        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return result.single() is not None

    # Graph Query & Reasoning
    def get_node(self, id: str, **kwargs) -> dict[str, Any] | None:
        """
        Retrieve the metadata and memory of a node.
        Args:
            id: Node identifier.
        Returns:
            Dictionary of node fields, or None if not found.
        """
        user_name = kwargs.get("user_name") if kwargs.get("user_name") else self.config.user_name
        where_user = ""
        params = {"id": id}
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            where_user = " AND n.user_name = $user_name"
            params["user_name"] = user_name

        query = f"MATCH (n:Memory) WHERE n.id = $id {where_user} RETURN n"

        with self.driver.session(database=self.db_name) as session:
            record = session.run(query, params).single()
            return self._parse_node(dict(record["n"])) if record else None

    def get_nodes(self, ids: list[str], **kwargs) -> list[dict[str, Any]]:
        """
        Retrieve the metadata and memory of a list of nodes.
        Args:
            ids: List of Node identifier.
        Returns:
        list[dict]: Parsed node records containing 'id', 'memory', and 'metadata'.

        Notes:
            - Assumes all provided IDs are valid and exist.
            - Returns empty list if input is empty.
        """

        if not ids:
            return []
        user_name = kwargs.get("user_name") if kwargs.get("user_name") else self.config.user_name
        where_user = ""
        params = {"ids": ids}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            where_user = " AND n.user_name = $user_name"
            if kwargs.get("cube_name"):
                params["user_name"] = kwargs["cube_name"]
            else:
                params["user_name"] = user_name

        query = f"MATCH (n:Memory) WHERE n.id IN $ids{where_user} RETURN n"

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, params)
            return [self._parse_node(dict(record["n"])) for record in results]

    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY", user_name: str | None = None
    ) -> list[dict[str, str]]:
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
        user_name = user_name if user_name else self.config.user_name
        # Build relationship type filter
        rel_type = "" if type == "ANY" else f":{type}"

        # Build Cypher pattern based on direction
        if direction == "OUTGOING":
            pattern = f"(a:Memory)-[r{rel_type}]->(b:Memory)"
            where_clause = "a.id = $id"
        elif direction == "INCOMING":
            pattern = f"(a:Memory)<-[r{rel_type}]-(b:Memory)"
            where_clause = "a.id = $id"
        elif direction == "ANY":
            pattern = f"(a:Memory)-[r{rel_type}]-(b:Memory)"
            where_clause = "a.id = $id OR b.id = $id"
        else:
            raise ValueError("Invalid direction. Must be 'OUTGOING', 'INCOMING', or 'ANY'.")

        params = {"id": id}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            where_clause += " AND a.user_name = $user_name AND b.user_name = $user_name"
            params["user_name"] = user_name

        query = f"""
                MATCH {pattern}
                WHERE {where_clause}
                RETURN a.id AS from_id, b.id AS to_id, type(r) AS type
            """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            edges = []
            for record in result:
                edges.append(
                    {"from": record["from_id"], "to": record["to_id"], "type": record["type"]}
                )
            return edges

    def get_neighbors(
        self,
        id: str,
        type: str,
        direction: Literal["in", "out", "both"] = "out",
        user_name: str | None = None,
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

    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.

        Returns:
            List of dicts with node details and overlap count.
        """
        user_name = user_name if user_name else self.config.user_name
        where_user = ""
        params = {
            "tags": tags,
            "exclude_ids": exclude_ids,
            "min_overlap": min_overlap,
            "top_k": top_k,
        }

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            where_user = "AND n.user_name = $user_name"
            params["user_name"] = user_name

        query = f"""
                MATCH (n:Memory)
                WHERE NOT n.id IN $exclude_ids
                  AND n.status = 'activated'
                  AND n.type <> 'reasoning'
                  AND n.memory_type <> 'WorkingMemory'
                  {where_user}
                WITH n, [tag IN n.tags WHERE tag IN $tags] AS overlap_tags
                WHERE size(overlap_tags) >= $min_overlap
                RETURN n, size(overlap_tags) AS overlap_count
                ORDER BY overlap_count DESC
                LIMIT $top_k
            """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return [self._parse_node(dict(record["n"])) for record in result]

    def get_children_with_embeddings(
        self, id: str, user_name: str | None = None
    ) -> list[dict[str, Any]]:
        user_name = user_name if user_name else self.config.user_name
        where_user = ""
        params = {"id": id}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            where_user = "AND p.user_name = $user_name AND c.user_name = $user_name"
            params["user_name"] = user_name

        query = f"""
                MATCH (p:Memory)-[:PARENT]->(c:Memory)
                WHERE p.id = $id {where_user}
                RETURN c.id AS id, c.embedding AS embedding, c.memory AS memory
            """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return [
                {"id": r["id"], "embedding": r["embedding"], "memory": r["memory"]} for r in result
            ]

    def get_path(
        self, source_id: str, target_id: str, max_depth: int = 3, user_name: str | None = None
    ) -> list[str]:
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

    def get_subgraph(
        self,
        center_id: str,
        depth: int = 2,
        center_status: str = "activated",
        user_name: str | None = None,
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
        user_name = user_name if user_name else self.config.user_name
        with self.driver.session(database=self.db_name) as session:
            params = {"center_id": center_id}
            center_user_clause = ""
            neighbor_user_clause = ""

            if not self.config.use_multi_db and (self.config.user_name or user_name):
                center_user_clause = " AND center.user_name = $user_name"
                neighbor_user_clause = " WHERE neighbor.user_name = $user_name"
                params["user_name"] = user_name
            status_clause = f" AND center.status = '{center_status}'" if center_status else ""

            query = f"""
                MATCH (center:Memory)
                WHERE center.id = $center_id{status_clause}{center_user_clause}

                OPTIONAL MATCH (center)-[r*1..{depth}]-(neighbor:Memory)
                {neighbor_user_clause}

                WITH collect(DISTINCT center) AS centers,
                     collect(DISTINCT neighbor) AS neighbors,
                     collect(DISTINCT r) AS rels
                RETURN centers, neighbors, rels
            """
            record = session.run(query, params).single()

            if not record:
                return {"core_node": None, "neighbors": [], "edges": []}

            centers = record["centers"]
            if not centers or centers[0] is None:
                return {"core_node": None, "neighbors": [], "edges": []}

            core_node = self._parse_node(dict(centers[0]))
            neighbors = [self._parse_node(dict(n)) for n in record["neighbors"] if n]
            edges = []
            for rel_chain in record["rels"]:
                for rel in rel_chain:
                    edges.append(
                        {
                            "type": rel.type,
                            "source": rel.start_node["id"],
                            "target": rel.end_node["id"],
                        }
                    )

            return {"core_node": core_node, "neighbors": neighbors, "edges": edges}

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

    # Search / recall operations
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
        """
        Retrieve node IDs based on vector similarity.

        Args:
            vector (list[float]): The embedding vector representing query semantics.
            top_k (int): Number of top similar nodes to retrieve.
            scope (str, optional): Memory type filter (e.g., 'WorkingMemory', 'LongTermMemory').
            status (str, optional): Node status filter (e.g., 'activated', 'archived').
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
        user_name = user_name if user_name else self.config.user_name
        # Build WHERE clause dynamically
        where_clauses = []
        if scope:
            where_clauses.append("node.memory_type = $scope")
        if status:
            where_clauses.append("node.status = $status")

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions, user_name_params = self._build_user_name_and_kb_ids_conditions_cypher(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
            node_alias="node",
        )

        # Add user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add search_filter conditions
        if search_filter:
            for key, _ in search_filter.items():
                param_name = f"filter_{key}"
                where_clauses.append(f"node.{key} = ${param_name}")

        # Build filter conditions using common method
        filter_conditions, filter_params = self._build_filter_conditions_cypher(
            filter=filter,
            param_counter_start=0,
            node_alias="node",
        )
        where_clauses.extend(filter_conditions)

        where_clause = ""
        if where_clauses:
            where_clause = "WHERE " + " AND ".join(where_clauses)

        query = f"""
            CALL db.index.vector.queryNodes('memory_vector_index', $k, $embedding)
            YIELD node, score
            {where_clause}
            RETURN node.id AS id, score
        """

        parameters = {"embedding": vector, "k": top_k}

        if scope:
            parameters["scope"] = scope
        if status:
            parameters["status"] = status

        # Add user_name and knowledgebase_ids parameters using common method
        parameters.update(user_name_params)

        # Handle cube_name override for user_name
        if kwargs.get("cube_name"):
            parameters["user_name"] = kwargs["cube_name"]

        if search_filter:
            for key, value in search_filter.items():
                param_name = f"filter_{key}"
                parameters[param_name] = value

        # Add filter parameters
        if filter_params:
            parameters.update(filter_params)

        logger.info(f"[search_by_embedding] query: {query},parameters: {parameters}")
        print(f"[search_by_embedding] query: {query},parameters: {parameters}")
        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, parameters)
            records = [{"id": record["id"], "score": record["score"]} for record in result]

        # Threshold filtering after retrieval
        if threshold is not None:
            records = [r for r in records if r["score"] >= threshold]

        return records

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        user_name_flag: bool = True,
    ) -> list[str]:
        """
        TODO:
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
        logger.info(
            f"[get_by_metadata] filters: {filters},user_name: {user_name},filter: {filter},knowledgebase_ids: {knowledgebase_ids}"
        )
        print(
            f"[get_by_metadata] filters: {filters},user_name: {user_name},filter: {filter},knowledgebase_ids: {knowledgebase_ids}"
        )
        user_name = user_name if user_name else self.config.user_name
        where_clauses = []
        params = {}

        for i, f in enumerate(filters):
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]
            param_key = f"val{i}"

            # Build WHERE clause
            if op == "=":
                where_clauses.append(f"n.{field} = ${param_key}")
                params[param_key] = value
            elif op == "in":
                where_clauses.append(f"n.{field} IN ${param_key}")
                params[param_key] = value
            elif op == "contains":
                where_clauses.append(f"ANY(x IN ${param_key} WHERE x IN n.{field})")
                params[param_key] = value
            elif op == "starts_with":
                where_clauses.append(f"n.{field} STARTS WITH ${param_key}")
                params[param_key] = value
            elif op == "ends_with":
                where_clauses.append(f"n.{field} ENDS WITH ${param_key}")
                params[param_key] = value
            elif op in [">", ">=", "<", "<="]:
                where_clauses.append(f"n.{field} {op} ${param_key}")
                params[param_key] = value
            else:
                raise ValueError(f"Unsupported operator: {op}")

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = []
        user_name_params = {}
        if user_name_flag:
            user_name_conditions, user_name_params = (
                self._build_user_name_and_kb_ids_conditions_cypher(
                    user_name=user_name,
                    knowledgebase_ids=knowledgebase_ids,
                    default_user_name=self.config.user_name,
                    node_alias="n",
                )
            )
        print(
            f"[get_by_metadata] user_name_conditions: {user_name_conditions},user_name_params: {user_name_params}"
        )

        # Add user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Build filter conditions using common method
        filter_conditions, filter_params = self._build_filter_conditions_cypher(
            filter=filter,
            param_counter_start=len(filters),  # Start from len(filters) to avoid conflicts
            node_alias="n",
        )
        where_clauses.extend(filter_conditions)

        where_str = " AND ".join(where_clauses) if where_clauses else ""
        if where_str:
            query = f"MATCH (n:Memory) WHERE {where_str} RETURN n.id AS id"
        else:
            query = "MATCH (n:Memory) RETURN n.id AS id"

        # Add user_name and knowledgebase_ids parameters using common method
        params.update(user_name_params)

        # Merge filter parameters
        if filter_params:
            params.update(filter_params)
        logger.info(f"[get_by_metadata] query: {query},params: {params}")
        print(f"[get_by_metadata] query: {query},params: {params}")

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return [record["id"] for record in result]

    def get_grouped_counts(
        self,
        group_fields: list[str],
        where_clause: str = "",
        params: dict[str, Any] | None = None,
        user_name: str | None = None,
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
        user_name = user_name if user_name else self.config.user_name
        if not group_fields:
            raise ValueError("group_fields cannot be empty")

        final_params = params.copy() if params else {}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            user_clause = "n.user_name = $user_name"
            final_params["user_name"] = user_name
            if where_clause:
                where_clause = where_clause.strip()
                if where_clause.upper().startswith("WHERE"):
                    where_clause += f" AND {user_clause}"
                else:
                    where_clause = f"WHERE {where_clause} AND {user_clause}"
            else:
                where_clause = f"WHERE {user_clause}"

        # Force RETURN field AS field to guarantee key match
        group_fields_cypher = ", ".join([f"n.{field} AS {field}" for field in group_fields])

        query = f"""
        MATCH (n:Memory)
        {where_clause}
        RETURN {group_fields_cypher}, COUNT(n) AS count
        """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, final_params)
            return [
                {**{field: record[field] for field in group_fields}, "count": record["count"]}
                for record in result
            ]

    # Structure Maintenance
    def deduplicate_nodes(self) -> None:
        """
        Deduplicate redundant or semantically similar nodes.
        This typically involves identifying nodes with identical or near-identical memory.
        """
        raise NotImplementedError

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """
        Detect conflicting nodes based on logical or semantic inconsistency.
        Returns:
            A list of (node_id1, node_id2) tuples that conflict.
        """
        raise NotImplementedError

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

    # Utilities
    def clear(self, user_name: str | None = None) -> None:
        """
        Clear the entire graph if the target database exists.
        """
        user_name = user_name if user_name else self.config.user_name
        try:
            if not self.config.use_multi_db and (self.config.user_name or user_name):
                query = "MATCH (n:Memory) WHERE n.user_name = $user_name DETACH DELETE n"
                params = {"user_name": user_name}
            else:
                query = "MATCH (n) DETACH DELETE n"
                params = {}

            # Step 2: Clear the graph in that database
            with self.driver.session(database=self.db_name) as session:
                session.run(query, params)
                logger.info(f"Cleared all nodes from database '{self.db_name}'.")

        except Exception as e:
            logger.error(f"[ERROR] Failed to clear database '{self.db_name}': {e}")
            raise

    def export_graph(self, **kwargs) -> dict[str, Any]:
        """
        Export all graph nodes and edges in a structured form.

        Returns:
            {
                "nodes": [ { "id": ..., "memory": ..., "metadata": {...} }, ... ],
                "edges": [ { "source": ..., "target": ..., "type": ... }, ... ]
            }
        """
        user_name = kwargs.get("user_name") if kwargs.get("user_name") else self.config.user_name
        with self.driver.session(database=self.db_name) as session:
            # Export nodes
            node_query = "MATCH (n:Memory)"
            edge_query = "MATCH (a:Memory)-[r]->(b:Memory)"
            params = {}

            if not self.config.use_multi_db and (self.config.user_name or user_name):
                node_query += " WHERE n.user_name = $user_name"
                edge_query += " WHERE a.user_name = $user_name AND b.user_name = $user_name"
                params["user_name"] = user_name

            node_result = session.run(f"{node_query} RETURN n", params)
            nodes = [self._parse_node(dict(record["n"])) for record in node_result]

            # Export edges
            edge_result = session.run(
                f"{edge_query} RETURN a.id AS source, b.id AS target, type(r) AS type", params
            )
            edges = [
                {"source": record["source"], "target": record["target"], "type": record["type"]}
                for record in edge_result
            ]

            return {"nodes": nodes, "edges": edges}

    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        """
        Import the entire graph from a serialized dictionary.

        Args:
            data: A dictionary containing all nodes and edges to be loaded.
        """
        user_name = user_name if user_name else self.config.user_name
        with self.driver.session(database=self.db_name) as session:
            for node in data.get("nodes", []):
                id, memory, metadata = _compose_node(node)

                if not self.config.use_multi_db and (self.config.user_name or user_name):
                    metadata["user_name"] = user_name

                metadata = _prepare_node_metadata(metadata)

                # Merge node and set metadata
                created_at = metadata.pop("created_at")
                updated_at = metadata.pop("updated_at")

                session.run(
                    """
                    MERGE (n:Memory {id: $id})
                    SET n.memory = $memory,
                        n.created_at = datetime($created_at),
                        n.updated_at = datetime($updated_at),
                        n += $metadata
                    """,
                    id=id,
                    memory=memory,
                    created_at=created_at,
                    updated_at=updated_at,
                    metadata=metadata,
                )

            for edge in data.get("edges", []):
                session.run(
                    f"""
                    MATCH (a:Memory {{id: $source_id}})
                    MATCH (b:Memory {{id: $target_id}})
                    MERGE (a)-[:{edge["type"]}]->(b)
                    """,
                    source_id=edge["source"],
                    target_id=edge["target"],
                )

    def get_all_memory_items(
        self,
        scope: str,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
        **kwargs,
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            filter (dict, optional): Filter conditions with 'and' or 'or' logic for search results.
                Example: {"and": [{"id": "xxx"}, {"A": "yyy"}]} or {"or": [{"id": "xxx"}, {"A": "yyy"}]}
        Returns:

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        logger.info(
            f"[get_all_memory_items] scope: {scope},filter: {filter},knowledgebase_ids: {knowledgebase_ids}"
        )
        print(
            f"[get_all_memory_items] scope: {scope},filter: {filter},knowledgebase_ids: {knowledgebase_ids}"
        )

        user_name = kwargs.get("user_name") if kwargs.get("user_name") else self.config.user_name
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        where_clauses = ["n.memory_type = $scope"]
        params = {"scope": scope}

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions, user_name_params = self._build_user_name_and_kb_ids_conditions_cypher(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self.config.user_name,
            node_alias="n",
        )

        # Add user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Build filter conditions using common method
        filter_conditions, filter_params = self._build_filter_conditions_cypher(
            filter=filter,
            param_counter_start=0,
            node_alias="n",
        )
        where_clauses.extend(filter_conditions)

        where_clause = "WHERE " + " AND ".join(where_clauses)

        # Add user_name and knowledgebase_ids parameters using common method
        params.update(user_name_params)

        # Add filter parameters
        if filter_params:
            params.update(filter_params)

        query = f"""
            MATCH (n:Memory)
            {where_clause}
            RETURN n
            """
        logger.info(f"[get_all_memory_items] query: {query},params: {params}")
        print(f"[get_all_memory_items] query: {query},params: {params}")

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, params)
            return [self._parse_node(dict(record["n"])) for record in results]

    def get_structure_optimization_candidates(self, scope: str, **kwargs) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """
        user_name = kwargs.get("user_name") if kwargs.get("user_name") else self.config.user_name
        where_clause = """
                WHERE n.memory_type = $scope
                  AND n.status = 'activated'
                  AND NOT ( (n)-[:PARENT]->() OR ()-[:PARENT]->(n) )
            """
        params = {"scope": scope}

        if not self.config.use_multi_db and (self.config.user_name or user_name):
            where_clause += " AND n.user_name = $user_name"
            params["user_name"] = user_name

        query = f"""
            MATCH (n:Memory)
            {where_clause}
            RETURN n.id AS id, n AS node
            """

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, params)
            return [
                self._parse_node({"id": record["id"], **dict(record["node"])}) for record in results
            ]

    def drop_database(self) -> None:
        """
        Permanently delete the entire database this instance is using.
        WARNING: This operation is destructive and cannot be undone.
        """
        if self.config.use_multi_db:
            if self.db_name in ("system", "neo4j"):
                raise ValueError(f"Refusing to drop protected database: {self.db_name}")

            with self.driver.session(database=self.system_db_name) as session:
                session.run(f"DROP DATABASE {self.db_name} IF EXISTS")
                logger.info(f"Database '{self.db_name}' has been dropped.")
        else:
            raise ValueError(
                f"Refusing to drop protected database: {self.db_name} in "
                f"Shared Database Multi-Tenant mode"
            )

    def _ensure_database_exists(self):
        from neo4j.exceptions import ClientError

        try:
            with self.driver.session(database="system") as session:
                session.run(f"CREATE DATABASE `{self.db_name}` IF NOT EXISTS")
        except ClientError as e:
            if "ExistingDatabaseFound" in str(e):
                pass  # Ignore, database already exists
            else:
                raise

        # Wait until the database is available
        for _ in range(10):
            with self.driver.session(database=self.system_db_name) as session:
                result = session.run(
                    "SHOW DATABASES YIELD name, currentStatus RETURN name, currentStatus"
                )
                status_map = {r["name"]: r["currentStatus"] for r in result}
                if self.db_name in status_map and status_map[self.db_name] == "online":
                    return
            time.sleep(1)

        raise RuntimeError(f"Database {self.db_name} not ready after waiting.")

    def _vector_index_exists(self, index_name: str = "memory_vector_index") -> bool:
        query = "SHOW INDEXES YIELD name WHERE name = $name RETURN name"
        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, name=index_name)
            return result.single() is not None

    def _create_vector_index(
        self, label: str, vector_property: str, dimensions: int, index_name: str
    ) -> None:
        """
        Create a vector index for the specified property in the label.
        """
        try:
            query = f"""
                CREATE VECTOR INDEX {index_name} IF NOT EXISTS
                FOR (n:{label}) ON (n.{vector_property})
                OPTIONS {{
                    indexConfig: {{
                        `vector.dimensions`: {dimensions},
                        `vector.similarity_function`: 'cosine'
                    }}
                }}
                """
            with self.driver.session(database=self.db_name) as session:
                session.run(query)
            logger.debug(f"Vector index '{index_name}' ensured.")
        except Exception as e:
            logger.warning(f"Failed to create vector index '{index_name}': {e}")

    def _create_basic_property_indexes(self) -> None:
        """
        Create standard B-tree indexes on memory_type, created_at,
        and updated_at fields.
        Create standard B-tree indexes on user_name when use Shared Database
        Multi-Tenant Mode
        """
        try:
            with self.driver.session(database=self.db_name) as session:
                session.run("""
                    CREATE INDEX memory_type_index IF NOT EXISTS
                    FOR (n:Memory) ON (n.memory_type)
                """)
                logger.debug("Index 'memory_type_index' ensured.")

                session.run("""
                    CREATE INDEX memory_created_at_index IF NOT EXISTS
                    FOR (n:Memory) ON (n.created_at)
                """)
                logger.debug("Index 'memory_created_at_index' ensured.")

                session.run("""
                    CREATE INDEX memory_updated_at_index IF NOT EXISTS
                    FOR (n:Memory) ON (n.updated_at)
                """)
                logger.debug("Index 'memory_updated_at_index' ensured.")

                if not self.config.use_multi_db and self.config.user_name:
                    session.run(
                        """
                        CREATE INDEX memory_user_name_index IF NOT EXISTS
                        FOR (n:Memory) ON (n.user_name)
                        """
                    )
                logger.debug("Index 'memory_user_name_index' ensured.")
        except Exception as e:
            logger.warning(f"Failed to create basic property indexes: {e}")

    def _index_exists(self, index_name: str) -> bool:
        """
        Check if an index with the given name exists.
        """
        query = "SHOW INDEXES"
        with self.driver.session(database=self.db_name) as session:
            result = session.run(query)
            for record in result:
                if record["name"] == index_name:
                    return True
        return False

    def _build_user_name_and_kb_ids_conditions_cypher(
        self,
        user_name: str | None,
        knowledgebase_ids: list[str] | None,
        default_user_name: str | None = None,
        node_alias: str = "node",
    ) -> tuple[list[str], dict[str, Any]]:
        """
        Build user_name and knowledgebase_ids conditions for Cypher queries.

        Args:
            user_name: User name for filtering
            knowledgebase_ids: List of knowledgebase IDs
            default_user_name: Default user name from config if user_name is None
            node_alias: Node alias in Cypher query (default: "node" or "n")

        Returns:
            Tuple of (condition_strings_list, parameters_dict)
        """
        user_name_conditions = []
        params = {}
        effective_user_name = user_name if user_name else default_user_name

        # Only add user_name condition if not using multi-db mode
        if not self.config.use_multi_db and (self.config.user_name or effective_user_name):
            user_name_conditions.append(f"{node_alias}.user_name = $user_name")
            params["user_name"] = effective_user_name

        # Add knowledgebase_ids conditions (checking user_name field in the data)
        if knowledgebase_ids and isinstance(knowledgebase_ids, list) and len(knowledgebase_ids) > 0:
            for idx, kb_id in enumerate(knowledgebase_ids):
                if isinstance(kb_id, str):
                    param_name = f"kb_id_{idx}"
                    user_name_conditions.append(f"{node_alias}.user_name = ${param_name}")
                    params[param_name] = kb_id

        return user_name_conditions, params

    def _build_filter_conditions_cypher(
        self,
        filter: dict | None,
        param_counter_start: int = 0,
        node_alias: str = "node",
    ) -> tuple[list[str], dict[str, Any]]:
        """
        Build filter conditions for Cypher queries.

        Args:
            filter: Filter dictionary with "or" or "and" logic
            param_counter_start: Starting value for parameter counter (to avoid conflicts)
            node_alias: Node alias in Cypher query (default: "node" or "n")

        Returns:
            Tuple of (condition_strings_list, parameters_dict)
        """
        filter_conditions = []
        filter_params = {}

        if not filter:
            return filter_conditions, filter_params

        def build_filter_condition(condition_dict: dict, param_counter: list) -> tuple[str, dict]:
            """Build a WHERE condition for a single filter item.

            Args:
                condition_dict: A dict like {"id": "xxx"} or {"A": "xxx"} or {"created_at": {"gt": "2025-11-01"}}
                param_counter: List to track parameter counter for unique param names

            Returns:
                Tuple of (condition_string, parameters_dict)
            """
            condition_parts = []
            params = {}

            for key, value in condition_dict.items():
                # Check if value is a dict with comparison operators (gt, lt, gte, lte, contains, in, like)
                if isinstance(value, dict):
                    # Handle comparison operators: gt, lt, gte, lte, contains, in, like
                    for op, op_value in value.items():
                        if op in ("gt", "lt", "gte", "lte"):
                            # Map operator to Cypher operator
                            cypher_op_map = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
                            cypher_op = cypher_op_map[op]

                            # All fields are stored as flat properties in Neo4j
                            param_name = f"filter_{key}_{op}_{param_counter[0]}"
                            param_counter[0] += 1
                            params[param_name] = op_value

                            # Check if field is a date field (created_at, updated_at, etc.)
                            # Use datetime() function for date comparisons
                            if key in ("created_at", "updated_at") or key.endswith("_at"):
                                condition_parts.append(
                                    f"datetime({node_alias}.{key}) {cypher_op} datetime(${param_name})"
                                )
                            else:
                                condition_parts.append(
                                    f"{node_alias}.{key} {cypher_op} ${param_name}"
                                )
                        elif op == "contains":
                            # Handle contains operator
                            # For arrays: use IN to check if array contains value (value IN array_field)
                            # For strings: also use IN syntax to check if string value is in array field
                            # Note: In Neo4j, for array fields, we use "value IN field" syntax
                            param_name = f"filter_{key}_{op}_{param_counter[0]}"
                            param_counter[0] += 1
                            params[param_name] = op_value
                            # Use IN syntax: value IN array_field (works for both string and array values)
                            condition_parts.append(f"${param_name} IN {node_alias}.{key}")
                        elif op == "in":
                            # Handle in operator (for checking if field value is in a list)
                            # Supports array format: {"field": {"in": ["value1", "value2"]}}
                            if not isinstance(op_value, list):
                                raise ValueError(
                                    f"in operator only supports array format. "
                                    f"Use {{'{key}': {{'in': ['{op_value}']}}}} instead of {{'{key}': {{'in': '{op_value}'}}}}"
                                )
                            # Build IN clause
                            param_name = f"filter_{key}_{op}_{param_counter[0]}"
                            param_counter[0] += 1
                            params[param_name] = op_value
                            condition_parts.append(f"{node_alias}.{key} IN ${param_name}")
                        elif op == "like":
                            # Handle like operator (for fuzzy matching, similar to SQL LIKE '%value%')
                            # Neo4j uses CONTAINS for string matching
                            param_name = f"filter_{key}_{op}_{param_counter[0]}"
                            param_counter[0] += 1
                            params[param_name] = op_value
                            condition_parts.append(f"{node_alias}.{key} CONTAINS ${param_name}")
                else:
                    # All fields are stored as flat properties in Neo4j (simple equality)
                    param_name = f"filter_{key}_{param_counter[0]}"
                    param_counter[0] += 1
                    params[param_name] = value
                    condition_parts.append(f"{node_alias}.{key} = ${param_name}")

            return " AND ".join(condition_parts), params

        param_counter = [param_counter_start]

        if isinstance(filter, dict):
            if "or" in filter:
                # OR logic: at least one condition must match
                or_conditions = []
                for condition in filter["or"]:
                    if isinstance(condition, dict):
                        condition_str, params = build_filter_condition(condition, param_counter)
                        if condition_str:
                            or_conditions.append(f"({condition_str})")
                            filter_params.update(params)
                if or_conditions:
                    filter_conditions.append(f"({' OR '.join(or_conditions)})")

            elif "and" in filter:
                # AND logic: all conditions must match
                for condition in filter["and"]:
                    if isinstance(condition, dict):
                        condition_str, params = build_filter_condition(condition, param_counter)
                        if condition_str:
                            filter_conditions.append(f"({condition_str})")
                            filter_params.update(params)
            else:
                # Handle simple dict without "and" or "or" (e.g., {"id": "xxx"})
                condition_str, params = build_filter_condition(filter, param_counter)
                if condition_str:
                    filter_conditions.append(condition_str)
                    filter_params.update(params)

        return filter_conditions, filter_params

    def _parse_node(self, node_data: dict[str, Any]) -> dict[str, Any]:
        node = node_data.copy()

        # Convert Neo4j datetime to string
        for time_field in ("created_at", "updated_at"):
            if time_field in node and hasattr(node[time_field], "isoformat"):
                node[time_field] = node[time_field].isoformat()
        node.pop("user_name", None)

        # serialization
        if node["sources"]:
            for idx in range(len(node["sources"])):
                if not (
                    isinstance(node["sources"][idx], str)
                    and node["sources"][idx][0] == "{"
                    and node["sources"][idx][0] == "}"
                ):
                    break
                node["sources"][idx] = json.loads(node["sources"][idx])
        return {"id": node.pop("id"), "memory": node.pop("memory", ""), "metadata": node}

    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str],
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """
        Delete nodes by memory_ids, file_ids, or filter.

        Args:
            writable_cube_ids (list[str]): List of cube IDs (user_name) to filter nodes. Required parameter.
            memory_ids (list[str], optional): List of memory node IDs to delete.
            file_ids (list[str], optional): List of file node IDs to delete.
            filter (dict, optional): Filter dictionary to query matching nodes for deletion.

        Returns:
            int: Number of nodes deleted.
        """
        logger.info(
            f"[delete_node_by_prams] memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}, writable_cube_ids: {writable_cube_ids}"
        )
        print(
            f"[delete_node_by_prams] memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}, writable_cube_ids: {writable_cube_ids}"
        )

        # Validate writable_cube_ids
        if not writable_cube_ids or len(writable_cube_ids) == 0:
            raise ValueError("writable_cube_ids is required and cannot be empty")

        # Build WHERE conditions separately for memory_ids and file_ids
        where_clauses = []
        params = {}

        # Build user_name condition from writable_cube_ids (OR relationship - match any cube_id)
        user_name_conditions = []
        for idx, cube_id in enumerate(writable_cube_ids):
            param_name = f"cube_id_{idx}"
            user_name_conditions.append(f"n.user_name = ${param_name}")
            params[param_name] = cube_id

        # Handle memory_ids: query n.id
        if memory_ids and len(memory_ids) > 0:
            where_clauses.append("n.id IN $memory_ids")
            params["memory_ids"] = memory_ids

        # Handle file_ids: query n.file_ids field
        # All file_ids must be present in the array field (AND relationship)
        if file_ids and len(file_ids) > 0:
            file_id_and_conditions = []
            for idx, file_id in enumerate(file_ids):
                param_name = f"file_id_{idx}"
                params[param_name] = file_id
                # Check if this file_id is in the file_ids array field
                file_id_and_conditions.append(f"${param_name} IN n.file_ids")
            if file_id_and_conditions:
                # Use AND to require all file_ids to be present
                where_clauses.append(f"({' OR '.join(file_id_and_conditions)})")

        # Query nodes by filter if provided
        filter_ids = []
        if filter:
            # Use get_by_metadata with empty filters list and filter
            filter_ids = self.get_by_metadata(
                filters=[],
                user_name=None,
                filter=filter,
                knowledgebase_ids=writable_cube_ids,
            )

        # If filter returned IDs, add condition for them
        if filter_ids:
            where_clauses.append("n.id IN $filter_ids")
            params["filter_ids"] = filter_ids

        # If no conditions (except user_name), return 0
        if not where_clauses:
            logger.warning(
                "[delete_node_by_prams] No nodes to delete (no memory_ids, file_ids, or filter provided)"
            )
            return 0

        # Build WHERE clause
        # First, combine memory_ids, file_ids, and filter conditions with OR (any condition can match)
        data_conditions = " OR ".join([f"({clause})" for clause in where_clauses])

        # Then, combine with user_name condition using AND (must match user_name AND one of the data conditions)
        user_name_where = " OR ".join(user_name_conditions)
        ids_where = f"({user_name_where}) AND ({data_conditions})"

        logger.info(
            f"[delete_node_by_prams] Deleting nodes - memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}"
        )
        print(
            f"[delete_node_by_prams] Deleting nodes - memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}"
        )

        # First count matching nodes to get accurate count
        count_query = f"MATCH (n:Memory) WHERE {ids_where} RETURN count(n) AS node_count"
        logger.info(f"[delete_node_by_prams] count_query: {count_query}")
        print(f"[delete_node_by_prams] count_query: {count_query}")

        # Then delete nodes
        delete_query = f"MATCH (n:Memory) WHERE {ids_where} DETACH DELETE n"
        logger.info(f"[delete_node_by_prams] delete_query: {delete_query}")
        print(f"[delete_node_by_prams] delete_query: {delete_query}")
        print(f"[delete_node_by_prams] params: {params}")

        deleted_count = 0
        try:
            with self.driver.session(database=self.db_name) as session:
                # Count nodes before deletion
                count_result = session.run(count_query, **params)
                count_record = count_result.single()
                expected_count = 0
                if count_record:
                    expected_count = count_record["node_count"] or 0

                # Delete nodes
                session.run(delete_query, **params)
                # Use the count from before deletion as the actual deleted count
                deleted_count = expected_count

        except Exception as e:
            logger.error(f"[delete_node_by_prams] Failed to delete nodes: {e}", exc_info=True)
            raise

        logger.info(f"[delete_node_by_prams] Successfully deleted {deleted_count} nodes")
        return deleted_count
