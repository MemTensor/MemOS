import json
from typing import Any

from memos.log import get_logger
from memos.utils import timed

logger = get_logger(__name__)


class QueryMixin:
    """Mixin for query operations (metadata, counts, grouped queries)."""

    @timed
    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
        user_name_flag: bool = True,
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
        logger.info(f"[get_by_metadata] filter: {filter}, knowledgebase_ids: {knowledgebase_ids}")

        user_name = user_name if user_name else self._get_config_value("user_name")

        # Build WHERE conditions for cypher query
        where_conditions = []

        for f in filters:
            field = f["field"]
            op = f.get("op", "=")
            value = f["value"]

            # Format value
            if isinstance(value, str):
                # Escape single quotes using backslash when inside $$ dollar-quoted strings
                # In $$ delimiters, Cypher string literals can use \' to escape single quotes
                escaped_str = value.replace("'", "\\'")
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
            elif op == "like":
                where_conditions.append(f"n.{field} CONTAINS {escaped_value}")
            elif op in [">", ">=", "<", "<="]:
                where_conditions.append(f"n.{field} {op} {escaped_value}")
            else:
                raise ValueError(f"Unsupported operator: {op}")

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_cypher(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self._get_config_value("user_name"),
        )
        logger.info(f"[get_by_metadata] user_name_conditions: {user_name_conditions}")

        # Add user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_conditions.append(user_name_conditions[0])
            else:
                where_conditions.append(f"({' OR '.join(user_name_conditions)})")

        # Build filter conditions using common method
        filter_where_clause = self._build_filter_conditions_cypher(filter)
        logger.info(f"[get_by_metadata] filter_where_clause: {filter_where_clause}")

        where_str = " AND ".join(where_conditions) + filter_where_clause

        # Use cypher query
        cypher_query = f"""
               SELECT * FROM cypher('{self.db_name}_graph', $$
               MATCH (n:Memory)
               WHERE {where_str}
               RETURN n.id AS id
               $$) AS (id agtype)
           """

        ids = []
        conn = None
        logger.info(f"[get_by_metadata] cypher_query: {cypher_query}")
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(cypher_query)
                results = cursor.fetchall()
                ids = [str(item[0]).strip('"') for item in results]
        except Exception as e:
            logger.error(f"Failed to get metadata: {e}, query is {cypher_query}")
        finally:
            self._return_connection(conn)

        return ids

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
        user_clause = f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype"
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
                f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = '\"{user_name}\"'::agtype",
            )

        # Build return fields and group by fields
        return_fields = []
        group_by_fields = []

        for field in group_fields:
            alias = field.replace(".", "_")
            return_fields.append(
                f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"{field}\"'::agtype)::text AS {alias}"
            )
            group_by_fields.append(
                f"ag_catalog.agtype_access_operator(properties::text::agtype, '\"{field}\"'::agtype)::text"
            )

        # Full SQL query construction
        query = f"""
            SELECT {", ".join(return_fields)}, COUNT(*) AS count
            FROM "{self.db_name}_graph"."Memory"
            {where_clause}
            GROUP BY {", ".join(group_by_fields)}
        """
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
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
                    output.append({**group_values, "count": int(count_value)})

                return output

        except Exception as e:
            logger.error(f"Failed to get grouped counts: {e}", exc_info=True)
            return []
        finally:
            self._return_connection(conn)

    def get_memory_count(self, memory_type: str, user_name: str | None = None) -> int:
        """Get count of memory nodes by type."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        query = f"""
            SELECT COUNT(*)
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"memory_type"'::agtype) = %s::agtype
        """
        query += "\nAND ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
        params = [self.format_param_value(memory_type), self.format_param_value(user_name)]

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            logger.error(f"[get_memory_count] Failed: {e}")
            return -1
        finally:
            self._return_connection(conn)

    @timed
    def node_not_exist(self, scope: str, user_name: str | None = None) -> int:
        """Check if a node with given scope exists."""
        user_name = user_name if user_name else self._get_config_value("user_name")
        query = f"""
            SELECT id
            FROM "{self.db_name}_graph"."Memory"
            WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"memory_type"'::agtype) = %s::agtype
        """
        query += "\nAND ag_catalog.agtype_access_operator(properties::text::agtype, '\"user_name\"'::agtype) = %s::agtype"
        query += "\nLIMIT 1"
        params = [self.format_param_value(scope), self.format_param_value(user_name)]

        # Get a connection from the pool
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                return 1 if result else 0
        except Exception as e:
            logger.error(f"[node_not_exist] Query failed: {e}", exc_info=True)
            raise
        finally:
            self._return_connection(conn)

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
        conn = None
        try:
            conn = self._get_connection()
            cursor = conn.cursor()
            cursor.execute(query)
            row = cursor.fetchone()
            cursor.close()
            conn.commit()
            return int(row[0]) if row else 0
        except Exception:
            if conn:
                conn.rollback()
            raise
        finally:
            self._return_connection(conn)

    @timed
    def get_all_memory_items(
        self,
        scope: str,
        include_embedding: bool = False,
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list | None = None,
        status: str | None = None,
    ) -> list[dict]:
        """
        Retrieve all memory items of a specific memory_type.

        Args:
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', or 'UserMemory'.
            include_embedding: with/without embedding
            user_name (str, optional): User name for filtering in non-multi-db mode
            filter (dict, optional): Filter conditions with 'and' or 'or' logic for search results.
            knowledgebase_ids (list, optional): List of knowledgebase IDs to filter by.
            status (str, optional): Filter by status (e.g., 'activated', 'archived').
                If None, no status filter is applied.

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        logger.info(
            f"[get_all_memory_items] filter: {filter}, knowledgebase_ids: {knowledgebase_ids}, status: {status}"
        )

        user_name = user_name if user_name else self._get_config_value("user_name")
        if scope not in {"WorkingMemory", "LongTermMemory", "UserMemory", "OuterMemory"}:
            raise ValueError(f"Unsupported memory type scope: {scope}")

        # Build user_name filter with knowledgebase_ids support (OR relationship) using common method
        user_name_conditions = self._build_user_name_and_kb_ids_conditions_cypher(
            user_name=user_name,
            knowledgebase_ids=knowledgebase_ids,
            default_user_name=self._get_config_value("user_name"),
        )

        # Build user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                user_name_where = user_name_conditions[0]
            else:
                user_name_where = f"({' OR '.join(user_name_conditions)})"
        else:
            user_name_where = ""

        # Build filter conditions using common method
        filter_where_clause = self._build_filter_conditions_cypher(filter)
        logger.info(f"[get_all_memory_items] filter_where_clause: {filter_where_clause}")

        # Use cypher query to retrieve memory items
        if include_embedding:
            # Build WHERE clause with user_name/knowledgebase_ids and filter
            where_parts = [f"n.memory_type = '{scope}'"]
            if status:
                where_parts.append(f"n.status = '{status}'")
            if user_name_where:
                # user_name_where already contains parentheses if it's an OR condition
                where_parts.append(user_name_where)
            if filter_where_clause:
                # filter_where_clause already contains " AND " prefix, so we just append it
                where_clause = " AND ".join(where_parts) + filter_where_clause
            else:
                where_clause = " AND ".join(where_parts)

            cypher_query = f"""
                   WITH t as (
                       SELECT * FROM cypher('{self.db_name}_graph', $$
                       MATCH (n:Memory)
                       WHERE {where_clause}
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
            conn = None
            logger.info(f"[get_all_memory_items] cypher_query: {cypher_query}")
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
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
            finally:
                self._return_connection(conn)

            return nodes
        else:
            # Build WHERE clause with user_name/knowledgebase_ids and filter
            where_parts = [f"n.memory_type = '{scope}'"]
            if status:
                where_parts.append(f"n.status = '{status}'")
            if user_name_where:
                # user_name_where already contains parentheses if it's an OR condition
                where_parts.append(user_name_where)
            if filter_where_clause:
                # filter_where_clause already contains " AND " prefix, so we just append it
                where_clause = " AND ".join(where_parts) + filter_where_clause
            else:
                where_clause = " AND ".join(where_parts)

            cypher_query = f"""
                   SELECT * FROM cypher('{self.db_name}_graph', $$
                   MATCH (n:Memory)
                   WHERE {where_clause}
                   RETURN properties(n) as props
                   LIMIT 100
                   $$) AS (nprops agtype)
               """

            nodes = []
            conn = None
            logger.info(f"[get_all_memory_items] cypher_query: {cypher_query}")
            try:
                conn = self._get_connection()
                with conn.cursor() as cursor:
                    cursor.execute(cypher_query)
                    results = cursor.fetchall()

                    for row in results:
                        memory_data = json.loads(row[0]) if isinstance(row[0], str) else row[0]
                        nodes.append(self._parse_node(memory_data))

            except Exception as e:
                logger.error(f"Failed to get memories: {e}", exc_info=True)
            finally:
                self._return_connection(conn)

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
        logger.info(f"[get_structure_optimization_candidates] query: {cypher_query}")

        candidates = []
        node_ids = set()
        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor() as cursor:
                cursor.execute(cypher_query)
                results = cursor.fetchall()
                logger.info(f"Found {len(results)} structure optimization candidates")
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
                            node = self._parse_node(node_data)
                            node_id = node["id"]

                            if node_id not in node_ids:
                                candidates.append(node)
                                node_ids.add(node_id)
                                logger.debug(f"Parsed node successfully: {node_id}")
                        except Exception as e:
                            logger.error(f"Failed to parse node: {e}")

        except Exception as e:
            logger.error(f"Failed to get structure optimization candidates: {e}", exc_info=True)
        finally:
            self._return_connection(conn)

        return candidates
