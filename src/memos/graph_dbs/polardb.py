import json
import time
import random
from datetime import datetime
from typing import Any, Literal

import numpy as np


from memos.configs.graph_db import PolarDBGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.base import BaseGraphDB
from memos.log import get_logger
from memos.utils import timed

logger = get_logger(__name__)

# Graph database configuration
GRAPH_NAME = "test_memos_graph"


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


def generate_vector(dim=1024, low=-0.2, high=0.2):
    """Generate a random vector for testing purposes."""
    return [round(random.uniform(low, high), 6) for _ in range(dim)]


def find_embedding(metadata):
    def find_embedding(item):
        """Find an embedding vector within nested structures"""
        for key in ["embedding", "embedding_1024", "embedding_3072", "embedding_768"]:
            if key in item and isinstance(item[key], list):
                return item[key]
            if "metadata" in item and key in item["metadata"]:
                return item["metadata"][key]
            if "properties" in item and key in item["properties"]:
                return item["properties"][key]
        return None


def detect_embedding_field(embedding_list):
    if not embedding_list:
        return None
    dim = len(embedding_list)
    if dim == 1024:
        return "embedding"
    else:
        print(f"⚠️ Unknown embedding dimension {dim}, skipping this vector")
        return None


def convert_to_vector(embedding_list):
    if not embedding_list:
        return None
    if isinstance(embedding_list, np.ndarray):
        embedding_list = embedding_list.tolist()
    return "[" + ",".join(str(float(x)) for x in embedding_list) + "]"


def clean_properties(props):
    """Remove vector fields"""
    vector_keys = {"embedding", "embedding_1024", "embedding_3072", "embedding_768"}
    if not isinstance(props, dict):
        return {}
    return {k: v for k, v in props.items() if k not in vector_keys}


class PolarDBGraphDB(BaseGraphDB):
    """PolarDB-based implementation using Apache AGE graph database extension."""

    @require_python_package(
        import_name="psycopg2",
        install_command="pip install psycopg2-binary",
        install_link="https://pypi.org/project/psycopg2-binary/",
    )
    def __init__(self, config: PolarDBGraphDBConfig):
        """PolarDB-based implementation using Apache AGE.

        Tenant Modes:
        - use_multi_db = True:
            Dedicated Database Mode (Multi-Database Multi-Tenant).
            Each tenant or logical scope uses a separate PolarDB database.
            `db_name` is the specific tenant database.
            `user_name` can be None (optional).

        - use_multi_db = False:
            Shared Database Multi-Tenant Mode.
            All tenants share a single PolarDB database.
            `db_name` is the shared database.
            `user_name` is required to isolate each tenant's data at the node level.
            All node queries will enforce `user_name` in WHERE conditions and store it in metadata,
            but it will be removed automatically before returning to external consumers.
        """
        import psycopg2

        self.config = config

        # Handle both dict and object config
        if isinstance(config, dict):
            self.db_name = config.get("db_name")
            self.user_name = config.get("user_name")
            host = config.get("host")
            port = config.get("port")
            user = config.get("user")
            password = config.get("password")
        else:
            self.db_name = config.db_name
            self.user_name = config.user_name
            host = config.host
            port = config.port
            user = config.user
            password = config.password

        # Create connection
        self.connection = psycopg2.connect(
            host=host, port=port, user=user, password=password, dbname=self.db_name
        )
        self.connection.autocommit = True

        """
        # Handle auto_create
        # auto_create = config.get("auto_create", False) if isinstance(config, dict) else config.auto_create
        # if auto_create:
        #     self._ensure_database_exists()

        # Create graph and tables
        # self.create_graph()
        # self.create_edge()
        # self._create_graph()

        # Handle embedding_dimension
        # embedding_dim = config.get("embedding_dimension", 1024) if isinstance(config,dict) else config.embedding_dimension
        # self.create_index(dimensions=embedding_dim)
        """

    def _get_config_value(self, key: str, default=None):
        """Safely get config value from either dict or object."""
        if isinstance(self.config, dict):
            return self.config.get(key, default)
        else:
            return getattr(self.config, key, default)

    def _ensure_database_exists(self):
        """Create database if it doesn't exist."""
        try:
            # For PostgreSQL/PolarDB, we need to connect to a default database first
            # This is a simplified implementation - in production you might want to handle this differently
            logger.info(f"Using database '{self.db_name}'")
        except Exception as e:
            logger.error(f"Failed to access database '{self.db_name}': {e}")
            raise

    @timed
    def _create_graph(self):
        """Create PostgreSQL schema and table for graph storage."""
        try:
            with self.connection.cursor() as cursor:
                # Create schema if it doesn't exist
                cursor.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.db_name}_graph";')
                logger.info(f"Schema '{self.db_name}_graph' ensured.")

                # Create Memory table if it doesn't exist
                cursor.execute(f"""
                    CREATE TABLE IF NOT EXISTS "{self.db_name}_graph"."Memory" (
                        id TEXT PRIMARY KEY,
                        properties JSONB NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                logger.info(f"Memory table created in schema '{self.db_name}_graph'.")

                # Add embedding column if it doesn't exist (using JSONB for compatibility)
                try:
                    cursor.execute(f"""
                        ALTER TABLE "{self.db_name}_graph"."Memory" 
                        ADD COLUMN IF NOT EXISTS embedding JSONB;
                    """)
                    logger.info(f"Embedding column added to Memory table.")
                except Exception as e:
                    logger.warning(f"Failed to add embedding column: {e}")

                # Create indexes
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_properties 
                    ON "{self.db_name}_graph"."Memory" USING GIN (properties);
                """)

                # Create vector index for embedding field
                try:
                    cursor.execute(f"""
                        CREATE INDEX IF NOT EXISTS idx_memory_embedding 
                        ON "{self.db_name}_graph"."Memory" USING ivfflat (embedding vector_cosine_ops)
                        WITH (lists = 100);
                    """)
                    logger.info(f"Vector index created for Memory table.")
                except Exception as e:
                    logger.warning(f"Vector index creation failed (might not be supported): {e}")

                logger.info(f"Indexes created for Memory table.")

        except Exception as e:
            logger.error(f"Failed to create graph schema: {e}")
            raise e

    def create_index(
        self,
        label: str = "Memory",
        vector_property: str = "embedding",
        dimensions: int = 1024,
        index_name: str = "memory_vector_index",
    ) -> None:
        """
        Create indexes for embedding and other fields.
        Note: This creates PostgreSQL indexes on the underlying tables.
        """
        try:
            with self.connection.cursor() as cursor:
                # Create indexes on the underlying PostgreSQL tables
                # Apache AGE stores data in regular PostgreSQL tables
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_properties 
                    ON "{self.db_name}_graph"."Memory" USING GIN (properties);
                """)

                # Try to create vector index, but don't fail if it doesn't work
                try:
                    cursor.execute(f"""
                        CREATE INDEX IF NOT EXISTS idx_memory_embedding 
                        ON "{self.db_name}_graph"."Memory" USING ivfflat (embedding vector_cosine_ops);
                    """)
                except Exception as ve:
                    logger.warning(f"Vector index creation failed (might not be supported): {ve}")

                logger.debug(f"Indexes created successfully.")
        except Exception as e:
            logger.warning(f"Failed to create indexes: {e}")

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        """Get count of memory nodes by type."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        query = f"""
            SELECT COUNT(*) 
            FROM "{self.db_name}_graph"."Memory" 
            WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = %s::agtype
        """
        query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        params = [f'"{memory_type}"', f'"{user_name}"']

        print(f"[get_memory_count] Query: {query}, Params: {params}")

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            logger.error(f"[get_memory_count] Failed: {e}")
            return -1

    @timed
    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        """Check if a node with given scope exists."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        query = f"""
            SELECT id 
            FROM "{self.db_name}_graph"."Memory" 
            WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = %s::agtype
        """
        query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        query += "\nLIMIT 1"
        params = [f'"{scope}"', f'"{user_name}"']

        print(f"[node_not_exist] Query: {query}, Params: {params}")

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                print(f"[node_not_exist] Query result: {result}")
                return 1 if result else 0
        except Exception as e:
            logger.error(f"[node_not_exist] Query failed: {e}", exc_info=True)
            raise

    @timed
    def remove_oldest_memory(
        self, memory_type: str, keep_latest: int, user_name: str | None = None
    ) -> None:
        """
        Remove all WorkingMemory nodes except the latest `keep_latest` entries.

        Args:
            memory_type (str): Memory type (e.g., 'WorkingMemory', 'LongTermMemory').
            keep_latest (int): Number of latest WorkingMemory entries to keep.
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Use actual OFFSET logic, consistent with nebular.py
        # First find IDs to delete, then delete them
        select_query = f"""
            SELECT id FROM "{self.db_name}_graph"."Memory" 
            WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = %s::agtype
            AND ag_catalog.agtype_access_operator(properties, '"user_name"'::agtype) = %s::agtype
            ORDER BY ag_catalog.agtype_access_operator(properties, '"updated_at"'::agtype) DESC 
            OFFSET %s
        """
        select_params = [f'"{memory_type}"', f'"{user_name}"', keep_latest]
        print(f"[remove_oldest_memory] Select query: {select_query}")
        print(f"[remove_oldest_memory] Select params: {select_params}")

        try:
            with self.connection.cursor() as cursor:
                # Execute query to get IDs to delete
                cursor.execute(select_query, select_params)
                ids_to_delete = [row[0] for row in cursor.fetchall()]

                if not ids_to_delete:
                    logger.info(f"No {memory_type} memories to remove for user {user_name}")
                    return

                # Build delete query
                placeholders = ",".join(["%s"] * len(ids_to_delete))
                delete_query = f"""
                    DELETE FROM "{self.db_name}_graph"."Memory"
                    WHERE id IN ({placeholders})
                """
                delete_params = ids_to_delete

                # Execute deletion
                cursor.execute(delete_query, delete_params)
                deleted_count = cursor.rowcount
                logger.info(
                    f"Removed {deleted_count} oldest {memory_type} memories, keeping {keep_latest} latest for user {user_name}"
                )
        except Exception as e:
            logger.error(f"[remove_oldest_memory] Failed: {e}", exc_info=True)
            raise

    @timed
    def update_node(self, id: str, fields: dict[str, Any], user_name: str | None = None) -> None:
        """
        Update node fields in PolarDB, auto-converting `created_at` and `updated_at` to datetime type if present.
        """
        if not fields:
            return

        user_name = user_name if user_name else self.config.user_name

        # Get the current node
        current_node = self.get_node(id, user_name=user_name)
        if not current_node:
            return

        # Update properties but keep original id and memory fields
        properties = current_node["metadata"].copy()
        original_id = properties.get("id", id)  # Preserve original ID
        original_memory = current_node.get("memory", "")  # Preserve original memory

        # If fields include memory, use it; otherwise keep original memory
        if "memory" in fields:
            original_memory = fields.pop("memory")

        properties.update(fields)
        properties["id"] = original_id  # Ensure ID is not overwritten
        properties["memory"] = original_memory  # Ensure memory is not overwritten

        # Handle embedding field
        embedding_vector = None
        if "embedding" in fields:
            embedding_vector = fields.pop("embedding")
            if not isinstance(embedding_vector, list):
                embedding_vector = None

        # Build update query
        if embedding_vector is not None:
            query = f"""
                UPDATE "{self.db_name}_graph"."Memory" 
                SET properties = %s, embedding = %s
                WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
            """
            params = [json.dumps(properties), json.dumps(embedding_vector), f'"{id}"']
        else:
            query = f"""
                UPDATE "{self.db_name}_graph"."Memory" 
                SET properties = %s
                WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
            """
            params = [json.dumps(properties), f'"{id}"']

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
            params.append(f'"{user_name}"')

        print(f"[update_node] query: {query}, params: {params}")
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, params)
        except Exception as e:
            logger.error(f"[update_node] Failed to update node '{id}': {e}", exc_info=True)
            raise

    @timed
    def delete_node(self, id: str, user_name: str | None = None) -> None:
        """
        Delete a node from the graph.
        Args:
            id: Node identifier to delete.
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        query = f"""
            DELETE FROM "{self.db_name}_graph"."Memory" 
            WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
        """
        params = [f'"{id}"']

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
            params.append(f'"{user_name}"')

        print(f"[delete_node] query: {query}, params: {params}")
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, params)
        except Exception as e:
            logger.error(f"[delete_node] Failed to delete node '{id}': {e}", exc_info=True)
            raise

    @timed
    def create_extension(self):
        extensions = [("polar_age", "Graph engine"), ("vector", "Vector engine")]
        try:
            with self.connection.cursor() as cursor:
                # Ensure in the correct database context
                cursor.execute(f"SELECT current_database();")
                current_db = cursor.fetchone()[0]
                print(f"Current database context: {current_db}")

                for ext_name, ext_desc in extensions:
                    try:
                        cursor.execute(f"create extension if not exists {ext_name};")
                        print(f"✅ Extension '{ext_name}' ({ext_desc}) ensured.")
                    except Exception as e:
                        if "already exists" in str(e):
                            print(f"ℹ️ Extension '{ext_name}' ({ext_desc}) already exists.")
                        else:
                            print(f"⚠️ Failed to create extension '{ext_name}' ({ext_desc}): {e}")
                            logger.error(
                                f"Failed to create extension '{ext_name}': {e}", exc_info=True
                            )
        except Exception as e:
            print(f"⚠️ Failed to access database context: {e}")
            logger.error(f"Failed to access database context: {e}", exc_info=True)

    @timed
    def create_graph(self):
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(f"""
                    SELECT COUNT(*) FROM ag_catalog.ag_graph 
                    WHERE name = '{self.db_name}_graph';
                """)
                graph_exists = cursor.fetchone()[0] > 0

                if graph_exists:
                    print(f"ℹ️ Graph '{self.db_name}_graph' already exists.")
                else:
                    cursor.execute(f"select create_graph('{self.db_name}_graph');")
                    print(f"✅ Graph database '{self.db_name}_graph' created.")
        except Exception as e:
            print(f"⚠️ Failed to create graph '{self.db_name}_graph': {e}")
            logger.error(f"Failed to create graph '{self.db_name}_graph': {e}", exc_info=True)

    @timed
    def create_edge(self):
        """Create all valid edge types if they do not exist"""

        valid_rel_types = {"AGGREGATE_TO", "FOLLOWS", "INFERS", "MERGED_TO", "RELATE_TO", "PARENT"}

        for label_name in valid_rel_types:
            print(f"🪶 Creating elabel: {label_name}")
            try:
                with self.connection.cursor() as cursor:
                    cursor.execute(f"select create_elabel('{self.db_name}_graph', '{label_name}');")
                    print(f"✅ Successfully created elabel: {label_name}")
            except Exception as e:
                if "already exists" in str(e):
                    print(f"ℹ️ Label '{label_name}' already exists, skipping.")
                else:
                    print(f"⚠️ Failed to create label {label_name}: {e}")
                    logger.error(f"Failed to create elabel '{label_name}': {e}", exc_info=True)

    @timed
    def add_edge(
        self, source_id: str, target_id: str, type: str, user_name: str | None = None
    ) -> None:
        if not source_id or not target_id:
            raise ValueError("[add_edge] source_id and target_id must be provided")

        source_exists = self.get_node(source_id) is not None
        target_exists = self.get_node(target_id) is not None

        if not source_exists or not target_exists:
            raise ValueError("[add_edge] source_id and target_id must be provided")

        properties = {}
        if user_name is not None:
            properties["user_name"] = user_name
        query = f"""
            INSERT INTO {self.db_name}_graph."{type}"(id, start_id, end_id, properties)
            SELECT
                ag_catalog._next_graph_id('{self.db_name}_graph'::name, '{type}'),
                ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{source_id}'::text::cstring),
                ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{target_id}'::text::cstring),
                jsonb_build_object('user_name', '{user_name}')::text::agtype
            WHERE NOT EXISTS (
                SELECT 1 FROM {self.db_name}_graph."{type}"
                WHERE start_id = ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{source_id}'::text::cstring)
                  AND end_id   = ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, '{target_id}'::text::cstring)
            );
        """
        print(f"Executing add_edge: {query}")

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, (source_id, target_id, type, json.dumps(properties)))
                logger.info(f"Edge created: {source_id} -[{type}]-> {target_id}")
        except Exception as e:
            logger.error(f"Failed to insert edge: {e}", exc_info=True)
            raise

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
            DELETE FROM "{self.db_name}_graph"."Edges"
            WHERE source_id = %s AND target_id = %s AND edge_type = %s
        """

        with self.connection.cursor() as cursor:
            cursor.execute(query, (source_id, target_id, type))
            logger.info(f"Edge deleted: {source_id} -[{type}]-> {target_id}")

    @timed
    def edge_exists_old(
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
        where_clauses = []
        params = []
        # SELECT * FROM
        # cypher('memtensor_memos_graph', $$
        # MATCH(a: Memory
        # {id: "13bb9df6-0609-4442-8bed-bba77dadac92"})-[r] - (b:Memory {id: "2dd03a5b-5d5f-49c9-9e0a-9a2a2899b98d"})
        # RETURN
        # r
        # $$) AS(r
        # agtype);

        if direction == "OUTGOING":
            where_clauses.append("source_id = %s AND target_id = %s")
            params.extend([source_id, target_id])
        elif direction == "INCOMING":
            where_clauses.append("source_id = %s AND target_id = %s")
            params.extend([target_id, source_id])
        elif direction == "ANY":
            where_clauses.append(
                "((source_id = %s AND target_id = %s) OR (source_id = %s AND target_id = %s))"
            )
            params.extend([source_id, target_id, target_id, source_id])
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )

        if type != "ANY":
            where_clauses.append("edge_type = %s")
            params.append(type)

        where_clause = " AND ".join(where_clauses)

        query = f"""
            SELECT 1 FROM "{self.db_name}_graph"."Edges"
            WHERE {where_clause}
            LIMIT 1
        """

        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            result = cursor.fetchone()
            return result is not None

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

        # Prepare the relationship pattern
        user_name = user_name if user_name else self.config.user_name
        print(f"edge_exists direction: {direction}")

        # Prepare the match pattern with direction
        if direction == "OUTGOING":
            pattern = f"(a:Memory)-[r]->(b:Memory)"
        elif direction == "INCOMING":
            pattern = f"(a:Memory)<-[r]-(b:Memory)"
        elif direction == "ANY":
            pattern = f"(a:Memory)-[r]-(b:Memory)"
        else:
            raise ValueError(
                f"Invalid direction: {direction}. Must be 'OUTGOING', 'INCOMING', or 'ANY'."
            )
        query = f"SELECT * FROM cypher('{self.db_name}_graph', $$"
        query += f"\nMATCH {pattern}"
        query += f"\nWHERE a.user_name = '{user_name}' AND b.user_name = '{user_name}'"
        query += f"\nAND a.id = '{source_id}' AND b.id = '{target_id}'"
        if type != "ANY":
            query += f"\n AND type(r) = '{type}'"

        query += "\nRETURN r"
        query += "\n$$) AS (r agtype)"

        print(f"edge_exists query: {query}")
        with self.connection.cursor() as cursor:
            cursor.execute(query)
            result = cursor.fetchone()
            return result is not None and result[0] is not None

    @timed
    def get_node(
        self, id: str, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any] | None:
        """
        Retrieve a Memory node by its unique ID.

        Args:
            id (str): Node ID (Memory.id)
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            dict: Node properties as key-value pairs, or None if not found.
        """

        select_fields = "id, properties, embedding" if include_embedding else "id, properties"

        # Helper function to format parameter value
        def format_param_value(value: str) -> str:
            """Format parameter value to handle both quoted and unquoted formats"""
            # Remove outer quotes if they exist
            if value.startswith('"') and value.endswith('"'):
                # Already has double quotes, return as is
                return value
            else:
                # Add double quotes
                return f'"{value}"'

        query = f"""
            SELECT {select_fields}
            FROM "{self.db_name}_graph"."Memory" 
            WHERE ag_catalog.agtype_access_operator(properties, '"id"'::agtype) = %s::agtype
        """
        params = [format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
            params.append(format_param_value(user_name))

        print(f"[get_node] query: {query}, params: {params}")
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()

                if result:
                    if include_embedding:
                        node_id, properties_json, embedding_json = result
                    else:
                        node_id, properties_json = result
                        embedding_json = None

                    # Parse properties from JSONB if it's a string
                    if isinstance(properties_json, str):
                        try:
                            properties = json.loads(properties_json)
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse properties for node {id}")
                            properties = {}
                    else:
                        properties = properties_json if properties_json else {}

                    # Parse embedding from JSONB if it exists and include_embedding is True
                    if include_embedding and embedding_json is not None:
                        try:
                            embedding = (
                                json.loads(embedding_json)
                                if isinstance(embedding_json, str)
                                else embedding_json
                            )
                            properties["embedding"] = embedding
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse embedding for node {id}")

                    return self._parse_node(
                        {"id": id, "memory": properties.get("memory", ""), **properties}
                    )
                return None

        except Exception as e:
            logger.error(f"[get_node] Failed to retrieve node '{id}': {e}", exc_info=True)
            return None

    @timed
    def get_nodes(
        self, ids: list[str], user_name: str | None = None, **kwargs
    ) -> list[dict[str, Any]]:
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

        # Build WHERE clause using agtype_access_operator like get_node method
        where_conditions = []
        params = []

        for id_val in ids:
            where_conditions.append(
                "ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) = %s::agtype"
            )
            params.append(f"{id_val}")

        where_clause = " OR ".join(where_conditions)

        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory" 
            WHERE ({where_clause})
        """

        user_name = user_name if user_name else self.config.user_name
        query += " AND ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        params.append(f'"{user_name}"')

        print(f"[get_nodes] query: {query}, params: {params}")
        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            results = cursor.fetchall()

            nodes = []
            for row in results:
                node_id, properties_json, embedding_json = row
                # Parse properties from JSONB if it's a string
                if isinstance(properties_json, str):
                    try:
                        properties = json.loads(properties_json)
                    except (json.JSONDecodeError, TypeError):
                        logger.warning(f"Failed to parse properties for node {node_id}")
                        properties = {}
                else:
                    properties = properties_json if properties_json else {}

                # Parse embedding from JSONB if it exists
                if embedding_json is not None:
                    try:
                        print("embedding_json:", embedding_json)
                        # remove embedding
                        """
                        embedding = json.loads(embedding_json) if isinstance(embedding_json, str) else embedding_json
                        # properties["embedding"] = embedding
                        """
                    except (json.JSONDecodeError, TypeError):
                        logger.warning(f"Failed to parse embedding for node {node_id}")
                nodes.append(
                    self._parse_node(
                        {
                            "id": properties.get("id", node_id),
                            "memory": properties.get("memory", ""),
                            "metadata": properties,
                        }
                    )
                )
            return nodes

    @timed
    def get_edges_old(
        self, id: str, type: str = "ANY", direction: str = "ANY"
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

        # Create a simple edge table to store relationships (if not exists)
        try:
            with self.connection.cursor() as cursor:
                # Create edge table
                cursor.execute(f"""
                    CREATE TABLE IF NOT EXISTS "{self.db_name}_graph"."Edges" (
                        id SERIAL PRIMARY KEY,
                        source_id TEXT NOT NULL,
                        target_id TEXT NOT NULL,
                        edge_type TEXT NOT NULL,
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (source_id) REFERENCES "{self.db_name}_graph"."Memory"(id),
                        FOREIGN KEY (target_id) REFERENCES "{self.db_name}_graph"."Memory"(id)
                    );
                """)

                # Create indexes
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_source 
                    ON "{self.db_name}_graph"."Edges" (source_id);
                """)
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_target 
                    ON "{self.db_name}_graph"."Edges" (target_id);
                """)
                cursor.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_edges_type 
                    ON "{self.db_name}_graph"."Edges" (edge_type);
                """)
        except Exception as e:
            logger.warning(f"Failed to create edges table: {e}")

        # Query edges
        where_clauses = []
        params = [id]

        if type != "ANY":
            where_clauses.append("edge_type = %s")
            params.append(type)

        if direction == "OUTGOING":
            where_clauses.append("source_id = %s")
        elif direction == "INCOMING":
            where_clauses.append("target_id = %s")
        else:  # ANY
            where_clauses.append("(source_id = %s OR target_id = %s)")
            params.append(id)  # Add second parameter for ANY direction

        where_clause = " AND ".join(where_clauses)

        query = f"""
            SELECT source_id, target_id, edge_type
            FROM "{self.db_name}_graph"."Edges"
            WHERE {where_clause}
        """

        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            results = cursor.fetchall()

            edges = []
            for row in results:
                source_id, target_id, edge_type = row
                edges.append({"from": source_id, "to": target_id, "type": edge_type})
            return edges

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """Get connected node IDs in a specific direction and relationship type."""
        raise NotImplementedError

    @timed
    def get_neighbors_by_tag_old(
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
        # Build query conditions
        where_clauses = []
        params = []

        # Exclude specified IDs
        if exclude_ids:
            placeholders = ",".join(["%s"] * len(exclude_ids))
            where_clauses.append(f"id NOT IN ({placeholders})")
            params.extend(exclude_ids)

        # Status filter
        where_clauses.append("properties->>'status' = %s")
        params.append("activated")

        # Type filter
        where_clauses.append("properties->>'type' != %s")
        params.append("reasoning")

        where_clauses.append("properties->>'memory_type' != %s")
        params.append("WorkingMemory")

        # User filter
        if not self._get_config_value("use_multi_db", True) and self._get_config_value("user_name"):
            where_clauses.append("properties->>'user_name' = %s")
            params.append(self._get_config_value("user_name"))

        where_clause = " AND ".join(where_clauses)

        # Get all candidate nodes
        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory" 
            WHERE {where_clause}
        """

        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            results = cursor.fetchall()

            nodes_with_overlap = []
            for row in results:
                node_id, properties_json, embedding_json = row
                properties = properties_json if properties_json else {}

                # Parse embedding
                if embedding_json is not None:
                    try:
                        embedding = (
                            json.loads(embedding_json)
                            if isinstance(embedding_json, str)
                            else embedding_json
                        )
                        properties["embedding"] = embedding
                    except (json.JSONDecodeError, TypeError):
                        logger.warning(f"Failed to parse embedding for node {node_id}")

                # Compute tag overlap
                node_tags = properties.get("tags", [])
                if isinstance(node_tags, str):
                    try:
                        node_tags = json.loads(node_tags)
                    except (json.JSONDecodeError, TypeError):
                        node_tags = []

                overlap_tags = [tag for tag in tags if tag in node_tags]
                overlap_count = len(overlap_tags)

                if overlap_count >= min_overlap:
                    node_data = self._parse_node(
                        {
                            "id": properties.get("id", node_id),
                            "memory": properties.get("memory", ""),
                            "metadata": properties,
                        }
                    )
                    nodes_with_overlap.append((node_data, overlap_count))

            # Sort by overlap count and return top_k
            nodes_with_overlap.sort(key=lambda x: x[1], reverse=True)
            return [node for node, _ in nodes_with_overlap[:top_k]]

    @timed
    def get_children_with_embeddings(
        self, id: str, user_name: str | None = None
    ) -> list[dict[str, Any]]:
        """Get children nodes with their embeddings."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        where_user = f"AND p.user_name = '{user_name}' AND c.user_name = '{user_name}'"

        query = f"""
            WITH t as (
                SELECT *
                FROM cypher('{self.db_name}_graph', $$
                MATCH (p:Memory)-[r:PARENT]->(c:Memory)
                WHERE p.id = '{id}' {where_user} 
                RETURN id(c) as cid, c.id AS id, c.memory AS memory
                $$) as (cid agtype, id agtype, memory agtype)
                )
                SELECT t.id, m.embedding, t.memory FROM t,
                "{self.db_name}_graph"."Memory" m
            WHERE t.cid::graphid = m.id;
        """

        print("[get_children_with_embeddings] query:", query)

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                children = []
                for row in results:
                    # Handle child_id - remove possible quotes
                    child_id_raw = row[0].value if hasattr(row[0], "value") else str(row[0])
                    if isinstance(child_id_raw, str):
                        # If string starts and ends with quotes, remove quotes
                        if child_id_raw.startswith('"') and child_id_raw.endswith('"'):
                            child_id = child_id_raw[1:-1]
                        else:
                            child_id = child_id_raw
                    else:
                        child_id = str(child_id_raw)

                    # Handle embedding - get from database embedding column
                    embedding_raw = row[1]
                    embedding = []
                    if embedding_raw is not None:
                        try:
                            if isinstance(embedding_raw, str):
                                # If it is a JSON string, parse it
                                embedding = json.loads(embedding_raw)
                            elif isinstance(embedding_raw, list):
                                # If already a list, use directly
                                embedding = embedding_raw
                            else:
                                # Try converting to list
                                embedding = list(embedding_raw)
                        except (json.JSONDecodeError, TypeError, ValueError) as e:
                            logger.warning(
                                f"Failed to parse embedding for child node {child_id}: {e}"
                            )
                            embedding = []

                    # Handle memory - remove possible quotes
                    memory_raw = row[2].value if hasattr(row[2], "value") else str(row[2])
                    if isinstance(memory_raw, str):
                        # If string starts and ends with quotes, remove quotes
                        if memory_raw.startswith('"') and memory_raw.endswith('"'):
                            memory = memory_raw[1:-1]
                        else:
                            memory = memory_raw
                    else:
                        memory = str(memory_raw)

                    children.append({"id": child_id, "embedding": embedding, "memory": memory})

                return children

        except Exception as e:
            logger.error(f"[get_children_with_embeddings] Failed: {e}", exc_info=True)
            return []

    def get_path(self, source_id: str, target_id: str, max_depth: int = 3) -> list[str]:
        """Get the path of nodes from source to target within a limited depth."""
        raise NotImplementedError

    @timed
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
            user_name (str, optional): User name for filtering in non-multi-db mode
        Returns:
            {
                "core_node": {...},
                "neighbors": [...],
                "edges": [...]
            }
        """
        if not 1 <= depth <= 5:
            raise ValueError("depth must be 1-5")

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Use a simplified query to get the subgraph (temporarily only direct neighbors)
        """
            SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH(center: Memory)-[r * 1..{depth}]->(neighbor:Memory)
                    WHERE
                    center.id = '{center_id}'
                    AND center.status = '{center_status}'
                    AND center.user_name = '{user_name}'
                    RETURN
                    collect(DISTINCT
                    center), collect(DISTINCT
                    neighbor), collect(DISTINCT
                    r)
                $$ ) as (centers agtype, neighbors agtype, rels agtype);
            """
        query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH(center: Memory)-[r * 1..{depth}]->(neighbor:Memory)
                    WHERE
                    center.id = '{center_id}'
                    RETURN
                    collect(DISTINCT
                    center), collect(DISTINCT
                    neighbor), collect(DISTINCT
                    r)
                $$ ) as (centers agtype, neighbors agtype, rels agtype);
            """

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query)
                result = cursor.fetchone()
                print("[get_subgraph] result:", result)

                if not result or not result[0]:
                    return {"core_node": None, "neighbors": [], "edges": []}

                # Parse center node
                centers_data = result[0] if result[0] else "[]"
                neighbors_data = result[1] if result[1] else "[]"
                edges_data = result[2] if result[2] else "[]"

                # Parse JSON data
                try:
                    # Clean ::vertex and ::edge suffixes in data
                    if isinstance(centers_data, str):
                        centers_data = centers_data.replace("::vertex", "")
                    if isinstance(neighbors_data, str):
                        neighbors_data = neighbors_data.replace("::vertex", "")
                    if isinstance(edges_data, str):
                        edges_data = edges_data.replace("::edge", "")

                    centers_list = (
                        json.loads(centers_data) if isinstance(centers_data, str) else centers_data
                    )
                    neighbors_list = (
                        json.loads(neighbors_data)
                        if isinstance(neighbors_data, str)
                        else neighbors_data
                    )
                    edges_list = (
                        json.loads(edges_data) if isinstance(edges_data, str) else edges_data
                    )
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse JSON data: {e}")
                    return {"core_node": None, "neighbors": [], "edges": []}

                # Parse center node
                core_node = None
                if centers_list and len(centers_list) > 0:
                    center_data = centers_list[0]
                    if isinstance(center_data, dict) and "properties" in center_data:
                        core_node = self._parse_node(center_data["properties"])

                # Parse neighbor nodes
                neighbors = []
                if isinstance(neighbors_list, list):
                    for neighbor_data in neighbors_list:
                        if isinstance(neighbor_data, dict) and "properties" in neighbor_data:
                            neighbor_parsed = self._parse_node(neighbor_data["properties"])
                            neighbors.append(neighbor_parsed)

                # Parse edges
                edges = []
                if isinstance(edges_list, list):
                    for edge_group in edges_list:
                        if isinstance(edge_group, list):
                            for edge_data in edge_group:
                                if isinstance(edge_data, dict):
                                    edges.append(
                                        {
                                            "type": edge_data.get("label", ""),
                                            "source": edge_data.get("start_id", ""),
                                            "target": edge_data.get("end_id", ""),
                                        }
                                    )

                return {"core_node": core_node, "neighbors": neighbors, "edges": edges}

        except Exception as e:
            logger.error(f"Failed to get subgraph: {e}", exc_info=True)
            return {"core_node": None, "neighbors": [], "edges": []}

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """Get the ordered context chain starting from a node."""
        raise NotImplementedError

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
        **kwargs,
    ) -> list[dict]:
        """
        Retrieve node IDs based on vector similarity using PostgreSQL vector operations.
        """
        # Build WHERE clause dynamically like nebular.py
        where_clauses = []
        if scope:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) = '\"{scope}\"'::agtype"
            )
        if status:
            where_clauses.append(
                f"ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"{status}\"'::agtype"
            )
        else:
            where_clauses.append(
                "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
            )
        where_clauses.append("embedding is not null")
        # Add user_name filter like nebular.py

        """
        # user_name = self._get_config_value("user_name")
        # if not self.config.use_multi_db and user_name:
        #     if kwargs.get("cube_name"):
        #         where_clauses.append(f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{kwargs['cube_name']}\"'::agtype")
        #     else:
        #         where_clauses.append(f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype")
        """
        user_name = user_name if user_name else self.config.user_name
        where_clauses.append(
            f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype"
        )

        # Add search_filter conditions like nebular.py
        if search_filter:
            for key, value in search_filter.items():
                if isinstance(value, str):
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = '\"{value}\"'::agtype"
                    )
                else:
                    where_clauses.append(
                        f"ag_catalog.agtype_access_operator(properties, '\"{key}\"'::agtype) = {value}::agtype"
                    )

        where_clause = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Keep original simple query structure but add dynamic WHERE clause
        query = f"""
                    WITH t AS (
                        SELECT id,
                               properties,
                               timeline,
                               ag_catalog.agtype_access_operator(properties, '"id"'::agtype) AS old_id,
                               (1 - (embedding <=> %s::vector(1024))) AS scope
                        FROM "{self.db_name}_graph"."Memory"
                        {where_clause}
                        ORDER BY scope DESC
                        LIMIT {top_k}
                    )
                    SELECT *
                    FROM t
                    WHERE scope > 0.1;
                """
        params = [vector]

        print(
            f"[search_by_embedding] query: {query}, params: {params}, where_clause: {where_clause}"
        )
        with self.connection.cursor() as cursor:
            cursor.execute(query, params)
            results = cursor.fetchall()
            output = []
            for row in results:
                """
                polarId = row[0]  # id
                properties = row[1]  # properties
                # embedding = row[3]  # embedding
                """
                oldid = row[3]  # old_id
                score = row[4]  # scope
                id_val = str(oldid)
                score_val = float(score)
                score_val = (score_val + 1) / 2  # align to neo4j, Normalized Cosine Score
                if threshold is None or score_val >= threshold:
                    output.append({"id": id_val, "score": score_val})
            return output[:top_k]

    @timed
    def get_by_metadata(
        self, filters: list[dict[str, Any]], user_name: str | None = None
    ) -> list[str]:
        """
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
        user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[str]: Node IDs whose metadata match the filter conditions. (AND logic).
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build WHERE conditions for cypher query
        where_conditions = []

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]

            # Format value
            if isinstance(value, str):
                # Escape single quotes in string values
                escaped_str = value.replace("'", "''")
                escaped_value = f"'{escaped_str}'"
            elif isinstance(value, list):
                # Handle list values - use double quotes for Cypher arrays
                list_items = []
                for v in value:
                    if isinstance(v, str):
                        # Escape double quotes in string values for Cypher
                        escaped_str = v.replace('"', '\\"')
                        list_items.append(f'"{escaped_str}"')
                    else:
                        list_items.append(str(v))
                escaped_value = f"[{', '.join(list_items)}]"
            else:
                escaped_value = f"'{value}'" if isinstance(value, str) else str(value)
            print("op=============:", op)
            # Build WHERE conditions
            if op == "=":
                where_conditions.append(f"n.{field} = {escaped_value}")
            elif op == "in":
                where_conditions.append(f"n.{field} IN {escaped_value}")
                """
                # where_conditions.append(f"{escaped_value} IN n.{field}")
                """
            elif op == "contains":
                where_conditions.append(f"{escaped_value} IN n.{field}")
                """
                # where_conditions.append(f"size(filter(n.{field}, t -> t IN {escaped_value})) > 0")
                """
            elif op == "starts_with":
                where_conditions.append(f"n.{field} STARTS WITH {escaped_value}")
            elif op == "ends_with":
                where_conditions.append(f"n.{field} ENDS WITH {escaped_value}")
            elif op in [">", ">=", "<", "<="]:
                where_conditions.append(f"n.{field} {op} {escaped_value}")
            else:
                raise ValueError(f"Unsupported operator: {op}")

        # Add user_name filter
        escaped_user_name = user_name.replace("'", "''")
        where_conditions.append(f"n.user_name = '{escaped_user_name}'")

        where_str = " AND ".join(where_conditions)

        # Use cypher query
        cypher_query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
            MATCH (n:Memory)
            WHERE {where_str}
            RETURN n.id AS id
            $$) AS (id agtype)
        """

        print(f"[get_by_metadata] query: {cypher_query}, where_str: {where_str}")
        ids = []
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(cypher_query)
                results = cursor.fetchall()
                print("[get_by_metadata] result:", results)
                ids = [str(item[0]).strip('"') for item in results]
        except Exception as e:
            print("Failed to get metadata:", {e})
            logger.error(f"Failed to get metadata: {e}, query is {cypher_query}")

        return ids

    @timed
    def get_grouped_counts1(
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
        print("username:" + user_name)
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
        print("where_clause:" + where_clause)
        # Force RETURN field AS field to guarantee key match
        group_fields_cypher = ", ".join([f"n.{field} AS {field}" for field in group_fields])
        """
        # group_fields_cypher_polardb = "agtype, ".join([f"{field}" for field in group_fields])
        """
        group_fields_cypher_polardb = ", ".join([f"{field} agtype" for field in group_fields])
        print("group_fields_cypher_polardb:" + group_fields_cypher_polardb)
        query = f"""
               SELECT * FROM cypher('{self.db_name}_graph', $$
                   MATCH (n:Memory)
                   {where_clause}
                   RETURN {group_fields_cypher}, COUNT(n) AS count1
               $$ ) as ({group_fields_cypher_polardb}, count1 agtype); 
               """
        print("get_grouped_counts:" + query)
        try:
            with self.connection.cursor() as cursor:
                # Handle parameterized query
                if params and isinstance(params, list):
                    cursor.execute(query, final_params)
                else:
                    cursor.execute(query)
                results = cursor.fetchall()

                output = []
                for row in results:
                    group_values = {}
                    for i, field in enumerate(group_fields):
                        value = row[i]
                        if hasattr(value, "value"):
                            group_values[field] = value.value
                        else:
                            group_values[field] = str(value)
                    count_value = row[-1]  # Last column is count
                    output.append({**group_values, "count": count_value})

                return output

        except Exception as e:
            logger.error(f"Failed to get grouped counts: {e}", exc_info=True)
            return []

    @timed
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
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[dict]: e.g., [{ 'memory_type': 'WorkingMemory', 'status': 'active', 'count': 10 }, ...]
        """
        if not group_fields:
            raise ValueError("group_fields cannot be empty")

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build user clause
        user_clause = f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype"
        if where_clause:
            where_clause = where_clause.strip()
            if where_clause.upper().startswith("WHERE"):
                where_clause += f" AND {user_clause}"
            else:
                where_clause = f"WHERE {where_clause} AND {user_clause}"
        else:
            where_clause = f"WHERE {user_clause}"

        # Inline parameters if provided
        if params and isinstance(params, dict):
            for key, value in params.items():
                # Handle different value types appropriately
                if isinstance(value, str):
                    value = f"'{value}'"
                where_clause = where_clause.replace(f"${key}", str(value))

        # Handle user_name parameter in where_clause
        if "user_name = %s" in where_clause:
            where_clause = where_clause.replace(
                "user_name = %s",
                f"ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype",
            )

        # Build return fields and group by fields
        return_fields = []
        group_by_fields = []

        for field in group_fields:
            alias = field.replace(".", "_")
            return_fields.append(
                f"ag_catalog.agtype_access_operator(properties, '\"{field}\"'::agtype) AS {alias}"
            )
            group_by_fields.append(alias)

        # Full SQL query construction
        query = f"""
            SELECT {", ".join(return_fields)}, COUNT(*) AS count
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            GROUP BY {", ".join(group_by_fields)}
        """

        print("[get_grouped_counts] query:", query)

        try:
            with self.connection.cursor() as cursor:
                # Handle parameterized query
                if params and isinstance(params, list):
                    cursor.execute(query, params)
                else:
                    cursor.execute(query)
                results = cursor.fetchall()

                output = []
                for row in results:
                    group_values = {}
                    for i, field in enumerate(group_fields):
                        value = row[i]
                        if hasattr(value, "value"):
                            group_values[field] = value.value
                        else:
                            group_values[field] = str(value)
                    count_value = row[-1]  # Last column is count
                    output.append({**group_values, "count": count_value})

                return output

        except Exception as e:
            logger.error(f"Failed to get grouped counts: {e}", exc_info=True)
            return []

    def deduplicate_nodes(self) -> None:
        """Deduplicate redundant or semantically similar nodes."""
        raise NotImplementedError

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """Detect conflicting nodes based on logical or semantic inconsistency."""
        raise NotImplementedError

    def merge_nodes(self, id1: str, id2: str) -> str:
        """Merge two similar or duplicate nodes into one."""
        raise NotImplementedError

    @timed
    def clear(self, user_name: str | None = None) -> None:
        """
        Clear the entire graph if the target database exists.

        Args:
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        try:
            query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (n:Memory) 
                WHERE n.user_name = '{user_name}' 
                DETACH DELETE n
                $$) AS (result agtype)
            """

            with self.connection.cursor() as cursor:
                cursor.execute(query)
                logger.info("Cleared all nodes from database.")

        except Exception as e:
            logger.error(f"[ERROR] Failed to clear database: {e}")

    @timed
    def export_graph(
        self, include_embedding: bool = False, user_name: str | None = None
    ) -> dict[str, Any]:
        """
        Export all graph nodes and edges in a structured form.
        Args:
        include_embedding (bool): Whether to include the large embedding field.
        user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            {
                "nodes": [ { "id": ..., "memory": ..., "metadata": {...} }, ... ],
                "edges": [ { "source": ..., "target": ..., "type": ... }, ... ]
            }
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        try:
            # Export nodes
            if include_embedding:
                node_query = f"""
                    SELECT id, properties, embedding
                    FROM "{self.db_name}_graph"."Memory"
                    WHERE ag_catalog.agtype_access_operator(properties, '"user_name"'::agtype) = '\"{user_name}\"'::agtype
                """
            else:
                node_query = f"""
                    SELECT id, properties
                    FROM "{self.db_name}_graph"."Memory"
                    WHERE ag_catalog.agtype_access_operator(properties, '"user_name"'::agtype) = '\"{user_name}\"'::agtype
                """

            with self.connection.cursor() as cursor:
                cursor.execute(node_query)
                node_results = cursor.fetchall()
                nodes = []

                for row in node_results:
                    if include_embedding:
                        node_id, properties_json, embedding_json = row
                    else:
                        node_id, properties_json = row
                        embedding_json = None

                    # Parse properties from JSONB if it's a string
                    if isinstance(properties_json, str):
                        try:
                            properties = json.loads(properties_json)
                        except json.JSONDecodeError:
                            properties = {}
                    else:
                        properties = properties_json if properties_json else {}

                    # # Build node data

                    """
                    # node_data = {
                    #     "id": properties.get("id", node_id),
                    #     "memory": properties.get("memory", ""),
                    #     "metadata": properties
                    # }
                    """

                    if include_embedding and embedding_json is not None:
                        properties["embedding"] = embedding_json

                    nodes.append(self._parse_node(properties))

        except Exception as e:
            logger.error(f"[EXPORT GRAPH - NODES] Exception: {e}", exc_info=True)
            raise RuntimeError(f"[EXPORT GRAPH - NODES] Exception: {e}") from e

        try:
            # Export edges using cypher query
            edge_query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (a:Memory)-[r]->(b:Memory)
                WHERE a.user_name = '{user_name}' AND b.user_name = '{user_name}'
                RETURN a.id AS source, b.id AS target, type(r) as edge 
                $$) AS (source agtype, target agtype, edge agtype)
            """

            with self.connection.cursor() as cursor:
                cursor.execute(edge_query)
                edge_results = cursor.fetchall()
                edges = []

                for row in edge_results:
                    source_agtype, target_agtype, edge_agtype = row
                    edges.append(
                        {
                            "source": source_agtype.value
                            if hasattr(source_agtype, "value")
                            else str(source_agtype),
                            "target": target_agtype.value
                            if hasattr(target_agtype, "value")
                            else str(target_agtype),
                            "type": edge_agtype.value
                            if hasattr(edge_agtype, "value")
                            else str(edge_agtype),
                        }
                    )

        except Exception as e:
            logger.error(f"[EXPORT GRAPH - EDGES] Exception: {e}", exc_info=True)
            raise RuntimeError(f"[EXPORT GRAPH - EDGES] Exception: {e}") from e

        return {"nodes": nodes, "edges": edges}

    @timed
    def count_nodes(self, scope: str, user_name: str | None = None) -> int:
        user_name = user_name if user_name else self.config.user_name

        query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (n:Memory)
                WHERE n.memory_type = '{scope}' 
                AND n.user_name = '{user_name}'
                RETURN count(n)
            $$) AS (count agtype)
        """

        result = self.execute_query(query)
        return int(result.one_or_none()["count"].value)

    @timed
    def get_all_memory_items(
        self, scope: str, include_embedding: bool = False, user_name: str | None = None
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        user_name = user_name if user_name else self._get_config_value("user_name")
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        # Use cypher query to retrieve memory items
        if include_embedding:
            cypher_query = f"""
                   WITH t as (
                       SELECT * FROM cypher('{self.db_name}_graph', $$
                       MATCH (n:Memory)
                       WHERE n.memory_type = '{scope}' AND n.user_name = '{user_name}'
                       RETURN id(n) as id1,n
                       LIMIT 100
                       $$) AS (id1 agtype,n agtype)
                   )
                   SELECT 
                       m.embedding, 
                       t.n
                   FROM t,
                        {self.db_name}_graph."Memory" m
                   WHERE t.id1 = m.id;
                   """
            nodes = []
            node_ids = set()
            print("[get_all_memory_items embedding true ] cypher_query:", cypher_query)
            try:
                with self.connection.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
                        """
                        if isinstance(row, (list, tuple)) and len(row) >= 2:
                        """
                        if isinstance(row, list | tuple) and len(row) >= 2:
                            embedding_val, node_val = row[0], row[1]
                        else:
                            embedding_val, node_val = None, row[0]

                        node = self._build_node_from_agtype(node_val, embedding_val)
                        if node:
                            node_id = node["id"]
                            if node_id not in node_ids:
                                nodes.append(node)
                                node_ids.add(node_id)

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)

            return nodes
        else:
            cypher_query = f"""
                   SELECT * FROM cypher('{self.db_name}_graph', $$
                   MATCH (n:Memory)
                   WHERE n.memory_type = '{scope}' AND n.user_name = '{user_name}'
                   RETURN properties(n) as props
                   LIMIT 100
                   $$) AS (nprops agtype)
               """
            print("[get_all_memory_items embedding false ] cypher_query:", cypher_query)

            nodes = []
            try:
                with self.connection.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
                        """
                        if isinstance(row[0], str):
                            memory_data = json.loads(row[0])
                        else:
                            memory_data = row[0]  # 如果已经是字典，直接使用
                        nodes.append(self._parse_node(memory_data))
                        """
                        memory_data = json.loads(row[0]) if isinstance(row[0], str) else row[0]
                        nodes.append(self._parse_node(memory_data))

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)

            return nodes

    def get_all_memory_items_old(
        self, scope: str, include_embedding: bool = False, user_name: str | None = None
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        user_name = user_name if user_name else self._get_config_value("user_name")
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        # Use cypher query to retrieve memory items
        if include_embedding:
            cypher_query = f"""
                WITH t as (
                    SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH (n:Memory)
                    WHERE n.memory_type = '{scope}' AND n.user_name = '{user_name}'
                    RETURN id(n) as id1,n
                    LIMIT 100
                    $$) AS (id1 agtype,n agtype)
                )
                SELECT 
                    m.embedding, 
                    t.n
                FROM t,
                     {self.db_name}_graph."Memory" m
                WHERE t.id1 = m.id;
                """
        else:
            cypher_query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                MATCH (n:Memory)
                WHERE n.memory_type = '{scope}' AND n.user_name = '{user_name}'
                RETURN properties(n) as props
                LIMIT 100
                $$) AS (nprops agtype)
            """
            print("[get_all_memory_items] cypher_query:", cypher_query)

            nodes = []
            try:
                with self.connection.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()
                    print("[get_all_memory_items] results:", results)

                    for row in results:
                        node_agtype = row[0]

                        # Handle string-formatted data
                        if isinstance(node_agtype, str):
                            try:
                                # Remove ::vertex suffix
                                json_str = node_agtype.replace("::vertex", "")
                                node_data = json.loads(json_str)

                                if isinstance(node_data, dict) and "properties" in node_data:
                                    properties = node_data["properties"]
                                    # Build node data
                                    parsed_node_data = {
                                        "id": properties.get("id", ""),
                                        "memory": properties.get("memory", ""),
                                        "metadata": properties,
                                    }

                                    if include_embedding and "embedding" in properties:
                                        parsed_node_data["embedding"] = properties["embedding"]

                                    nodes.append(self._parse_node(parsed_node_data))
                                    print(
                                        f"[get_all_memory_items] ✅ Parsed node successfully: {properties.get('id', '')}"
                                    )
                                else:
                                    print(
                                        f"[get_all_memory_items] ❌ Invalid node data format: {node_data}"
                                    )

                            except (json.JSONDecodeError, TypeError) as e:
                                print(f"[get_all_memory_items] ❌ JSON parsing failed: {e}")
                        elif node_agtype and hasattr(node_agtype, "value"):
                            # Handle agtype object
                            node_props = node_agtype.value
                            if isinstance(node_props, dict):
                                # Parse node properties
                                node_data = {
                                    "id": node_props.get("id", ""),
                                    "memory": node_props.get("memory", ""),
                                    "metadata": node_props,
                                }

                                if include_embedding and "embedding" in node_props:
                                    node_data["embedding"] = node_props["embedding"]

                                nodes.append(self._parse_node(node_data))
                                print(
                                    f"[get_all_memory_items] ✅ Parsed agtype node successfully: {node_props.get('id', '')}"
                                )
                        else:
                            print(
                                f"[get_all_memory_items] ❌ Unknown data format: {type(node_agtype)}"
                            )

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)

            return nodes

    @timed
    def get_structure_optimization_candidates(
        self, scope: str, include_embedding: bool = False, user_name: str | None = None
    ) -> list[dict]:
        """
        Find nodes that are likely candidates for structure optimization:
        - Isolated nodes, nodes with empty background, or nodes with exactly one child.
        - Plus: the child of any parent node that has exactly one child.
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build return fields based on include_embedding flag
        if include_embedding:
            return_fields = "id(n) as id1,n"
            return_fields_agtype = " id1 agtype,n agtype"
        else:
            # Build field list without embedding
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
                    "n.graph_id as graph_id",
                ]
            )
            fields = [
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
                "graph_id",
            ]
            return_fields_agtype = ", ".join([f"{field} agtype" for field in fields])

        # Use OPTIONAL MATCH to find isolated nodes (no parents or children)
        cypher_query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
            MATCH (n:Memory)
            WHERE n.memory_type = '{scope}'
              AND n.status = 'activated'
              AND n.user_name = '{user_name}'
            OPTIONAL MATCH (n)-[:PARENT]->(c:Memory)
            OPTIONAL MATCH (p:Memory)-[:PARENT]->(n)
            WITH n, c, p
            WHERE c IS NULL AND p IS NULL
            RETURN {return_fields}
            $$) AS ({return_fields_agtype})
        """
        if include_embedding:
            cypher_query = f"""
                    WITH t as (
                        {cypher_query}
                    )
                        SELECT 
                        m.embedding, 
                        t.n
                        FROM t,
                             {self.db_name}_graph."Memory" m
                        WHERE t.id1 = m.id
                    """
        print("[get_structure_optimization_candidates] query:", cypher_query)

        candidates = []
        node_ids = set()
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(cypher_query)
                results = cursor.fetchall()
                print("result------", len(results))
                for row in results:
                    if include_embedding:
                        # When include_embedding=True, return full node object
                        """
                        if isinstance(row, (list, tuple)) and len(row) >= 2:
                        """
                        if isinstance(row, list | tuple) and len(row) >= 2:
                            embedding_val, node_val = row[0], row[1]
                        else:
                            embedding_val, node_val = None, row[0]

                        node = self._build_node_from_agtype(node_val, embedding_val)
                        if node:
                            node_id = node["id"]
                            if node_id not in node_ids:
                                candidates.append(node)
                                node_ids.add(node_id)
                    else:
                        # When include_embedding=False, return field dictionary
                        # Define field names matching the RETURN clause
                        field_names = [
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
                            "graph_id",
                        ]

                        # Convert row to dictionary
                        node_data = {}
                        for i, field_name in enumerate(field_names):
                            if i < len(row):
                                value = row[i]
                                # Handle special fields
                                if field_name in ["tags", "sources", "usage"] and isinstance(
                                    value, str
                                ):
                                    try:
                                        # Try parsing JSON string
                                        node_data[field_name] = json.loads(value)
                                    except (json.JSONDecodeError, TypeError):
                                        node_data[field_name] = value
                                else:
                                    node_data[field_name] = value

                        # Parse node using _parse_node_new
                        try:
                            node = self._parse_node_new(node_data)
                            node_id = node["id"]

                            if node_id not in node_ids:
                                candidates.append(node)
                                node_ids.add(node_id)
                                print(f"✅ Parsed node successfully: {node_id}")
                        except Exception as e:
                            print(f"❌ Failed to parse node: {e}")

        except Exception as e:
            logger.error(f"Failed to get structure optimization candidates: {e}", exc_info=True)

        return candidates

    def drop_database(self) -> None:
        """Permanently delete the entire graph this instance is using."""
        return
        if self._get_config_value("use_multi_db", True):
            with self.connection.cursor() as cursor:
                cursor.execute(f"SELECT drop_graph('{self.db_name}_graph', true)")
                print(f"Graph '{self.db_name}_graph' has been dropped.")
        else:
            raise ValueError(
                f"Refusing to drop graph '{self.db_name}_graph' in "
                f"Shared Database Multi-Tenant mode"
            )

    def _parse_node(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """Parse node data from database format to standard format."""
        node = node_data.copy()

        # Convert datetime to string
        for time_field in ("created_at", "updated_at"):
            if time_field in node and hasattr(node[time_field], "isoformat"):
                node[time_field] = node[time_field].isoformat()

        return {"id": node.get("id"), "memory": node.get("memory", ""), "metadata": node}

    def _parse_node_new(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """Parse node data from database format to standard format."""
        node = node_data.copy()

        # Normalize string values that may arrive as quoted literals (e.g., '"abc"')
        def _strip_wrapping_quotes(value: Any) -> Any:
            """
            if isinstance(value, str) and len(value) >= 2:
                if value[0] == value[-1] and value[0] in ("'", '"'):
                    return value[1:-1]
            return value
            """
            if (
                isinstance(value, str)
                and len(value) >= 2
                and value[0] == value[-1]
                and value[0] in ("'", '"')
            ):
                return value[1:-1]
            return value

        for k, v in list(node.items()):
            if isinstance(v, str):
                node[k] = _strip_wrapping_quotes(v)

        # Convert datetime to string
        for time_field in ("created_at", "updated_at"):
            if time_field in node and hasattr(node[time_field], "isoformat"):
                node[time_field] = node[time_field].isoformat()

        # Do not remove user_name; keep all fields

        return {"id": node.pop("id"), "memory": node.pop("memory", ""), "metadata": node}

    def __del__(self):
        """Close database connection when object is destroyed."""
        if hasattr(self, "connection") and self.connection:
            self.connection.close()

    @timed
    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Add a memory node to the graph."""
        # user_name comes from metadata; fallback to config if missing
        metadata["user_name"] = user_name if user_name else self.config.user_name

        # Safely process metadata
        metadata = _prepare_node_metadata(metadata)

        # Merge node and set metadata
        created_at = metadata.pop("created_at", datetime.utcnow().isoformat())
        updated_at = metadata.pop("updated_at", datetime.utcnow().isoformat())

        # Prepare properties
        properties = {
            "id": id,
            "memory": memory,
            "created_at": created_at,
            "updated_at": updated_at,
            **metadata,
        }

        # Generate embedding if not provided
        if "embedding" not in properties or not properties["embedding"]:
            properties["embedding"] = generate_vector(
                self._get_config_value("embedding_dimension", 1024)
            )

        # serialization - JSON-serialize sources and usage fields
        for field_name in ["sources", "usage"]:
            if properties.get(field_name):
                if isinstance(properties[field_name], list):
                    for idx in range(len(properties[field_name])):
                        # Serialize only when element is not a string
                        if not isinstance(properties[field_name][idx], str):
                            properties[field_name][idx] = json.dumps(properties[field_name][idx])
                elif isinstance(properties[field_name], str):
                    # If already a string, leave as-is
                    pass

        # Extract embedding for separate column
        embedding_vector = properties.pop("embedding", [])
        if not isinstance(embedding_vector, list):
            embedding_vector = []

        # Select column name based on embedding dimension
        embedding_column = "embedding"  # default column
        if len(embedding_vector) == 3072:
            embedding_column = "embedding_3072"
        elif len(embedding_vector) == 1024:
            embedding_column = "embedding"
        elif len(embedding_vector) == 768:
            embedding_column = "embedding_768"

        with self.connection.cursor() as cursor:
            # Delete existing record first (if any)
            delete_query = f"""
                DELETE FROM {self.db_name}_graph."Memory" 
                WHERE id = ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring)
            """
            cursor.execute(delete_query, (id,))
            #
            get_graph_id_query = f"""
                              SELECT ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring)
                          """
            cursor.execute(get_graph_id_query, (id,))
            graph_id = cursor.fetchone()[0]
            properties["graph_id"] = str(graph_id)

            # Then insert new record
            if embedding_vector:
                insert_query = f"""
                    INSERT INTO {self.db_name}_graph."Memory"(id, properties, {embedding_column})
                    VALUES (
                        ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring),
                        %s,
                        %s
                    )
                """
                cursor.execute(
                    insert_query, (id, json.dumps(properties), json.dumps(embedding_vector))
                )
            else:
                insert_query = f"""
                    INSERT INTO {self.db_name}_graph."Memory"(id, properties)
                    VALUES (
                        ag_catalog._make_graph_id('{self.db_name}_graph'::name, 'Memory'::name, %s::text::cstring),
                        %s
                    )
                """
                cursor.execute(insert_query, (id, json.dumps(properties)))
                logger.info(f"Added node {id} to graph '{self.db_name}_graph'.")

    def _build_node_from_agtype(self, node_agtype, embedding=None):
        """
        Parse the cypher-returned column `n` (agtype or JSON string)
        into a standard node and merge embedding into properties.
        """
        try:
            # String case: '{"id":...,"label":[...],"properties":{...}}::vertex'
            if isinstance(node_agtype, str):
                json_str = node_agtype.replace("::vertex", "")
                obj = json.loads(json_str)
                if not (isinstance(obj, dict) and "properties" in obj):
                    return None
                props = obj["properties"]
            # agtype case: has `value` attribute
            elif node_agtype and hasattr(node_agtype, "value"):
                val = node_agtype.value
                if not (isinstance(val, dict) and "properties" in val):
                    return None
                props = val["properties"]
            else:
                return None

            if embedding is not None:
                props["embedding"] = embedding

            # Return standard format directly
            return {"id": props.get("id", ""), "memory": props.get("memory", ""), "metadata": props}
        except Exception:
            return None

    @timed
    def get_neighbors_by_tag(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of dicts with node details and overlap count.
        """
        if not tags:
            return []

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build query conditions - more relaxed filters
        where_clauses = []
        params = []

        # Exclude specified IDs - use id in properties
        if exclude_ids:
            exclude_conditions = []
            for exclude_id in exclude_ids:
                exclude_conditions.append(
                    "ag_catalog.agtype_access_operator(properties, '\"id\"'::agtype) != %s::agtype"
                )
                params.append(f'"{exclude_id}"')
            where_clauses.append(f"({' AND '.join(exclude_conditions)})")

        # Status filter - keep only 'activated'
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"status\"'::agtype) = '\"activated\"'::agtype"
        )

        # Type filter - exclude 'reasoning' type
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"node_type\"'::agtype) != '\"reasoning\"'::agtype"
        )

        # User filter
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"user_name\"'::agtype) = %s::agtype"
        )
        params.append(f'"{user_name}"')

        # Testing showed no data; annotate.
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties, '\"memory_type\"'::agtype) != '\"WorkingMemory\"'::agtype"
        )

        where_clause = " AND ".join(where_clauses)

        # Fetch all candidate nodes
        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory" 
            WHERE {where_clause}
        """

        print(f"[get_neighbors_by_tag] query: {query}, params: {params}")

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, params)
                results = cursor.fetchall()

                nodes_with_overlap = []
                for row in results:
                    node_id, properties_json, embedding_json = row
                    properties = properties_json if properties_json else {}

                    # Parse embedding
                    if include_embedding and embedding_json is not None:
                        try:
                            embedding = (
                                json.loads(embedding_json)
                                if isinstance(embedding_json, str)
                                else embedding_json
                            )
                            properties["embedding"] = embedding
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse embedding for node {node_id}")

                    # Compute tag overlap
                    node_tags = properties.get("tags", [])
                    if isinstance(node_tags, str):
                        try:
                            node_tags = json.loads(node_tags)
                        except (json.JSONDecodeError, TypeError):
                            node_tags = []

                    overlap_tags = [tag for tag in tags if tag in node_tags]
                    overlap_count = len(overlap_tags)

                    if overlap_count >= min_overlap:
                        node_data = self._parse_node(
                            {
                                "id": properties.get("id", node_id),
                                "memory": properties.get("memory", ""),
                                "metadata": properties,
                            }
                        )
                        nodes_with_overlap.append((node_data, overlap_count))

                # Sort by overlap count and return top_k items
                nodes_with_overlap.sort(key=lambda x: x[1], reverse=True)
                return [node for node, _ in nodes_with_overlap[:top_k]]

        except Exception as e:
            logger.error(f"Failed to get neighbors by tag: {e}", exc_info=True)
            return []

    def get_neighbors_by_tag_ccl(
        self,
        tags: list[str],
        exclude_ids: list[str],
        top_k: int = 5,
        min_overlap: int = 1,
        include_embedding: bool = False,
        user_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Find top-K neighbor nodes with maximum tag overlap.

        Args:
            tags: The list of tags to match.
            exclude_ids: Node IDs to exclude (e.g., local cluster).
            top_k: Max number of neighbors to return.
            min_overlap: Minimum number of overlapping tags required.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of dicts with node details and overlap count.
        """
        if not tags:
            return []

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build query conditions; keep consistent with nebular.py
        where_clauses = [
            'n.status = "activated"',
            'NOT (n.node_type = "reasoning")',
            'NOT (n.memory_type = "WorkingMemory")',
        ]
        where_clauses = [
            'n.status = "activated"',
            'NOT (n.memory_type = "WorkingMemory")',
        ]

        if exclude_ids:
            exclude_ids_str = "[" + ", ".join(f'"{id}"' for id in exclude_ids) + "]"
            where_clauses.append(f"NOT (n.id IN {exclude_ids_str})")

        where_clauses.append(f'n.user_name = "{user_name}"')

        where_clause = " AND ".join(where_clauses)
        tag_list_literal = "[" + ", ".join(f'"{t}"' for t in tags) + "]"

        return_fields = [
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
            "n.background AS background",
        ]

        if include_embedding:
            return_fields.append("n.embedding AS embedding")

        return_fields_str = ", ".join(return_fields)
        result_fields = []
        for field in return_fields:
            # Extract field name 'id' from 'n.id AS id'
            field_name = field.split(" AS ")[-1]
            result_fields.append(f"{field_name} agtype")

        # Add overlap_count
        result_fields.append("overlap_count agtype")
        result_fields_str = ", ".join(result_fields)
        # Use Cypher query; keep consistent with nebular.py
        query = f"""
            SELECT * FROM (
                SELECT * FROM cypher('{self.db_name}_graph', $$
                WITH {tag_list_literal} AS tag_list
                MATCH (n:Memory)
                WHERE {where_clause}
                RETURN {return_fields_str},
                       size([tag IN n.tags WHERE tag IN tag_list]) AS overlap_count
                $$) AS ({result_fields_str})
            ) AS subquery
            ORDER BY (overlap_count::integer) DESC
            LIMIT {top_k}
        """
        print("get_neighbors_by_tag:", query)
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                neighbors = []
                for row in results:
                    # Parse results
                    props = {}
                    overlap_count = None

                    # Manually parse each field
                    field_names = [
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
                        "background",
                    ]

                    if include_embedding:
                        field_names.append("embedding")
                    field_names.append("overlap_count")

                    for i, field in enumerate(field_names):
                        if field == "overlap_count":
                            overlap_count = row[i].value if hasattr(row[i], "value") else row[i]
                        else:
                            props[field] = row[i].value if hasattr(row[i], "value") else row[i]
                    overlap_int = int(overlap_count)
                    if overlap_count is not None and overlap_int >= min_overlap:
                        parsed = self._parse_node(props)
                        parsed["overlap_count"] = overlap_int
                        neighbors.append(parsed)

                # Sort by overlap count
                neighbors.sort(key=lambda x: x["overlap_count"], reverse=True)
                neighbors = neighbors[:top_k]

                # Remove overlap_count field
                result = []
                for neighbor in neighbors:
                    neighbor.pop("overlap_count", None)
                    result.append(neighbor)

                return result

        except Exception as e:
            logger.error(f"Failed to get neighbors by tag: {e}", exc_info=True)
            return []

    @timed
    def import_graph(self, data: dict[str, Any], user_name: str | None = None) -> None:
        """
        Import the entire graph from a serialized dictionary.

        Args:
            data: A dictionary containing all nodes and edges to be loaded.
            user_name (str, optional): User name for filtering in non-multi-db mode
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        # Import nodes
        for node in data.get("nodes", []):
            try:
                id, memory, metadata = _compose_node(node)
                metadata["user_name"] = user_name
                metadata = _prepare_node_metadata(metadata)
                metadata.update({"id": id, "memory": memory})

                # Use add_node to insert node
                self.add_node(id, memory, metadata)

            except Exception as e:
                logger.error(f"Fail to load node: {node}, error: {e}")

        # Import edges
        for edge in data.get("edges", []):
            try:
                source_id, target_id = edge["source"], edge["target"]
                edge_type = edge["type"]

                # Use add_edge to insert edge
                self.add_edge(source_id, target_id, edge_type, user_name)

            except Exception as e:
                logger.error(f"Fail to load edge: {edge}, error: {e}")

    @timed
    def get_edges(
        self, id: str, type: str = "ANY", direction: str = "ANY", user_name: str | None = None
    ) -> list[dict[str, str]]:
        """
        Get edges connected to a node, with optional type and direction filter.

        Args:
            id: Node ID to retrieve edges for.
            type: Relationship type to match, or 'ANY' to match all.
            direction: 'OUTGOING', 'INCOMING', or 'ANY'.
            user_name (str, optional): User name for filtering in non-multi-db mode

        Returns:
            List of edges:
            [
              {"from": "source_id", "to": "target_id", "type": "RELATE"},
              ...
            ]
        """
        user_name = user_name if user_name else self._get_config_value("user_name")

        if direction == "OUTGOING":
            pattern = f"(a:Memory)-[r]->(b:Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "INCOMING":
            pattern = f"(a:Memory)<-[r]-(b:Memory)"
            where_clause = f"a.id = '{id}'"
        elif direction == "ANY":
            pattern = f"(a:Memory)-[r]-(b:Memory)"
            where_clause = f"a.id = '{id}' OR b.id = '{id}'"
        else:
            raise ValueError("Invalid direction. Must be 'OUTGOING', 'INCOMING', or 'ANY'.")

        # Add type filter
        if type != "ANY":
            where_clause += f" AND type(r) = '{type}'"

        # Add user filter
        where_clause += f" AND a.user_name = '{user_name}' AND b.user_name = '{user_name}'"

        query = f"""
            SELECT * FROM cypher('{self.db_name}_graph', $$
            MATCH {pattern}
            WHERE {where_clause}
            RETURN a.id AS from_id, b.id AS to_id, type(r) AS edge_type
            $$) AS (from_id agtype, to_id agtype, edge_type agtype)
        """

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                edges = []
                for row in results:
                    from_id = row[0].value if hasattr(row[0], "value") else row[0]
                    to_id = row[1].value if hasattr(row[1], "value") else row[1]
                    edge_type = row[2].value if hasattr(row[2], "value") else row[2]

                    edges.append({"from": from_id, "to": to_id, "type": edge_type})
                return edges

        except Exception as e:
            logger.error(f"Failed to get edges: {e}", exc_info=True)
            return []
