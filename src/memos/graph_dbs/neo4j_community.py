import json
import re

from datetime import datetime
from typing import Any

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.graph_dbs.neo4j import Neo4jGraphDB, _prepare_node_metadata
from memos.log import get_logger
from memos.vec_dbs.factory import VecDBFactory
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)


class Neo4jCommunityGraphDB(Neo4jGraphDB):
    """
    Neo4j Community Edition graph memory store.

    Note:
        This class avoids Enterprise-only features:
        - No multi-database support
        - No vector index
        - No CREATE DATABASE
    """

    def __init__(self, config: Neo4jGraphDBConfig):
        assert config.auto_create is False
        assert config.use_multi_db is False
        # Init vector database
        self.vec_db = VecDBFactory.from_config(config.vec_config)
        # Call parent init
        super().__init__(config)

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

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        user_name = user_name if user_name else self.config.user_name
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            metadata["user_name"] = user_name

        # Safely process metadata
        metadata = _prepare_node_metadata(metadata)

        # serialization
        if metadata["sources"]:
            for idx in range(len(metadata["sources"])):
                metadata["sources"][idx] = json.dumps(metadata["sources"][idx])
        # Extract required fields
        embedding = metadata.pop("embedding", None)
        if embedding is None:
            raise ValueError(f"Missing 'embedding' in metadata for node {id}")

        # Merge node and set metadata
        created_at = metadata.pop("created_at")
        updated_at = metadata.pop("updated_at")
        vector_sync_status = "success"

        try:
            # Write to Vector DB
            item = VecDBItem(
                id=id,
                vector=embedding,
                payload={
                    "memory": memory,
                    "vector_sync": vector_sync_status,
                    **metadata,  # unpack all metadata keys to top-level
                },
            )
            self.vec_db.add([item])
        except Exception as e:
            logger.warning(f"[VecDB] Vector insert failed for node {id}: {e}")
            vector_sync_status = "failed"

        metadata["vector_sync"] = vector_sync_status
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
                RETURN c.id AS id, c.memory AS memory
            """

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            child_nodes = [{"id": r["id"], "memory": r["memory"]} for r in result]

        # Get embeddings from vector DB
        ids = [n["id"] for n in child_nodes]
        vec_items = {v.id: v.vector for v in self.vec_db.get_by_ids(ids)}

        # Merge results
        for node in child_nodes:
            node["embedding"] = vec_items.get(node["id"])

        return child_nodes

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
        Retrieve node IDs based on vector similarity using external vector DB.

        Args:
            vector (list[float]): The embedding vector representing query semantics.
            top_k (int): Number of top similar nodes to retrieve.
            scope (str, optional): Memory type filter (e.g., 'WorkingMemory', 'LongTermMemory').
            status (str, optional): Node status filter (e.g., 'activated', 'archived').
            threshold (float, optional): Minimum similarity score threshold (0 ~ 1).
            search_filter (dict, optional): Additional metadata filters to apply.
            filter (dict, optional): Filter conditions with 'and' or 'or' logic for search results.
                Example: {"and": [{"id": "xxx"}, {"A": "yyy"}]} or {"or": [{"id": "xxx"}, {"A": "yyy"}]}
            knowledgebase_ids (list[str], optional): List of knowledgebase IDs to filter by.

        Returns:
            list[dict]: A list of dicts with 'id' and 'score', ordered by similarity.

        Notes:
            - This method uses an external vector database (not Neo4j) to perform the search.
            - If 'scope' is provided, it restricts results to nodes with matching memory_type.
            - If 'status' is provided, it further filters nodes by status.
            - If 'threshold' is provided, only results with score >= threshold will be returned.
            - If 'search_filter' is provided, it applies additional metadata-based filtering.
            - If 'filter' is provided, it applies complex filter conditions with AND/OR logic.
            - The returned IDs can be used to fetch full node data from Neo4j if needed.
        """
        user_name = user_name if user_name else self.config.user_name

        # First, perform vector search in external vector DB
        vec_filter = {}
        if scope:
            vec_filter["memory_type"] = scope
        if status:
            vec_filter["status"] = status
        vec_filter["vector_sync"] = "success"
        if kwargs.get("cube_name"):
            vec_filter["user_name"] = kwargs["cube_name"]
        else:
            vec_filter["user_name"] = user_name

        # Add search_filter conditions
        if search_filter:
            vec_filter.update(search_filter)

        # Perform vector search
        vec_results = []
        if self.vec_db:
            try:
                vec_results = self.vec_db.search(
                    query_vector=vector, top_k=top_k, filter=vec_filter
                )
            except Exception as e:
                logger.warning(f"[VecDB] search failed: {e}")

        # Filter by threshold
        if threshold is not None:
            vec_results = [r for r in vec_results if r.score is None or r.score >= threshold]

        # If no filter or knowledgebase_ids provided, return vector search results directly
        if not filter and not knowledgebase_ids:
            return [{"id": r.id, "score": r.score} for r in vec_results]

        # Extract IDs from vector search results
        vec_ids = [r.id for r in vec_results]
        if not vec_ids:
            return []

        # Build WHERE clause for Neo4j filtering
        where_clauses = ["n.id IN $vec_ids"]
        params = {"vec_ids": vec_ids}

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

        # Query Neo4j to filter results
        query = f"""
            MATCH (n:Memory)
            {where_clause}
            RETURN n.id AS id
        """
        logger.info(f"[search_by_embedding] query: {query}, params: {params}")

        with self.driver.session(database=self.db_name) as session:
            neo4j_results = session.run(query, params)
            filtered_ids = {record["id"] for record in neo4j_results}

        # Filter vector results by Neo4j filtered IDs and return with scores
        filtered_results = [
            {"id": r.id, "score": r.score} for r in vec_results if r.id in filtered_ids
        ]

        return filtered_results

    def _normalize_date_string(self, date_str: str) -> str:
        """
        Normalize date string to ISO 8601 format for Neo4j datetime() function.

        Args:
            date_str: Date string in various formats (e.g., "2025-09-19", "2025-09-19T00:00:00Z")

        Returns:
            ISO 8601 formatted date string (e.g., "2025-09-19T00:00:00Z")
        """
        if not isinstance(date_str, str):
            return date_str

        # If already in ISO 8601 format with time, return as is
        if "T" in date_str or date_str.endswith("Z") or "+" in date_str or "-" in date_str[-6:]:
            return date_str

        # Check if it's a simple date format (YYYY-MM-DD)
        date_pattern = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", date_str)
        if date_pattern:
            # Convert to ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ
            # For "gt" (greater than), use 00:00:00 of the next day
            # For "lt" (less than), use 00:00:00 of the same day
            # For "gte" (greater than or equal), use 00:00:00 of the same day
            # For "lte" (less than or equal), use 23:59:59.999999999 of the same day
            # But we'll use 00:00:00Z as default and let the caller handle the logic
            return f"{date_str}T00:00:00Z"

        # If it's already a datetime string, try to parse and reformat
        try:
            # Try to parse various datetime formats
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            return dt.isoformat().replace("+00:00", "Z")
        except (ValueError, AttributeError):
            # If parsing fails, return as is
            return date_str

    def _build_filter_conditions_cypher(
        self,
        filter: dict | None,
        param_counter_start: int = 0,
        node_alias: str = "node",
    ) -> tuple[list[str], dict[str, Any]]:
        """
        Build filter conditions for Cypher queries with date normalization.

        This method extends the parent class method by normalizing date strings
        to ISO 8601 format before building conditions.

        Args:
            filter: Filter dictionary with "or" or "and" logic
            param_counter_start: Starting value for parameter counter (to avoid conflicts)
            node_alias: Node alias in Cypher query (default: "node" or "n")

        Returns:
            Tuple of (condition_strings_list, parameters_dict)
        """
        normalized_filter = self._normalize_filter_dates(filter) if filter else filter

        # Call parent method with normalized filter
        return super()._build_filter_conditions_cypher(
            filter=normalized_filter,
            param_counter_start=param_counter_start,
            node_alias=node_alias,
        )

    def _normalize_filter_dates(self, filter: dict) -> dict:
        """
        Recursively normalize date strings in filter dictionary.

        Args:
            filter: Filter dictionary that may contain date strings

        Returns:
            Filter dictionary with normalized date strings
        """
        if not isinstance(filter, dict):
            return filter

        normalized = {}

        if "and" in filter:
            normalized["and"] = [
                self._normalize_condition_dates(cond) if isinstance(cond, dict) else cond
                for cond in filter["and"]
            ]
        elif "or" in filter:
            normalized["or"] = [
                self._normalize_condition_dates(cond) if isinstance(cond, dict) else cond
                for cond in filter["or"]
            ]
        else:
            # Single condition
            normalized = self._normalize_condition_dates(filter)

        return normalized

    def _normalize_condition_dates(self, condition: dict) -> dict:
        """
        Normalize date strings in a single condition dictionary.

        Args:
            condition: A condition dict like {"created_at": {"gt": "2025-09-19"}}

        Returns:
            Condition dict with normalized date strings
        """
        from datetime import timedelta

        normalized = {}

        for key, value in condition.items():
            # Check if this is a date field
            is_date_field = key in ("created_at", "updated_at") or key.endswith("_at")

            if isinstance(value, dict):
                # Handle comparison operators
                normalized_value = {}
                for op, op_value in value.items():
                    if op in ("gt", "lt", "gte", "lte") and is_date_field:
                        # Normalize date string for date comparisons
                        if isinstance(op_value, str):
                            # Check if it's a simple date format (YYYY-MM-DD)
                            date_pattern = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", op_value)
                            if date_pattern:
                                try:
                                    # Parse the date
                                    dt = datetime.fromisoformat(op_value + "T00:00:00")

                                    if op == "gt":
                                        # "gt": "2025-09-19" means > 2025-09-19 00:00:00
                                        # So we keep it as 2025-09-19T00:00:00Z
                                        normalized_value[op] = dt.isoformat() + "Z"
                                    elif op == "gte":
                                        # "gte": "2025-09-19" means >= 2025-09-19 00:00:00
                                        normalized_value[op] = dt.isoformat() + "Z"
                                    elif op == "lt":
                                        # "lt": "2025-11-29" means < 2025-11-29 (exclude the entire day)
                                        # So we convert to the start of the next day: 2025-11-30T00:00:00Z
                                        # This ensures all times on 2025-11-29 are included
                                        dt_next = dt + timedelta(days=1)
                                        normalized_value[op] = dt_next.isoformat() + "Z"
                                    elif op == "lte":
                                        # "lte": "2025-11-29" means <= 2025-11-29 23:59:59.999999
                                        # So we convert to end of day: 2025-11-29T23:59:59.999999Z
                                        dt_end = dt + timedelta(days=1) - timedelta(microseconds=1)
                                        normalized_value[op] = dt_end.isoformat() + "Z"
                                except ValueError:
                                    # If parsing fails, use the original normalization
                                    normalized_value[op] = self._normalize_date_string(op_value)
                            else:
                                # Already in a more complex format, just normalize it
                                normalized_value[op] = self._normalize_date_string(op_value)
                        else:
                            normalized_value[op] = op_value
                    else:
                        normalized_value[op] = op_value
                normalized[key] = normalized_value
            else:
                normalized[key] = value

        return normalized

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
            scope (str): Must be one of 'WorkingMemory', 'LongTermMemory', 'UserMemory', or 'OuterMemory'.
            filter (dict, optional): Filter conditions with 'and' or 'or' logic for search results.
                Example: {"and": [{"id": "xxx"}, {"A": "yyy"}]} or {"or": [{"id": "xxx"}, {"A": "yyy"}]}
            knowledgebase_ids (list[str], optional): List of knowledgebase IDs to filter by.

        Returns:
            list[dict]: Full list of memory items under this scope.
        """
        logger.info(
            f"[get_all_memory_items] scope: {scope}, filter: {filter}, knowledgebase_ids: {knowledgebase_ids}"
        )
        print(
            f"[get_all_memory_items] scope: {scope}, filter: {filter}, knowledgebase_ids: {knowledgebase_ids}"
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
        logger.info(f"[get_all_memory_items] query: {query}, params: {params}")
        print(f"[get_all_memory_items] query: {query}, params: {params}")

        with self.driver.session(database=self.db_name) as session:
            results = session.run(query, params)
            return [self._parse_node(dict(record["n"])) for record in results]

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        user_name: str | None = None,
        filter: dict | None = None,
        knowledgebase_ids: list[str] | None = None,
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
        filter (dict, optional): Filter conditions with 'and' or 'or' logic for search results.
        knowledgebase_ids (list[str], optional): List of knowledgebase IDs to filter by user_name.

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

        # Build user_name filter with knowledgebase_ids support (OR relationship)
        user_name_conditions = []
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            user_name_conditions.append("n.user_name = $user_name")

        # Add knowledgebase_ids conditions (checking user_name field in the data)
        if knowledgebase_ids and isinstance(knowledgebase_ids, list) and len(knowledgebase_ids) > 0:
            for idx, kb_id in enumerate(knowledgebase_ids):
                if isinstance(kb_id, str):
                    param_name = f"kb_id_{idx}"
                    user_name_conditions.append(f"n.user_name = ${param_name}")

        # Add user_name WHERE clause
        if user_name_conditions:
            if len(user_name_conditions) == 1:
                where_clauses.append(user_name_conditions[0])
            else:
                where_clauses.append(f"({' OR '.join(user_name_conditions)})")

        # Add filter conditions (supports "or" and "and" logic)
        filter_params = {}
        if filter:
            # Helper function to build a single filter condition
            def build_filter_condition(
                condition_dict: dict, param_counter: list
            ) -> tuple[str, dict]:
                """Build a WHERE condition for a single filter item.

                Args:
                    condition_dict: A dict like {"id": "xxx"} or {"A": "xxx"} or {"created_at": {"gt": "2025-11-01"}}
                    param_counter: List to track parameter counter for unique param names

                Returns:
                    Tuple of (condition_string, parameters_dict)
                """
                condition_parts = []
                filter_params_inner = {}

                for key, value in condition_dict.items():
                    # Check if value is a dict with comparison operators (gt, lt, gte, lte)
                    if isinstance(value, dict):
                        # Handle comparison operators: gt (greater than), lt (less than), gte (greater than or equal), lte (less than or equal)
                        for op, op_value in value.items():
                            if op in ("gt", "lt", "gte", "lte"):
                                # Map operator to Cypher operator
                                cypher_op_map = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
                                cypher_op = cypher_op_map[op]

                                # All fields are stored as flat properties in Neo4j
                                param_name = f"filter_meta_{key}_{op}_{param_counter[0]}"
                                param_counter[0] += 1
                                filter_params_inner[param_name] = op_value

                                # Check if field is a date field (created_at, updated_at, etc.)
                                # Use datetime() function for date comparisons
                                if key in ("created_at", "updated_at") or key.endswith("_at"):
                                    condition_parts.append(
                                        f"n.{key} {cypher_op} datetime(${param_name})"
                                    )
                                else:
                                    condition_parts.append(f"n.{key} {cypher_op} ${param_name}")
                    else:
                        # All fields are stored as flat properties in Neo4j (simple equality)
                        param_name = f"filter_meta_{key}_{param_counter[0]}"
                        param_counter[0] += 1
                        filter_params_inner[param_name] = value
                        condition_parts.append(f"n.{key} = ${param_name}")

                return " AND ".join(condition_parts), filter_params_inner

            # Process filter structure
            param_counter = [
                len(filters)
            ]  # Use list to allow modification in nested function, start from len(filters) to avoid conflicts

            if isinstance(filter, dict):
                if "or" in filter:
                    # OR logic: at least one condition must match
                    or_conditions = []
                    for condition in filter["or"]:
                        if isinstance(condition, dict):
                            condition_str, filter_params_inner = build_filter_condition(
                                condition, param_counter
                            )
                            if condition_str:
                                or_conditions.append(f"({condition_str})")
                                filter_params.update(filter_params_inner)
                    if or_conditions:
                        where_clauses.append(f"({' OR '.join(or_conditions)})")

                elif "and" in filter:
                    # AND logic: all conditions must match
                    for condition in filter["and"]:
                        if isinstance(condition, dict):
                            condition_str, filter_params_inner = build_filter_condition(
                                condition, param_counter
                            )
                            if condition_str:
                                where_clauses.append(f"({condition_str})")
                                filter_params.update(filter_params_inner)

        where_str = " AND ".join(where_clauses) if where_clauses else ""
        if where_str:
            query = f"MATCH (n:Memory) WHERE {where_str} RETURN n.id AS id"
        else:
            query = "MATCH (n:Memory) RETURN n.id AS id"

        # Add user_name parameter
        if not self.config.use_multi_db and (self.config.user_name or user_name):
            params["user_name"] = user_name

        # Add knowledgebase_ids parameters
        if knowledgebase_ids and isinstance(knowledgebase_ids, list) and len(knowledgebase_ids) > 0:
            for idx, kb_id in enumerate(knowledgebase_ids):
                if isinstance(kb_id, str):
                    param_name = f"kb_id_{idx}"
                    params[param_name] = kb_id

        # Merge filter parameters
        if filter_params:
            params.update(filter_params)
        logger.info(f"[get_by_metadata] query: {query},params: {params}")
        print(f"[get_by_metadata] query: {query},params: {params}")

        with self.driver.session(database=self.db_name) as session:
            result = session.run(query, params)
            return [record["id"] for record in result]

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
                where_clauses.append(f"({' AND '.join(file_id_and_conditions)})")

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

    def clear(self, user_name: str | None = None) -> None:
        """
        Clear the entire graph if the target database exists.
        """
        # Step 1: clear Neo4j part via parent logic
        user_name = user_name if user_name else self.config.user_name
        super().clear(user_name=user_name)

        # Step2: Clear the vector db
        try:
            items = self.vec_db.get_by_filter({"user_name": user_name})
            if items:
                self.vec_db.delete([item.id for item in items])
                logger.info(f"Cleared {len(items)} vectors for user '{user_name}'.")
            else:
                logger.info(f"No vectors to clear for user '{user_name}'.")
        except Exception as e:
            logger.warning(f"Failed to clear vector DB for user '{user_name}': {e}")

    def drop_database(self) -> None:
        """
        Permanently delete the entire database this instance is using.
        WARNING: This operation is destructive and cannot be undone.
        """
        raise ValueError(
            f"Refusing to drop protected database: {self.db_name} in "
            f"Shared Database Multi-Tenant mode"
        )

    # Avoid enterprise feature
    def _ensure_database_exists(self):
        pass

    def _create_basic_property_indexes(self) -> None:
        """
        Create standard B-tree indexes on memory_type, created_at,
        and updated_at fields.
        Create standard B-tree indexes on user_name when use Shared Database
        Multi-Tenant Mode
        """
        # Step 1: Neo4j indexes
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

        # Step 2: VectorDB indexes
        try:
            if hasattr(self.vec_db, "ensure_payload_indexes"):
                self.vec_db.ensure_payload_indexes(["user_name", "memory_type", "status"])
            else:
                logger.debug("VecDB does not support payload index creation; skipping.")
        except Exception as e:
            logger.warning(f"Failed to create VecDB payload indexes: {e}")

    def _parse_node(self, node_data: dict[str, Any]) -> dict[str, Any]:
        """Parse Neo4j node and optionally fetch embedding from vector DB."""
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
        new_node = {"id": node.pop("id"), "memory": node.pop("memory", ""), "metadata": node}
        try:
            vec_item = self.vec_db.get_by_id(new_node["id"])
            if vec_item and vec_item.vector:
                new_node["metadata"]["embedding"] = vec_item.vector
        except Exception as e:
            logger.warning(f"Failed to fetch vector for node {new_node['id']}: {e}")
            new_node["metadata"]["embedding"] = None
        return new_node
