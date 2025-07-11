import time

from datetime import datetime
from typing import Any, Literal

from neo4j import GraphDatabase

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


def _parse_node(node_data: dict[str, Any]) -> dict[str, Any]:
    node = node_data.copy()

    # Convert Neo4j datetime to string
    for time_field in ("created_at", "updated_at"):
        if time_field in node and hasattr(node[time_field], "isoformat"):
            node[time_field] = node[time_field].isoformat()

    return {"id": node.pop("id"), "memory": node.pop("memory", ""), "metadata": node}


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

    return metadata


class Neo4jGraphDB(BaseGraphDB):
    """Neo4j-based implementation of a graph memory store."""

    def __init__(self, config: Neo4jGraphDBConfig):
        self.config = config
        self.driver = GraphDatabase.driver(config.uri, auth=(config.user, config.password))
        self.db_name = config.db_name

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

    def get_memory_count(self, memory_type: str) -> int:
        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $memory_type
        RETURN COUNT(n) AS count
        """
        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, memory_type=memory_type)
            return result.single()["count"]

    def count_nodes(self, scope: str) -> int:
        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $scope
        RETURN count(n) AS count
        """
        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, {"scope": scope}).single()
            return result["count"]

    def remove_oldest_memory(self, memory_type: str, keep_latest: int) -> None:
        """
        Remove all WorkingMemory nodes except the latest `keep_latest` entries.

        Args:
            memory_type (str): Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest (int): Number of latest WorkingMemory entries to keep.
        """
        query = f"""
        MATCH (n:Memory)
        WHERE n.memory_type = '{memory_type}'
        WITH n ORDER BY n.updated_at DESC
        SKIP {keep_latest}
        DETACH DELETE n
        """
        with self.driver.session(database=self.db_name) as session:
            session.run(query)

    def add_node(self, id: str, memory: str, metadata: dict[str, Any]) -> None:
        # Safely process metadata
        metadata = _prepare_node_metadata(metadata)

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
        with self.driver.session(database=self.db_name) as session:
            session.run(
                query,
                id=id,
                memory=memory,
                created_at=created_at,
                updated_at=updated_at,
                metadata=metadata,
            )

    def update_node(self, id: str, fields: dict[str, Any]) -> None:
        """
        Update node fields in Neo4j, auto-converting `created_at` and `updated_at` to datetime type if present.
        """
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

        query = f"""
        MATCH (n:Memory {{id: $id}})
        SET {set_clause_str}
        """

        with self.driver.session(database=self.db_name) as session:
            session.run(query, **params)

    def delete_node(self, id: str) -> None:
        """
        Delete a node from the graph.
        Args:
            id: Node identifier to delete.
        """
        with self.driver.session(database=self.db_name) as session:
            session.run("MATCH (n:Memory {id: $id}) DETACH DELETE n", id=id)

    # Edge (Relationship) Management
    def add_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Create an edge from source node to target node.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type (e.g., 'RELATE_TO', 'PARENT').
        """
        with self.driver.session(database=self.db_name) as session:
            session.run(
                f"""
                MATCH (a:Memory {{id: $source_id}})
                MATCH (b:Memory {{id: $target_id}})
                MERGE (a)-[:{type}]->(b)
                """,
                {"source_id": source_id, "target_id": target_id},
            )

    def delete_edge(self, source_id: str, target_id: str, type: str) -> None:
        """
        Delete a specific edge between two nodes.
        Args:
            source_id: ID of the source node.
            target_id: ID of the target node.
            type: Relationship type to remove.
        """
        with self.driver.session(database=self.db_name) as session:
            session.run(
                f"MATCH (a:Memory {{id: $source}})-[r:{type}]->(b:Memory {{id: $target}})\nDELETE r",
                source=source_id,
                target=target_id,
            )

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

        # Run the Cypher query
        with self.driver.session(database=self.db_name) as session:
            result = session.run(
                f"MATCH {pattern} RETURN r",
                source=source_id,
                target=target_id,
            )
            return result.single() is not None

    # Graph Query & Reasoning
    def get_node(self, id: str) -> dict[str, Any] | None:
        """
        Retrieve the metadata and memory of a node.
        Args:
            id: Node identifier.
        Returns:
            Dictionary of node fields, or None if not found.
        """
        with self.driver.session(database=self.db_name) as session:
            result = session.run("MATCH (n:Memory {id: $id}) RETURN n", id=id)
            record = result.single()
            return _parse_node(dict(record["n"])) if record else None

    def get_nodes(self, ids: list[str]) -> list[dict[str, Any]]:
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

        query = "MATCH (n:Memory) WHERE n.id IN $ids RETURN n"
        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, {"ids": ids})
            return [_parse_node(dict(record["n"])) for record in results]

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

        query = f"""
        MATCH {pattern}
        WHERE {where_clause}
        RETURN a.id AS from_id, b.id AS to_id, type(r) AS type
        """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, id=id)
            edges = []
            for record in result:
                edges.append(
                    {"from": record["from_id"], "to": record["to_id"], "type": record["type"]}
                )
            return edges

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

    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
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
        query = """
            MATCH (n:Memory)
            WHERE NOT n.id IN $exclude_ids
            AND n.status = 'activated'
            AND n.type <> 'reasoning'
            AND n.memory_type <> 'WorkingMemory'
            WITH n, [tag IN n.tags WHERE tag IN $tags] AS overlap_tags
            WHERE size(overlap_tags) >= $min_overlap
            RETURN n, size(overlap_tags) AS overlap_count
            ORDER BY overlap_count DESC
            LIMIT $top_k
        """

        params = {
            "tags": tags,
            "exclude_ids": exclude_ids,
            "min_overlap": min_overlap,
            "top_k": top_k,
        }

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return [_parse_node(dict(record["n"])) for record in result]

    def get_children_with_embeddings(self, id: str) -> list[str]:
        query = """
        MATCH (p:Memory)-[:PARENT]->(c:Memory)
        WHERE p.id = $id
        RETURN c.id AS id, c.embedding AS embedding, c.memory AS memory
        """
        with self.driver.session(database=self.db_name) as session:
            return list(session.run(query, id=id))

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
        with self.driver.session(database=self.db_name) as session:
            status_clause = f", status: '{center_status}'" if center_status else ""
            query = f"""
            MATCH (center:Memory {{id: $center_id{status_clause}}})
            OPTIONAL MATCH (center)-[r*1..{depth}]-(neighbor:Memory)
            WITH collect(DISTINCT center) AS centers,
                 collect(DISTINCT neighbor) AS neighbors,
                 collect(DISTINCT r) AS rels
            RETURN centers, neighbors, rels
            """
            record = session.run(query, {"center_id": center_id}).single()

            if not record:
                return {"core_node": None, "neighbors": [], "edges": []}

            centers = record["centers"]
            if not centers or centers[0] is None:
                return {"core_node": None, "neighbors": [], "edges": []}

            core_node = _parse_node(dict(centers[0]))
            neighbors = [_parse_node(dict(n)) for n in record["neighbors"] if n]
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

        Returns:
            list[dict]: A list of dicts with 'id' and 'score', ordered by similarity.

        Notes:
            - This method uses Neo4j native vector indexing to search for similar nodes.
            - If scope is provided, it restricts results to nodes with matching memory_type.
            - If 'status' is provided, only nodes with the matching status will be returned.
            - If threshold is provided, only results with score >= threshold will be returned.
            - Typical use case: restrict to 'status = activated' to avoid
            matching archived or merged nodes.
        """
        # Build WHERE clause dynamically
        where_clauses = []
        if scope:
            where_clauses.append("node.memory_type = $scope")
        if status:
            where_clauses.append("node.status = $status")

        where_clause = ""
        if where_clauses:
            where_clause = "WHERE " + " AND ".join(where_clauses)

        query = f"""
            CALL db.index.vector.queryNodes('memory_vector_index', $k, $embedding)
            YIELD node, score
            {where_clause}
            RETURN node.id AS id, score
        """

        parameters = {"embedding": vector, "k": top_k, "scope": scope}
        if scope:
            parameters["scope"] = scope
        if status:
            parameters["status"] = status

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, parameters)
            records = [{"id": record["id"], "score": record["score"]} for record in result]

        # Threshold filtering after retrieval
        if threshold is not None:
            records = [r for r in records if r["score"] >= threshold]

        return records

    def get_by_metadata(self, filters: list[dict[str, Any]]) -> list[str]:
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

        where_str = " AND ".join(where_clauses)
        query = f"MATCH (n:Memory) WHERE {where_str} RETURN n.id AS id"

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return [record["id"] for record in result]

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

        # Force RETURN field AS field to guarantee key match
        group_fields_cypher = ", ".join([f"n.{field} AS {field}" for field in group_fields])

        query = f"""
        MATCH (n:Memory)
        {where_clause}
        RETURN {group_fields_cypher}, COUNT(n) AS count
        """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params or {})
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
    def clear(self) -> None:
        """
        Clear the entire graph if the target database exists.
        """
        try:
            # Step 1: Check if the database exists
            with self.driver.session(database="system") as session:
                result = session.run("SHOW DATABASES YIELD name RETURN name")
                db_names = [record["name"] for record in result]
                if self.db_name not in db_names:
                    logger.info(f"[Skip] Database '{self.db_name}' does not exist.")
                    return

            # Step 2: Clear the graph in that database
            with self.driver.session(database=self.db_name) as session:
                session.run("MATCH (n) DETACH DELETE n")
                logger.info(f"Cleared all nodes from database '{self.db_name}'.")

        except Exception as e:
            logger.error(f"[ERROR] Failed to clear database '{self.db_name}': {e}")
            raise

    def export_graph(self) -> dict[str, Any]:
        """
        Export all graph nodes and edges in a structured form.

        Returns:
            {
                "nodes": [ { "id": ..., "memory": ..., "metadata": {...} }, ... ],
                "edges": [ { "source": ..., "target": ..., "type": ... }, ... ]
            }
        """
        with self.driver.session(database=self.db_name) as session:
            # Export nodes
            node_result = session.run("MATCH (n:Memory) RETURN n")
            nodes = [_parse_node(dict(record["n"])) for record in node_result]

            # Export edges
            edge_result = session.run("""
                MATCH (a:Memory)-[r]->(b:Memory)
                RETURN a.id AS source, b.id AS target, type(r) AS type
            """)
            edges = [
                {"source": record["source"], "target": record["target"], "type": record["type"]}
                for record in edge_result
            ]

            return {"nodes": nodes, "edges": edges}

    def import_graph(self, data: dict[str, Any]) -> None:
        """
        Import the entire graph from a serialized dictionary.

        Args:
            data: A dictionary containing all nodes and edges to be loaded.
        """
        with self.driver.session(database=self.db_name) as session:
            for node in data.get("nodes", []):
                id, memory, metadata = _compose_node(node)

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

    def get_all_memory_items(self, scope: str) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $scope
        RETURN n
        """

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, {"scope": scope})
            return [_parse_node(dict(record["n"])) for record in results]

    def get_structure_optimization_candidates(self, scope: str) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """
        query = """
                MATCH (n:Memory)
                WHERE n.memory_type = $scope
                  AND n.status = 'activated'
                  AND NOT ( (n)-[:PARENT]->() OR ()-[:PARENT]->(n) )
                RETURN n.id AS id, n AS node
                """

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, {"scope": scope})
            return [_parse_node({"id": record["id"], **dict(record["node"])}) for record in results]

    def drop_database(self) -> None:
        """
        Permanently delete the entire database this instance is using.
        WARNING: This operation is destructive and cannot be undone.
        """
        if self.db_name in ("system", "neo4j"):
            raise ValueError(f"Refusing to drop protected database: {self.db_name}")

        with self.driver.session(database="system") as session:
            session.run(f"DROP DATABASE {self.db_name} IF EXISTS")
            print(f"Database '{self.db_name}' has been dropped.")

    def _ensure_database_exists(self):
        with self.driver.session(database="system") as session:
            session.run(f"CREATE DATABASE $db_name IF NOT EXISTS", db_name=self.db_name)

        # Wait until the database is available
        for _ in range(10):
            with self.driver.session(database="system") as session:
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
        Create standard B-tree indexes on memory_type, created_at, and updated_at fields.
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
