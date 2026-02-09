import json

from typing import Any, Literal

from memos.log import get_logger
from memos.utils import timed


logger = get_logger(__name__)


class TraversalMixin:
    """Mixin for graph traversal operations."""

    def get_neighbors(
        self, id: str, type: str, direction: Literal["in", "out", "both"] = "out"
    ) -> list[str]:
        """Get connected node IDs in a specific direction and relationship type."""
        raise NotImplementedError

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

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
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
        finally:
            self._return_connection(conn)

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
        logger.info(f"[get_subgraph] center_id: {center_id}")
        if not 1 <= depth <= 5:
            raise ValueError("depth must be 1-5")

        user_name = user_name if user_name else self._get_config_value("user_name")

        if center_id.startswith('"') and center_id.endswith('"'):
            center_id = center_id[1:-1]
        # Use UNION ALL for better performance: separate queries for depth 1 and depth 2
        if depth == 1:
            query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                        MATCH(center: Memory)-[r]->(neighbor:Memory)
                        WHERE
                        center.id = '{center_id}'
                        AND center.status = '{center_status}'
                        AND center.user_name = '{user_name}'
                        RETURN collect(DISTINCT center), collect(DISTINCT neighbor), collect(DISTINCT r)
                    $$ ) as (centers agtype, neighbors agtype, rels agtype);
                """
        else:
            # For depth >= 2, use UNION ALL to combine depth 1 and depth 2 queries
            query = f"""
                SELECT * FROM cypher('{self.db_name}_graph', $$
                        MATCH(center: Memory)-[r]->(neighbor:Memory)
                        WHERE
                        center.id = '{center_id}'
                        AND center.status = '{center_status}'
                        AND center.user_name = '{user_name}'
                        RETURN collect(DISTINCT center), collect(DISTINCT neighbor), collect(DISTINCT r)
                UNION ALL
                        MATCH(center: Memory)-[r]->(n:Memory)-[r1]->(neighbor:Memory)
                        WHERE
                       center.id = '{center_id}'
                        AND center.status = '{center_status}'
                        AND center.user_name = '{user_name}'
                        RETURN collect(DISTINCT center), collect(DISTINCT neighbor), collect(DISTINCT r1)
                    $$ ) as (centers agtype, neighbors agtype, rels agtype);
                """
        conn = None
        logger.info(f"[get_subgraph] Query: {query}")
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query)
                results = cursor.fetchall()

                if not results:
                    return {"core_node": None, "neighbors": [], "edges": []}

                # Merge results from all UNION ALL rows
                all_centers_list = []
                all_neighbors_list = []
                all_edges_list = []

                for result in results:
                    if not result or not result[0]:
                        continue

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
                            json.loads(centers_data)
                            if isinstance(centers_data, str)
                            else centers_data
                        )
                        neighbors_list = (
                            json.loads(neighbors_data)
                            if isinstance(neighbors_data, str)
                            else neighbors_data
                        )
                        edges_list = (
                            json.loads(edges_data) if isinstance(edges_data, str) else edges_data
                        )

                        # Collect data from this row
                        if isinstance(centers_list, list):
                            all_centers_list.extend(centers_list)
                        if isinstance(neighbors_list, list):
                            all_neighbors_list.extend(neighbors_list)
                        if isinstance(edges_list, list):
                            all_edges_list.extend(edges_list)
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to parse JSON data: {e}")
                        continue

                # Deduplicate centers by ID
                centers_dict = {}
                for center_data in all_centers_list:
                    if isinstance(center_data, dict) and "properties" in center_data:
                        center_id_key = center_data["properties"].get("id")
                        if center_id_key and center_id_key not in centers_dict:
                            centers_dict[center_id_key] = center_data

                # Parse center node (use first center)
                core_node = None
                if centers_dict:
                    center_data = next(iter(centers_dict.values()))
                    if isinstance(center_data, dict) and "properties" in center_data:
                        core_node = self._parse_node(center_data["properties"])

                # Deduplicate neighbors by ID
                neighbors_dict = {}
                for neighbor_data in all_neighbors_list:
                    if isinstance(neighbor_data, dict) and "properties" in neighbor_data:
                        neighbor_id = neighbor_data["properties"].get("id")
                        if neighbor_id and neighbor_id not in neighbors_dict:
                            neighbors_dict[neighbor_id] = neighbor_data

                # Parse neighbor nodes
                neighbors = []
                for neighbor_data in neighbors_dict.values():
                    if isinstance(neighbor_data, dict) and "properties" in neighbor_data:
                        neighbor_parsed = self._parse_node(neighbor_data["properties"])
                        neighbors.append(neighbor_parsed)

                # Deduplicate edges by (source, target, type)
                edges_dict = {}
                for edge_group in all_edges_list:
                    if isinstance(edge_group, list):
                        for edge_data in edge_group:
                            if isinstance(edge_data, dict):
                                edge_key = (
                                    edge_data.get("start_id", ""),
                                    edge_data.get("end_id", ""),
                                    edge_data.get("label", ""),
                                )
                                if edge_key not in edges_dict:
                                    edges_dict[edge_key] = {
                                        "type": edge_data.get("label", ""),
                                        "source": edge_data.get("start_id", ""),
                                        "target": edge_data.get("end_id", ""),
                                    }
                    elif isinstance(edge_group, dict):
                        # Handle single edge (not in a list)
                        edge_key = (
                            edge_group.get("start_id", ""),
                            edge_group.get("end_id", ""),
                            edge_group.get("label", ""),
                        )
                        if edge_key not in edges_dict:
                            edges_dict[edge_key] = {
                                "type": edge_group.get("label", ""),
                                "source": edge_group.get("start_id", ""),
                                "target": edge_group.get("end_id", ""),
                            }

                edges = list(edges_dict.values())

                return self._convert_graph_edges(
                    {"core_node": core_node, "neighbors": neighbors, "edges": edges}
                )

        except Exception as e:
            logger.error(f"Failed to get subgraph: {e}", exc_info=True)
            return {"core_node": None, "neighbors": [], "edges": []}
        finally:
            self._return_connection(conn)

    def get_context_chain(self, id: str, type: str = "FOLLOWS") -> list[str]:
        """Get the ordered context chain starting from a node."""
        raise NotImplementedError

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
                    "ag_catalog.agtype_access_operator(properties::text::agtype, '\"id\"'::agtype) != %s::agtype"
                )
                params.append(self.format_param_value(exclude_id))
            where_clauses.append(f"({' AND '.join(exclude_conditions)})")

        # Status filter - keep only 'activated'
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties::text::agtype, '\"status\"'::agtype) = '\"activated\"'::agtype"
        )

        # Type filter - exclude 'reasoning' type
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties::text::agtype, '\"node_type\"'::agtype) != '\"reasoning\"'::agtype"
        )

        # User filter
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
        )
        params.append(self.format_param_value(user_name))

        # Testing showed no data; annotate.
        where_clauses.append(
            "ag_catalog.agtype_access_operator(properties::text::agtype, '\"memory_type\"'::agtype) != '\"WorkingMemory\"'::agtype"
        )

        where_clause = " AND ".join(where_clauses)

        # Fetch all candidate nodes
        query = f"""
            SELECT id, properties, embedding
            FROM "{self.db_name}_graph"."Memory"
            WHERE {where_clause}
        """

        logger.debug(f"[get_neighbors_by_tag] query: {query}, params: {params}")

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
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
        finally:
            self._return_connection(conn)
