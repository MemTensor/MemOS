import time

from typing import Any

from neo4j import GraphDatabase
from neo4j.exceptions import ClientError

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.graph_dbs.neo4j import Neo4jGraphDB, _parse_node
from memos.log import get_logger


logger = get_logger(__name__)


class Neo4jCommunityGraphDB(Neo4jGraphDB):
    """Neo4j-based implementation of a graph memory store."""

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

        self.config = config
        self.driver = GraphDatabase.driver(config.uri, auth=(config.user, config.password))
        self.db_name = config.db_name
        self.user_name = config.user_name
        self.system_db_name = config.db_name
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
        # Create indexes
        self._create_basic_property_indexes()

    def get_memory_count(self, memory_type: str) -> int:
        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $memory_type
        """
        if not self.config.use_multi_db and self.config.user_name:
            query += "\nAND n.user_name = $user_name"
        query += "\nRETURN COUNT(n) AS count"
        with self.driver.session(database=self.db_name) as session:
            result = session.run(
                query,
                {
                    "memory_type": memory_type,
                    "user_name": self.config.user_name if self.config.user_name else None,
                },
            )
            return result.single()["count"]

    def count_nodes(self, scope: str) -> int:
        query = """
        MATCH (n:Memory)
        WHERE n.memory_type = $scope
        """
        if not self.config.use_multi_db and self.config.user_name:
            query += "\nAND n.user_name = $user_name"
        query += "\nRETURN count(n) AS count"

        with self.driver.session(database=self.db_name) as session:
            result = session.run(
                query,
                {
                    "scope": scope,
                    "user_name": self.config.user_name if self.config.user_name else None,
                },
            )
            return result.single()["count"]

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
        """
        if not self.config.use_multi_db and self.config.user_name:
            query += f"\nAND n.user_name = '{self.config.user_name}'"

        query += f"""
            WITH n ORDER BY n.updated_at DESC
            SKIP {keep_latest}
            DETACH DELETE n
        """
        with self.driver.session(database=self.db_name) as session:
            session.run(query)

    def get_children_with_embeddings(self, id: str) -> list[dict[str, Any]]:
        where_user = ""
        params = {"id": id}

        if not self.config.use_multi_db and self.config.user_name:
            where_user = "AND p.user_name = $user_name AND c.user_name = $user_name"
            params["user_name"] = self.config.user_name

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
            params = {"center_id": center_id}
            center_user_clause = ""
            neighbor_user_clause = ""

            if not self.config.use_multi_db and self.config.user_name:
                center_user_clause = " AND center.user_name = $user_name"
                neighbor_user_clause = " WHERE neighbor.user_name = $user_name"
                params["user_name"] = self.config.user_name
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
        # TODO
        from your_vector_index import vector_index

        results = vector_index.query(vector, top_k=top_k)
        return [{"id": item.id, "score": item.score} for item in results]

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

        where_clause = "WHERE n.memory_type = $scope"
        params = {"scope": scope}

        if not self.config.use_multi_db and self.config.user_name:
            where_clause += " AND n.user_name = $user_name"
            params["user_name"] = self.config.user_name

        query = f"""
            MATCH (n:Memory)
            {where_clause}
            RETURN n
            """

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, params)
            return [_parse_node(dict(record["n"])) for record in results]

    def get_structure_optimization_candidates(self, scope: str) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """
        where_clause = """
                WHERE n.memory_type = $scope
                  AND n.status = 'activated'
                  AND NOT ( (n)-[:PARENT]->() OR ()-[:PARENT]->(n) )
            """
        params = {"scope": scope}

        if not self.config.use_multi_db and self.config.user_name:
            where_clause += " AND n.user_name = $user_name"
            params["user_name"] = self.config.user_name

        query = f"""
            MATCH (n:Memory)
            {where_clause}
            RETURN n.id AS id, n AS node
            """

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, params)
            return [_parse_node({"id": record["id"], **dict(record["node"])}) for record in results]

    def drop_database(self) -> None:
        """
        Permanently delete the entire database this instance is using.
        WARNING: This operation is destructive and cannot be undone.
        """
        raise ValueError(
            f"Refusing to drop protected database: {self.db_name} in "
            f"Shared Database Multi-Tenant mode"
        )

    def _ensure_database_exists(self):
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
