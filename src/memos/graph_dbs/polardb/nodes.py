import json
import time

from datetime import datetime
from typing import Any

from memos.graph_dbs.polardb.helpers import generate_vector
from memos.graph_dbs.utils import prepare_node_metadata as _prepare_node_metadata
from memos.log import get_logger
from memos.utils import timed


logger = get_logger(__name__)


class NodeMixin:
    """Mixin for node (memory) CRUD operations."""

    @timed
    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        """Add a memory node to the graph."""
        logger.info(f"[add_node] id: {id}, memory: {memory}, metadata: {metadata}")

        # user_name comes from metadata; fallback to config if missing
        metadata["user_name"] = user_name if user_name else self.config.user_name

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
            "delete_time": "",
            "delete_record_id": "",
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

        conn = None
        insert_query = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Delete existing record first (if any)
                delete_query = f"""
                    DELETE FROM {self.db_name}_graph."Memory"
                    WHERE id = %s
                """
                cursor.execute(delete_query, (id,))
                properties["graph_id"] = str(id)

                # Then insert new record
                if embedding_vector:
                    insert_query = f"""
                        INSERT INTO {self.db_name}_graph."Memory"(id, properties, {embedding_column})
                        VALUES (
                            %s,
                            %s,
                            %s
                        )
                    """
                    cursor.execute(
                        insert_query, (id, json.dumps(properties), json.dumps(embedding_vector))
                    )
                    logger.info(
                        f"[add_node] [embedding_vector-true] insert_query: {insert_query}, properties: {json.dumps(properties)}"
                    )
                else:
                    insert_query = f"""
                        INSERT INTO {self.db_name}_graph."Memory"(id, properties)
                        VALUES (
                            %s,
                            %s
                        )
                    """
                    cursor.execute(insert_query, (id, json.dumps(properties)))
                    logger.info(
                        f"[add_node] [embedding_vector-false] insert_query: {insert_query}, properties: {json.dumps(properties)}"
                    )
        except Exception as e:
            logger.error(f"[add_node] Failed to add node: {e}", exc_info=True)
            raise
        finally:
            if insert_query:
                logger.info(f"In add node polardb: id-{id} memory-{memory} query-{insert_query}")
            self._return_connection(conn)

    @timed
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
        batch_start_time = time.time()
        if not nodes:
            logger.warning("[add_nodes_batch] Empty nodes list, skipping")
            return

        logger.info(f"[add_nodes_batch] Processing only first node (total nodes: {len(nodes)})")

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

                # Set user_name in metadata
                metadata["user_name"] = effective_user_name

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
                    "delete_time": "",
                    "delete_record_id": "",
                    **metadata,
                }

                # Generate embedding if not provided
                if "embedding" not in properties or not properties["embedding"]:
                    properties["embedding"] = generate_vector(
                        self._get_config_value("embedding_dimension", 1024)
                    )

                # Serialization - JSON-serialize sources and usage fields
                for field_name in ["sources", "usage"]:
                    if properties.get(field_name):
                        if isinstance(properties[field_name], list):
                            for idx in range(len(properties[field_name])):
                                # Serialize only when element is not a string
                                if not isinstance(properties[field_name][idx], str):
                                    properties[field_name][idx] = json.dumps(
                                        properties[field_name][idx]
                                    )
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

                prepared_nodes.append(
                    {
                        "id": id,
                        "memory": memory,
                        "properties": properties,
                        "embedding_vector": embedding_vector,
                        "embedding_column": embedding_column,
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

        # Group nodes by embedding column to optimize batch inserts
        nodes_by_embedding_column = {}
        for node in prepared_nodes:
            col = node["embedding_column"]
            if col not in nodes_by_embedding_column:
                nodes_by_embedding_column[col] = []
            nodes_by_embedding_column[col].append(node)

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Process each group separately
                for embedding_column, nodes_group in nodes_by_embedding_column.items():
                    # Batch delete existing records using IN clause
                    ids_to_delete = [node["id"] for node in nodes_group]
                    if ids_to_delete:
                        delete_query = f"""
                            DELETE FROM {self.db_name}_graph."Memory"
                            WHERE id = ANY(%s::text[])
                        """
                        cursor.execute(delete_query, (ids_to_delete,))

                    # Set graph_id in properties (using text ID directly)
                    for node in nodes_group:
                        node["properties"]["graph_id"] = str(node["id"])

                    # Use PREPARE/EXECUTE for efficient batch insert
                    # Generate unique prepare statement name to avoid conflicts
                    prepare_name = f"insert_mem_{embedding_column or 'no_embedding'}_{int(time.time() * 1000000)}"

                    try:
                        if embedding_column and any(
                            node["embedding_vector"] for node in nodes_group
                        ):
                            # PREPARE statement for insert with embedding
                            prepare_query = f"""
                                PREPARE {prepare_name} AS
                                INSERT INTO {self.db_name}_graph."Memory"(id, properties, {embedding_column})
                                VALUES (
                                    $1,
                                    $2::jsonb,
                                    $3::vector
                                )
                            """
                            logger.info(
                                f"[add_nodes_batch] embedding Preparing prepare_name: {prepare_name}"
                            )
                            logger.info(
                                f"[add_nodes_batch] embedding Preparing prepare_query: {prepare_query}"
                            )

                            cursor.execute(prepare_query)

                            # Execute prepared statement for each node
                            for node in nodes_group:
                                properties_json = json.dumps(node["properties"])
                                embedding_json = (
                                    json.dumps(node["embedding_vector"])
                                    if node["embedding_vector"]
                                    else None
                                )

                                cursor.execute(
                                    f"EXECUTE {prepare_name}(%s, %s, %s)",
                                    (node["id"], properties_json, embedding_json),
                                )
                        else:
                            # PREPARE statement for insert without embedding
                            prepare_query = f"""
                                PREPARE {prepare_name} AS
                                INSERT INTO {self.db_name}_graph."Memory"(id, properties)
                                VALUES (
                                    $1,
                                    $2::jsonb
                                )
                            """
                            logger.info(
                                f"[add_nodes_batch] without embedding Preparing prepare_name: {prepare_name}"
                            )
                            logger.info(
                                f"[add_nodes_batch] without embedding Preparing prepare_query: {prepare_query}"
                            )
                            cursor.execute(prepare_query)

                            # Execute prepared statement for each node
                            for node in nodes_group:
                                properties_json = json.dumps(node["properties"])

                                cursor.execute(
                                    f"EXECUTE {prepare_name}(%s, %s)", (node["id"], properties_json)
                                )
                    finally:
                        # DEALLOCATE prepared statement (always execute, even on error)
                        try:
                            cursor.execute(f"DEALLOCATE {prepare_name}")
                            logger.info(
                                f"[add_nodes_batch] Deallocated prepared statement: {prepare_name}"
                            )
                        except Exception as dealloc_error:
                            logger.warning(
                                f"[add_nodes_batch] Failed to deallocate {prepare_name}: {dealloc_error}"
                            )

                    logger.info(
                        f"[add_nodes_batch] Inserted {len(nodes_group)} nodes with embedding_column={embedding_column}"
                    )
                    elapsed_time = time.time() - batch_start_time
                    logger.info(
                        f"[add_nodes_batch] PREPARE/EXECUTE batch insert completed successfully in {elapsed_time:.2f}s"
                    )

        except Exception as e:
            logger.error(f"[add_nodes_batch] Failed to add nodes: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

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
        logger.info(
            f"polardb [get_node] id: {id}, include_embedding: {include_embedding}, user_name: {user_name}"
        )
        start_time = time.time()
        select_fields = "id, properties, embedding" if include_embedding else "id, properties"

        query = f"""
            SELECT {select_fields}
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) = %s::agtype
        """
        params = [self.format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        logger.info(f"polardb [get_node] query: {query},params: {params}")
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()

                if result:
                    if include_embedding:
                        _, properties_json, embedding_json = result
                    else:
                        _, properties_json = result
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

                    elapsed_time = time.time() - start_time
                    logger.info(
                        f" polardb [get_node] get_node completed time in {elapsed_time:.2f}s"
                    )
                    return self._parse_node(
                        {
                            "id": id,
                            "memory": properties.get("memory", ""),
                            **properties,
                        }
                    )
                return None

        except Exception as e:
            logger.error(f"[get_node] Failed to retrieve node '{id}': {e}", exc_info=True)
            return None
        finally:
            self._return_connection(conn)

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
        logger.info(f"get_nodes ids:{ids},user_name:{user_name}")
        if not ids:
            return []

        # Build WHERE clause using IN operator with agtype array
        # Use ANY operator with array for better performance
        placeholders = ",".join(["%s"] * len(ids))
        params = [self.format_param_value(id_val) for id_val in ids]

        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '\"id\"'::agtype) = ANY(ARRAY[{placeholders}]::agtype[])
        """

        # Only add user_name filter if provided
        if user_name is not None:
            query += " AND ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        logger.info(f"get_nodes query:{query},params:{params}")

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
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
                    if embedding_json is not None and kwargs.get("include_embedding"):
                        try:
                            # remove embedding
                            embedding = (
                                json.loads(embedding_json)
                                if isinstance(embedding_json, str)
                                else embedding_json
                            )
                            properties["embedding"] = embedding
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
        finally:
            self._return_connection(conn)

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
                WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) = %s::agtype
            """
            params = [
                json.dumps(properties),
                json.dumps(embedding_vector),
                self.format_param_value(id),
            ]
        else:
            query = f"""
                UPDATE "{self.db_name}_graph"."Memory"
                SET properties = %s
                WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) = %s::agtype
            """
            params = [json.dumps(properties), self.format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
        except Exception as e:
            logger.error(f"[update_node] Failed to update node '{id}': {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

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
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"id"'::agtype) = %s::agtype
        """
        params = [self.format_param_value(id)]

        # Only add user filter when user_name is provided
        if user_name is not None:
            query += "\nAND ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
            params.append(self.format_param_value(user_name))

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
        except Exception as e:
            logger.error(f"[delete_node] Failed to delete node '{id}': {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    def _parse_node(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """Parse node data from database format to standard format."""
        node = node_data.copy()

        # Strip wrapping quotes from agtype string values (idempotent)
        for k, v in list(node.items()):
            if isinstance(v, str) and len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                node[k] = v[1:-1]

        # Convert datetime to string
        for time_field in ("created_at", "updated_at"):
            if time_field in node and hasattr(node[time_field], "isoformat"):
                node[time_field] = node[time_field].isoformat()

        # Deserialize sources from JSON strings back to dict objects
        if "sources" in node and node.get("sources"):
            sources = node["sources"]
            if isinstance(sources, list):
                deserialized_sources = []
                for source_item in sources:
                    if isinstance(source_item, str):
                        try:
                            parsed = json.loads(source_item)
                            deserialized_sources.append(parsed)
                        except (json.JSONDecodeError, TypeError):
                            deserialized_sources.append({"type": "doc", "content": source_item})
                    elif isinstance(source_item, dict):
                        deserialized_sources.append(source_item)
                    else:
                        deserialized_sources.append({"type": "doc", "content": str(source_item)})
                node["sources"] = deserialized_sources

        return {"id": node.pop("id", None), "memory": node.pop("memory", ""), "metadata": node}

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
                if isinstance(embedding, str):
                    try:
                        embedding = json.loads(embedding)
                    except (json.JSONDecodeError, TypeError):
                        logger.warning("Failed to parse embedding for node")
                props["embedding"] = embedding

            return self._parse_node(props)
        except Exception:
            return None

    def format_param_value(self, value: str | None) -> str:
        """Format parameter value to handle both quoted and unquoted formats"""
        # Handle None value
        if value is None:
            logger.warning("format_param_value: value is None")
            return "null"

        # Remove outer quotes if they exist
        if value.startswith('"') and value.endswith('"'):
            # Already has double quotes, return as is
            return value
        else:
            # Add double quotes
            return f'"{value}"'
