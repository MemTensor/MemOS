import copy
import json
import time
from typing import Any

from memos.graph_dbs.utils import compose_node as _compose_node, prepare_node_metadata as _prepare_node_metadata
from memos.log import get_logger
from memos.utils import timed

logger = get_logger(__name__)


class MaintenanceMixin:
    """Mixin for maintenance operations (import/export, clear, cleanup)."""

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
    def export_graph(
        self,
        include_embedding: bool = False,
        user_name: str | None = None,
        user_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        filter: dict | None = None,
        **kwargs,
    ) -> dict[str, Any]:
        """
        Export all graph nodes and edges in a structured form.
        Args:
        include_embedding (bool): Whether to include the large embedding field.
        user_name (str, optional): User name for filtering in non-multi-db mode
        user_id (str, optional): User ID for filtering
        page (int, optional): Page number (starts from 1). If None, exports all data without pagination.
        page_size (int, optional): Number of items per page. If None, exports all data without pagination.
        filter (dict, optional): Filter dictionary for metadata filtering. Supports "and", "or" logic and operators:
            - "=": equality
            - "in": value in list
            - "contains": array contains value
            - "gt", "lt", "gte", "lte": comparison operators
            - "like": fuzzy matching
            Example: {"and": [{"created_at": {"gte": "2025-01-01"}}, {"tags": {"contains": "AI"}}]}

        Returns:
            {
                "nodes": [ { "id": ..., "memory": ..., "metadata": {...} }, ... ],
                "edges": [ { "source": ..., "target": ..., "type": ... }, ... ],
                "total_nodes": int,  # Total number of nodes matching the filter criteria
                "total_edges": int,   # Total number of edges matching the filter criteria
            }
        """
        logger.info(
            f"[export_graph] include_embedding: {include_embedding}, user_name: {user_name}, user_id: {user_id}, page: {page}, page_size: {page_size}, filter: {filter}"
        )
        user_id = user_id if user_id else self._get_config_value("user_id")

        # Initialize total counts
        total_nodes = 0
        total_edges = 0

        # Determine if pagination is needed
        use_pagination = page is not None and page_size is not None

        # Validate pagination parameters if pagination is enabled
        if use_pagination:
            if page < 1:
                page = 1
            if page_size < 1:
                page_size = 10
            offset = (page - 1) * page_size
        else:
            offset = None

        conn = None
        try:
            conn = self._get_connection()
            # Build WHERE conditions
            where_conditions = []
            if user_name:
                where_conditions.append(
                    f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype"
                )
            if user_id:
                where_conditions.append(
                    f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_id\"'::agtype) = '\"{user_id}\"'::agtype"
                )

            # Build filter conditions using common method
            filter_conditions = self._build_filter_conditions_sql(filter)
            logger.info(f"[export_graph] filter_conditions: {filter_conditions}")
            if filter_conditions:
                where_conditions.extend(filter_conditions)

            where_clause = ""
            if where_conditions:
                where_clause = f"WHERE {' AND '.join(where_conditions)}"

            # Get total count of nodes before pagination
            count_node_query = f"""
                SELECT COUNT(*)
                FROM "{self.db_name}_graph"."Memory"
                {where_clause}
            """
            logger.info(f"[export_graph nodes count] Query: {count_node_query}")
            with conn.cursor() as cursor:
                cursor.execute(count_node_query)
                total_nodes = cursor.fetchone()[0]

            # Export nodes
            # Build pagination clause if needed
            pagination_clause = ""
            if use_pagination:
                pagination_clause = f"LIMIT {page_size} OFFSET {offset}"

            if include_embedding:
                node_query = f"""
                    SELECT id, properties, embedding
                    FROM "{self.db_name}_graph"."Memory"
                    {where_clause}
                    ORDER BY ag_catalog.agtype_access_operator(properties::text::agtype, '"created_at"'::agtype) DESC NULLS LAST,
                             id DESC
                    {pagination_clause}
                """
            else:
                node_query = f"""
                    SELECT id, properties
                    FROM "{self.db_name}_graph"."Memory"
                    {where_clause}
                    ORDER BY ag_catalog.agtype_access_operator(properties::text::agtype, '"created_at"'::agtype) DESC NULLS LAST,
                             id DESC
                    {pagination_clause}
                """
            logger.info(f"[export_graph nodes] Query: {node_query}")
            with conn.cursor() as cursor:
                cursor.execute(node_query)
                node_results = cursor.fetchall()
                nodes = []

                for row in node_results:
                    if include_embedding:
                        """row is (id, properties, embedding)"""
                        _, properties_json, embedding_json = row
                    else:
                        """row is (id, properties)"""
                        _, properties_json = row
                        embedding_json = None

                    # Parse properties from JSONB if it's a string
                    if isinstance(properties_json, str):
                        try:
                            properties = json.loads(properties_json)
                        except json.JSONDecodeError:
                            properties = {}
                    else:
                        properties = properties_json if properties_json else {}

                    # Remove embedding field if include_embedding is False
                    if not include_embedding:
                        properties.pop("embedding", None)
                    elif include_embedding and embedding_json is not None:
                        properties["embedding"] = embedding_json

                    nodes.append(self._parse_node(properties))

        except Exception as e:
            logger.error(f"[EXPORT GRAPH - NODES] Exception: {e}", exc_info=True)
            raise RuntimeError(f"[EXPORT GRAPH - NODES] Exception: {e}") from e
        finally:
            self._return_connection(conn)

        conn = None
        try:
            conn = self._get_connection()
            # Build Cypher WHERE conditions for edges
            cypher_where_conditions = []
            if user_name:
                cypher_where_conditions.append(f"a.user_name = '{user_name}'")
                cypher_where_conditions.append(f"b.user_name = '{user_name}'")
            if user_id:
                cypher_where_conditions.append(f"a.user_id = '{user_id}'")
                cypher_where_conditions.append(f"b.user_id = '{user_id}'")

            # Build filter conditions for edges (apply to both source and target nodes)
            filter_where_clause = self._build_filter_conditions_cypher(filter)
            logger.info(f"[export_graph edges] filter_where_clause: {filter_where_clause}")
            if filter_where_clause:
                # _build_filter_conditions_cypher returns a string that starts with " AND " if filter exists
                # Remove the leading " AND " and replace n. with a. for source node and b. for target node
                filter_clause = filter_where_clause.strip()
                if filter_clause.startswith("AND "):
                    filter_clause = filter_clause[4:].strip()
                # Replace n. with a. for source node and create a copy for target node
                source_filter = filter_clause.replace("n.", "a.")
                target_filter = filter_clause.replace("n.", "b.")
                # Combine source and target filters with AND
                combined_filter = f"({source_filter}) AND ({target_filter})"
                cypher_where_conditions.append(combined_filter)

            cypher_where_clause = ""
            if cypher_where_conditions:
                cypher_where_clause = f"WHERE {' AND '.join(cypher_where_conditions)}"

            # Get total count of edges before pagination
            count_edge_query = f"""
                SELECT COUNT(*)
                FROM (
                    SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH (a:Memory)-[r]->(b:Memory)
                    {cypher_where_clause}
                    RETURN a.id AS source, b.id AS target, type(r) as edge
                    $$) AS (source agtype, target agtype, edge agtype)
                ) AS edges
            """
            logger.info(f"[export_graph edges count] Query: {count_edge_query}")
            with conn.cursor() as cursor:
                cursor.execute(count_edge_query)
                total_edges = cursor.fetchone()[0]

            # Export edges using cypher query
            # Note: Apache AGE Cypher may not support SKIP, so we use SQL LIMIT/OFFSET on the subquery
            # Build pagination clause if needed
            edge_pagination_clause = ""
            if use_pagination:
                edge_pagination_clause = f"LIMIT {page_size} OFFSET {offset}"

            edge_query = f"""
                SELECT source, target, edge FROM (
                    SELECT * FROM cypher('{self.db_name}_graph', $$
                    MATCH (a:Memory)-[r]->(b:Memory)
                    {cypher_where_clause}
                    RETURN a.id AS source, b.id AS target, type(r) as edge
                    ORDER BY COALESCE(a.created_at, '1970-01-01T00:00:00') DESC,
                             COALESCE(b.created_at, '1970-01-01T00:00:00') DESC,
                             a.id DESC, b.id DESC
                    $$) AS (source agtype, target agtype, edge agtype)
                ) AS edges
                {edge_pagination_clause}
            """
            logger.info(f"[export_graph edges] Query: {edge_query}")
            with conn.cursor() as cursor:
                cursor.execute(edge_query)
                edge_results = cursor.fetchall()
                edges = []

                for row in edge_results:
                    source_agtype, target_agtype, edge_agtype = row

                    # Extract and clean source
                    source_raw = (
                        source_agtype.value
                        if hasattr(source_agtype, "value")
                        else str(source_agtype)
                    )
                    if (
                        isinstance(source_raw, str)
                        and source_raw.startswith('"')
                        and source_raw.endswith('"')
                    ):
                        source = source_raw[1:-1]
                    else:
                        source = str(source_raw)

                    # Extract and clean target
                    target_raw = (
                        target_agtype.value
                        if hasattr(target_agtype, "value")
                        else str(target_agtype)
                    )
                    if (
                        isinstance(target_raw, str)
                        and target_raw.startswith('"')
                        and target_raw.endswith('"')
                    ):
                        target = target_raw[1:-1]
                    else:
                        target = str(target_raw)

                    # Extract and clean edge type
                    type_raw = (
                        edge_agtype.value if hasattr(edge_agtype, "value") else str(edge_agtype)
                    )
                    if (
                        isinstance(type_raw, str)
                        and type_raw.startswith('"')
                        and type_raw.endswith('"')
                    ):
                        edge_type = type_raw[1:-1]
                    else:
                        edge_type = str(type_raw)

                    edges.append(
                        {
                            "source": source,
                            "target": target,
                            "type": edge_type,
                        }
                    )

        except Exception as e:
            logger.error(f"[EXPORT GRAPH - EDGES] Exception: {e}", exc_info=True)
            raise RuntimeError(f"[EXPORT GRAPH - EDGES] Exception: {e}") from e
        finally:
            self._return_connection(conn)

        return {
            "nodes": nodes,
            "edges": edges,
            "total_nodes": total_nodes,
            "total_edges": total_edges,
        }

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
            conn = None
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(query)
                    logger.info("Cleared all nodes from database.")
            finally:
                self._return_connection(conn)

        except Exception as e:
            logger.error(f"[ERROR] Failed to clear database: {e}")

    def drop_database(self) -> None:
        """Permanently delete the entire graph this instance is using."""
        return
        if self._get_config_value("use_multi_db", True):
            with self.connection.cursor() as cursor:
                cursor.execute(f"SELECT drop_graph('{self.db_name}_graph', true)")
                logger.info(f"Graph '{self.db_name}_graph' has been dropped.")
        else:
            raise ValueError(
                f"Refusing to drop graph '{self.db_name}_graph' in "
                f"Shared Database Multi-Tenant mode"
            )

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
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"memory_type"'::agtype) = %s::agtype
            AND ag_catalog.agtype_access_operator(properties::text::agtype, '"user_name"'::agtype) = %s::agtype
            ORDER BY ag_catalog.agtype_access_operator(properties::text::agtype, '"updated_at"'::agtype) DESC
            OFFSET %s
        """
        select_params = [
            self.format_param_value(memory_type),
            self.format_param_value(user_name),
            keep_latest,
        ]
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
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
                    f"Removed {deleted_count} oldest {memory_type} memories, "
                    f"keeping {keep_latest} latest for user {user_name}, "
                    f"removed ids: {ids_to_delete}"
                )
        except Exception as e:
            logger.error(f"[remove_oldest_memory] Failed: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

    def merge_nodes(self, id1: str, id2: str) -> str:
        """Merge two similar or duplicate nodes into one."""
        raise NotImplementedError

    def deduplicate_nodes(self) -> None:
        """Deduplicate redundant or semantically similar nodes."""
        raise NotImplementedError

    def detect_conflicts(self) -> list[tuple[str, str]]:
        """Detect conflicting nodes based on logical or semantic inconsistency."""
        raise NotImplementedError

    def _convert_graph_edges(self, core_node: dict) -> dict:
        import copy

        data = copy.deepcopy(core_node)
        id_map = {}
        core_node = data.get("core_node", {})
        if not core_node:
            return {
                "core_node": None,
                "neighbors": data.get("neighbors", []),
                "edges": data.get("edges", []),
            }
        core_meta = core_node.get("metadata", {})
        if "graph_id" in core_meta and "id" in core_node:
            id_map[core_meta["graph_id"]] = core_node["id"]
        for neighbor in data.get("neighbors", []):
            n_meta = neighbor.get("metadata", {})
            if "graph_id" in n_meta and "id" in neighbor:
                id_map[n_meta["graph_id"]] = neighbor["id"]
        for edge in data.get("edges", []):
            src = edge.get("source")
            tgt = edge.get("target")
            if src in id_map:
                edge["source"] = id_map[src]
            if tgt in id_map:
                edge["target"] = id_map[tgt]
        return data

    @timed
    def get_user_names_by_memory_ids(self, memory_ids: list[str]) -> dict[str, str | None]:
        """Get user names by memory ids.

        Args:
            memory_ids: List of memory node IDs to query.

        Returns:
            dict[str, str | None]: Dictionary mapping memory_id to user_name.
                - Key: memory_id
                - Value: user_name if exists, None if memory_id does not exist
                Example: {"4918d700-6f01-4f4c-a076-75cc7b0e1a7c": "zhangsan", "2222222": None}
        """
        logger.info(f"[get_user_names_by_memory_ids] Querying memory_ids {memory_ids}")
        if not memory_ids:
            return {}

        # Validate and normalize memory_ids
        # Ensure all items are strings
        normalized_memory_ids = []
        for mid in memory_ids:
            if not isinstance(mid, str):
                mid = str(mid)
            # Remove any whitespace
            mid = mid.strip()
            if mid:
                normalized_memory_ids.append(mid)

        if not normalized_memory_ids:
            return {}

        # Escape special characters for JSON string format in agtype
        def escape_memory_id(mid: str) -> str:
            """Escape special characters in memory_id for JSON string format."""
            # Escape backslashes first, then double quotes
            mid_str = mid.replace("\\", "\\\\")
            mid_str = mid_str.replace('"', '\\"')
            return mid_str

        # Build OR conditions for each memory_id
        id_conditions = []
        for mid in normalized_memory_ids:
            # Escape special characters
            escaped_mid = escape_memory_id(mid)
            id_conditions.append(
                f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"id\"'::agtype) = '\"{escaped_mid}\"'::agtype"
            )

        where_clause = f"({' OR '.join(id_conditions)})"

        # Query to get memory_id and user_name pairs
        query = f"""
            SELECT
                ag_catalog.agtype_access_operator(properties::text::agtype, '\"id\"'::agtype)::text AS memory_id,
                ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype)::text AS user_name
            FROM "{self.db_name}_graph"."Memory"
            WHERE {where_clause}
        """

        logger.info(f"[get_user_names_by_memory_ids] query: {query}")
        conn = None
        result_dict = {}
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                # Build result dictionary from query results
                for row in results:
                    memory_id_raw = row[0]
                    user_name_raw = row[1]

                    # Remove quotes if present
                    if isinstance(memory_id_raw, str):
                        memory_id = memory_id_raw.strip('"').strip("'")
                    else:
                        memory_id = str(memory_id_raw).strip('"').strip("'")

                    if isinstance(user_name_raw, str):
                        user_name = user_name_raw.strip('"').strip("'")
                    else:
                        user_name = (
                            str(user_name_raw).strip('"').strip("'") if user_name_raw else None
                        )

                    result_dict[memory_id] = user_name if user_name else None

                # Set None for memory_ids that were not found
                for mid in normalized_memory_ids:
                    if mid not in result_dict:
                        result_dict[mid] = None

                logger.info(
                    f"[get_user_names_by_memory_ids] Found {len([v for v in result_dict.values() if v is not None])} memory_ids with user_names, "
                    f"{len([v for v in result_dict.values() if v is None])} memory_ids without user_names"
                )

                return result_dict
        except Exception as e:
            logger.error(
                f"[get_user_names_by_memory_ids] Failed to get user names: {e}", exc_info=True
            )
            raise
        finally:
            self._return_connection(conn)

    def exist_user_name(self, user_name: str) -> dict[str, bool]:
        """Check if user name exists in the graph.

        Args:
            user_name: User name to check.

        Returns:
            dict[str, bool]: Dictionary with user_name as key and bool as value indicating existence.
        """
        logger.info(f"[exist_user_name] Querying user_name {user_name}")
        if not user_name:
            return {user_name: False}

        # Escape special characters for JSON string format in agtype
        def escape_user_name(un: str) -> str:
            """Escape special characters in user_name for JSON string format."""
            # Escape backslashes first, then double quotes
            un_str = un.replace("\\", "\\\\")
            un_str = un_str.replace('"', '\\"')
            return un_str

        # Escape special characters
        escaped_un = escape_user_name(user_name)

        # Query to check if user_name exists
        query = f"""
            SELECT COUNT(*)
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = '\"{escaped_un}\"'::agtype
        """
        logger.info(f"[exist_user_name] query: {query}")
        result_dict = {}
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                count = cursor.fetchone()[0]
                result = count > 0
                result_dict[user_name] = result
                return result_dict
        except Exception as e:
            logger.error(
                f"[exist_user_name] Failed to check user_name existence: {e}", exc_info=True
            )
            raise
        finally:
            self._return_connection(conn)

    @timed
    def delete_node_by_prams(
        self,
        writable_cube_ids: list[str] | None = None,
        memory_ids: list[str] | None = None,
        file_ids: list[str] | None = None,
        filter: dict | None = None,
    ) -> int:
        """
        Delete nodes by memory_ids, file_ids, or filter.

        Args:
            writable_cube_ids (list[str], optional): List of cube IDs (user_name) to filter nodes.
                If not provided, no user_name filter will be applied.
            memory_ids (list[str], optional): List of memory node IDs to delete.
            file_ids (list[str], optional): List of file node IDs to delete.
            filter (dict, optional): Filter dictionary for metadata filtering.
                Filter conditions are directly used in DELETE WHERE clause without pre-querying.

        Returns:
            int: Number of nodes deleted.
        """
        batch_start_time = time.time()
        logger.info(
            f"[delete_node_by_prams] memory_ids: {memory_ids}, file_ids: {file_ids}, filter: {filter}, writable_cube_ids: {writable_cube_ids}"
        )

        # Build user_name condition from writable_cube_ids (OR relationship - match any cube_id)
        # Only add user_name filter if writable_cube_ids is provided
        user_name_conditions = []
        if writable_cube_ids and len(writable_cube_ids) > 0:
            for cube_id in writable_cube_ids:
                # Use agtype_access_operator with VARIADIC ARRAY format for consistency
                user_name_conditions.append(
                    f"agtype_access_operator(VARIADIC ARRAY[properties::text::agtype, '\"user_name\"'::agtype]) = '\"{cube_id}\"'::agtype"
                )

        # Build filter conditions using common method (no query, direct use in WHERE clause)
        filter_conditions = []
        if filter:
            filter_conditions = self._build_filter_conditions_sql(filter)
            logger.info(f"[delete_node_by_prams] filter_conditions: {filter_conditions}")

        # If no conditions to delete, return 0
        if not memory_ids and not file_ids and not filter_conditions:
            logger.warning(
                "[delete_node_by_prams] No nodes to delete (no memory_ids, file_ids, or filter provided)"
            )
            return 0

        conn = None
        total_deleted_count = 0
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                # Build WHERE conditions list
                where_conditions = []

                # Add memory_ids conditions
                if memory_ids:
                    logger.info(f"[delete_node_by_prams] Processing {len(memory_ids)} memory_ids")
                    id_conditions = []
                    for node_id in memory_ids:
                        id_conditions.append(
                            f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"id\"'::agtype) = '\"{node_id}\"'::agtype"
                        )
                    where_conditions.append(f"({' OR '.join(id_conditions)})")

                # Add file_ids conditions
                if file_ids:
                    logger.info(f"[delete_node_by_prams] Processing {len(file_ids)} file_ids")
                    file_id_conditions = []
                    for file_id in file_ids:
                        file_id_conditions.append(
                            f"agtype_in_operator(agtype_access_operator(VARIADIC ARRAY[properties::text::agtype, '\"file_ids\"'::agtype]), '\"{file_id}\"'::agtype)"
                        )
                    where_conditions.append(f"({' OR '.join(file_id_conditions)})")

                # Add filter conditions
                if filter_conditions:
                    logger.info("[delete_node_by_prams] Processing filter conditions")
                    where_conditions.extend(filter_conditions)

                # Add user_name filter if provided
                if user_name_conditions:
                    user_name_where = " OR ".join(user_name_conditions)
                    where_conditions.append(f"({user_name_where})")

                # Build final WHERE clause
                if not where_conditions:
                    logger.warning("[delete_node_by_prams] No WHERE conditions to delete")
                    return 0

                where_clause = " AND ".join(where_conditions)

                # Delete directly without counting
                delete_query = f"""
                    DELETE FROM "{self.db_name}_graph"."Memory"
                    WHERE {where_clause}
                """
                logger.info(f"[delete_node_by_prams] delete_query: {delete_query}")

                cursor.execute(delete_query)
                deleted_count = cursor.rowcount
                total_deleted_count = deleted_count

                logger.info(f"[delete_node_by_prams] Deleted {deleted_count} nodes")

                elapsed_time = time.time() - batch_start_time
                logger.info(
                    f"[delete_node_by_prams] Deletion completed successfully in {elapsed_time:.2f}s, total deleted {total_deleted_count} nodes"
                )
        except Exception as e:
            logger.error(f"[delete_node_by_prams] Failed to delete nodes: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

        logger.info(f"[delete_node_by_prams] Successfully deleted {total_deleted_count} nodes")
        return total_deleted_count
