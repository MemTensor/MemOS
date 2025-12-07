from typing import Any

from memos.configs.vec_db import MilvusVecDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.vec_dbs.base import BaseVecDB
from memos.vec_dbs.item import MilvusVecDBItem


logger = get_logger(__name__)


class MilvusVecDB(BaseVecDB):
    """Milvus vector database implementation."""

    @require_python_package(
        import_name="pymilvus",
        install_command="pip install -U pymilvus",
        install_link="https://milvus.io/docs/install-pymilvus.md",
    )
    def __init__(self, config: MilvusVecDBConfig):
        """Initialize the Milvus vector database and the collection."""
        from pymilvus import MilvusClient

        self.config = config

        # Create Milvus client
        self.client = MilvusClient(
            uri=self.config.uri, user=self.config.user_name, password=self.config.password
        )
        self.schema = self.create_schema()
        self.index_params = self.create_index()
        self.create_collection()

    def create_schema(self):
        """Create schema for the milvus collection."""
        from pymilvus import DataType, Function, FunctionType

        schema = self.client.create_schema(auto_id=False, enable_dynamic_field=True)
        schema.add_field(
            field_name="id", datatype=DataType.VARCHAR, max_length=65535, is_primary=True
        )
        analyzer_params = {"tokenizer": "standard", "filter": ["lowercase"]}
        schema.add_field(
            field_name="memory",
            datatype=DataType.VARCHAR,
            max_length=65535,
            analyzer_params=analyzer_params,
            enable_match=True,
            enable_analyzer=True,
        )
        schema.add_field(field_name="original_text", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(
            field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=self.config.vector_dimension
        )
        schema.add_field(field_name="payload", datatype=DataType.JSON)

        schema.add_field(field_name="sparse_vector", datatype=DataType.SPARSE_FLOAT_VECTOR)
        bm25_function = Function(
            name="bm25",
            function_type=FunctionType.BM25,
            input_field_names=["memory"],
            output_field_names="sparse_vector",
        )
        schema.add_function(bm25_function)

        return schema

    def create_index(self):
        """Create index for the milvus collection."""
        index_params = self.client.prepare_index_params()
        index_params.add_index(
            field_name="vector", index_type="FLAT", metric_type=self._get_metric_type()
        )
        index_params.add_index(
            field_name="sparse_vector",
            index_type="SPARSE_INVERTED_INDEX",
            metric_type="BM25",
        )

        return index_params

    def create_collection(self) -> None:
        """Create a new collection with specified parameters."""
        for collection_name in self.config.collection_name:
            if self.collection_exists(collection_name):
                logger.warning(f"Collection '{collection_name}' already exists. Skipping creation.")
                continue

            self.client.create_collection(
                collection_name=collection_name,
                dimension=self.config.vector_dimension,
                metric_type=self._get_metric_type(),
                schema=self.schema,
                index_params=self.index_params,
            )

            logger.info(
                f"Collection '{collection_name}' created with {self.config.vector_dimension} dimensions."
            )

    def create_collection_by_name(self, collection_name: str) -> None:
        """Create a new collection with specified parameters."""
        if self.collection_exists(collection_name):
            logger.warning(f"Collection '{collection_name}' already exists. Skipping creation.")
            return

        self.client.create_collection(
            collection_name=collection_name,
            dimension=self.config.vector_dimension,
            metric_type=self._get_metric_type(),
            schema=self.schema,
            index_params=self.index_params,
        )

    def list_collections(self) -> list[str]:
        """List all collections."""
        return self.client.list_collections()

    def delete_collection(self, name: str) -> None:
        """Delete a collection."""
        self.client.drop_collection(name)

    def collection_exists(self, name: str) -> bool:
        """Check if a collection exists."""
        return self.client.has_collection(collection_name=name)

    def _dense_search(
        self,
        collection_name: str,
        query_vector: list[float],
        top_k: int,
        filter: str = "",
        **kwargs: Any,
    ) -> list[list[dict]]:
        """Dense search for similar items in the database."""
        results = self.client.search(
            collection_name=collection_name,
            data=[query_vector],
            limit=top_k,
            filter=filter,
            output_fields=["*"],
            anns_field="vector",
        )
        return results

    def _sparse_search(
        self,
        collection_name: str,
        query: str,
        top_k: int,
        filter: str = "",
        **kwargs: Any,
    ) -> list[list[dict]]:
        """Sparse search for similar items in the database."""
        results = self.client.search(
            collection_name=collection_name,
            data=[query],
            limit=top_k,
            filter=filter,
            output_fields=["*"],
            anns_field="sparse_vector",
        )
        return results

    def _hybrid_search(
        self,
        collection_name: str,
        query_vector: list[float],
        query: str,
        top_k: int,
        filter: str | None = None,
        ranker_type: str = "rrf",  # rrf, weighted
        sparse_weight=1.0,
        dense_weight=1.0,
        **kwargs: Any,
    ) -> list[list[dict]]:
        """Hybrid search for similar items in the database."""
        from pymilvus import AnnSearchRequest, RRFRanker, WeightedRanker

        # Set up BM25 search request
        expr = filter if filter else None
        sparse_request = AnnSearchRequest(
            data=[query],
            anns_field="sparse_vector",
            param={"metric_type": "BM25"},
            limit=top_k,
            expr=expr,
        )
        # Set up dense vector search request
        dense_request = AnnSearchRequest(
            data=[query_vector],
            anns_field="vector",
            param={"metric_type": self._get_metric_type()},
            limit=top_k,
            expr=expr,
        )
        ranker = (
            RRFRanker() if ranker_type == "rrf" else WeightedRanker(sparse_weight, dense_weight)
        )
        results = self.client.hybrid_search(
            collection_name=collection_name,
            reqs=[sparse_request, dense_request],
            ranker=ranker,
            limit=top_k,
            output_fields=["*"],
        )
        return results

    def search(
        self,
        query_vector: list[float],
        query: str,
        collection_name: str,
        top_k: int,
        filter: dict[str, Any] | None = None,
        search_type: str = "dense",  # dense, sparse, hybrid
    ) -> list[MilvusVecDBItem]:
        """
        Search for similar items in the database.

        Args:
            query_vector: Single vector to search
            collection_name: Name of the collection to search
            top_k: Number of results to return
            filter: Payload filters

        Returns:
            List of search results with distance scores and payloads.
        """
        # Convert filter to Milvus expression
        logger.info(f"filter for milvus: {filter}")
        expr = self._dict_to_expr(filter) if filter else ""

        search_func_map = {
            "dense": self._dense_search,
            "sparse": self._sparse_search,
            "hybrid": self._hybrid_search,
        }
        try:
            results = search_func_map[search_type](
                collection_name=collection_name,
                query_vector=query_vector,
                query=query,
                top_k=top_k,
                filter=expr,
            )

            items = []
            for hit in results[0]:
                entity = hit.get("entity", {})

                items.append(
                    MilvusVecDBItem(
                        id=str(entity.get("id")),
                        memory=entity.get("memory"),
                        original_text=entity.get("original_text"),
                        vector=entity.get("vector"),
                        payload=entity.get("payload", {}),
                        score=1 - float(hit["distance"]),
                    )
                )
        except Exception as e:
            logger.error("Error in _%s_search: %s", search_type, e)
            return []

        logger.info(f"Milvus search completed with {len(items)} results.")
        return items

    def _dict_to_expr(self, filter_dict: dict[str, Any]) -> str:
        """Convert a dictionary filter to a Milvus expression string.

        Supports complex query syntax with logical operators, comparison operators,
        arithmetic operators, array operators, and string pattern matching.

        Args:
            filter_dict: Dictionary containing filter conditions

        Returns:
            Milvus expression string
        """
        if not filter_dict:
            return ""

        return self._build_expression(filter_dict)

    def _build_expression(self, condition: Any) -> str:
        """Build expression from condition dict or value."""
        if isinstance(condition, dict):
            # Handle logical operators
            if "and" in condition:
                return self._handle_logical_and(condition["and"])
            elif "or" in condition:
                return self._handle_logical_or(condition["or"])
            elif "not" in condition:
                return self._handle_logical_not(condition["not"])
            else:
                # Handle field conditions
                return self._handle_field_conditions(condition)
        else:
            # Simple value comparison
            return f"{condition}"

    def _handle_logical_and(self, conditions: list) -> str:
        """Handle AND logical operator."""
        if not conditions:
            return ""
        expressions = [self._build_expression(cond) for cond in conditions if cond is not None]
        expressions = [expr for expr in expressions if expr]
        if not expressions:
            return ""
        return f"({' and '.join(expressions)})"

    def _handle_logical_or(self, conditions: list) -> str:
        """Handle OR logical operator."""
        if not conditions:
            return ""
        expressions = [self._build_expression(cond) for cond in conditions if cond is not None]
        expressions = [expr for expr in expressions if expr]
        if not expressions:
            return ""
        return f"({' or '.join(expressions)})"

    def _handle_logical_not(self, condition: Any) -> str:
        """Handle NOT logical operator."""
        expr = self._build_expression(condition)
        if not expr:
            return ""
        return f"(not {expr})"

    def _handle_field_conditions(self, condition_dict: dict[str, Any]) -> str:
        """Handle field-specific conditions."""
        conditions = []

        for field, value in condition_dict.items():
            if value is None:
                continue

            field_expr = self._build_field_expression(field, value)
            if field_expr:
                conditions.append(field_expr)

        if not conditions:
            return ""
        return " and ".join(conditions)

    def _build_field_expression(self, field: str, value: Any) -> str:
        """Build expression for a single field."""
        # Handle comparison operators
        if isinstance(value, dict):
            if len(value) == 1:
                op, operand = next(iter(value.items()))
                op_lower = op.lower()

                if op_lower == "in":
                    return self._handle_in_operator(field, operand)
                elif op_lower == "contains":
                    return self._handle_contains_operator(field, operand, case_sensitive=True)
                elif op_lower == "icontains":
                    return self._handle_contains_operator(field, operand, case_sensitive=False)
                elif op_lower == "like":
                    return self._handle_like_operator(field, operand)
                elif op_lower in ["gte", "lte", "gt", "lt", "ne"]:
                    return self._handle_comparison_operator(field, op_lower, operand)
                else:
                    # Unknown operator, treat as equality
                    return f"payload['{field}'] == {self._format_value(operand)}"
            else:
                # Multiple operators, handle each one
                sub_conditions = []
                for op, operand in value.items():
                    op_lower = op.lower()
                    if op_lower in [
                        "gte",
                        "lte",
                        "gt",
                        "lt",
                        "ne",
                        "in",
                        "contains",
                        "icontains",
                        "like",
                    ]:
                        sub_expr = self._build_field_expression(field, {op: operand})
                        if sub_expr:
                            sub_conditions.append(sub_expr)

                if sub_conditions:
                    return f"({' and '.join(sub_conditions)})"
                return ""
        else:
            # Simple equality
            return f"payload['{field}'] == {self._format_value(value)}"

    def _handle_in_operator(self, field: str, values: list) -> str:
        """Handle IN operator for arrays."""
        if not isinstance(values, list) or not values:
            return ""

        formatted_values = [self._format_value(v) for v in values]
        return f"payload['{field}'] in [{', '.join(formatted_values)}]"

    def _handle_contains_operator(self, field: str, value: Any, case_sensitive: bool = True) -> str:
        """Handle CONTAINS/ICONTAINS operator."""
        formatted_value = self._format_value(value)
        if case_sensitive:
            return f"json_contains(payload['{field}'], {formatted_value})"
        else:
            # For case-insensitive contains, we need to use LIKE with lower case
            return f"(not json_contains(payload['{field}'], {formatted_value}))"

    def _handle_like_operator(self, field: str, pattern: str) -> str:
        """Handle LIKE operator for string pattern matching."""
        # Convert SQL-like pattern to Milvus-like pattern
        return f"payload['{field}'] like '{pattern}'"

    def _handle_comparison_operator(self, field: str, operator: str, value: Any) -> str:
        """Handle comparison operators (gte, lte, gt, lt, ne)."""
        milvus_op = {"gte": ">=", "lte": "<=", "gt": ">", "lt": "<", "ne": "!="}.get(operator, "==")

        formatted_value = self._format_value(value)
        return f"payload['{field}'] {milvus_op} {formatted_value}"

    def _format_value(self, value: Any) -> str:
        """Format value for Milvus expression."""
        if isinstance(value, str):
            return f"'{value}'"
        elif isinstance(value, int | float):
            return str(value)
        elif isinstance(value, bool):
            return str(value).lower()
        elif isinstance(value, list):
            formatted_items = [self._format_value(item) for item in value]
            return f"[{', '.join(formatted_items)}]"
        elif value is None:
            return "null"
        else:
            return f"'{value!s}'"

    def _get_metric_type(self) -> str:
        """Get the metric type for search."""
        metric_map = {
            "cosine": "COSINE",
            "euclidean": "L2",
            "dot": "IP",
        }
        return metric_map.get(self.config.distance_metric, "L2")

    def get_by_id(self, collection_name: str, id: str) -> MilvusVecDBItem | None:
        """Get a single item by ID."""
        results = self.client.get(
            collection_name=collection_name,
            ids=[id],
        )

        if not results:
            return None

        entity = results[0]
        payload = {k: v for k, v in entity.items() if k not in ["id", "vector", "score"]}

        return MilvusVecDBItem(
            id=entity["id"],
            memory=entity.get("memory"),
            original_text=entity.get("original_text"),
            vector=entity.get("vector"),
            payload=payload,
        )

    def get_by_ids(self, collection_name: str, ids: list[str]) -> list[MilvusVecDBItem]:
        """Get multiple items by their IDs."""
        results = self.client.get(
            collection_name=collection_name,
            ids=ids,
        )

        if not results:
            return []

        items = []
        for entity in results:
            payload = {k: v for k, v in entity.items() if k not in ["id", "vector", "score"]}
            items.append(
                MilvusVecDBItem(
                    id=entity["id"],
                    memory=entity.get("memory"),
                    original_text=entity.get("original_text"),
                    vector=entity.get("vector"),
                    payload=payload,
                )
            )

        return items

    def get_by_filter(
        self, collection_name: str, filter: dict[str, Any], scroll_limit: int = 100
    ) -> list[MilvusVecDBItem]:
        """
        Retrieve all items that match the given filter criteria using query_iterator.

        Args:
            filter: Payload filters to match against stored items
            scroll_limit: Maximum number of items to retrieve per batch (batch_size)

        Returns:
            List of items including vectors and payload that match the filter
        """
        expr = self._dict_to_expr(filter) if filter else ""
        all_items = []

        # Use query_iterator for efficient pagination
        iterator = self.client.query_iterator(
            collection_name=collection_name,
            filter=expr,
            batch_size=scroll_limit,
            output_fields=["*"],  # Include all fields including payload
        )

        # Iterate through all batches
        try:
            while True:
                batch_results = iterator.next()

                if not batch_results:
                    break

                # Convert batch results to MilvusVecDBItem objects
                for entity in batch_results:
                    # Extract the actual payload from Milvus entity
                    payload = entity.get("payload", {})
                    all_items.append(
                        MilvusVecDBItem(
                            id=entity["id"],
                            memory=entity.get("memory"),
                            original_text=entity.get("original_text"),
                            vector=entity.get("vector"),
                            payload=payload,
                        )
                    )
        except Exception as e:
            logger.warning(
                f"Error during Milvus query iteration: {e}. Returning {len(all_items)} items found so far."
            )
        finally:
            # Close the iterator
            iterator.close()

        logger.info(f"Milvus retrieve by filter completed with {len(all_items)} results.")
        return all_items

    def get_all(self, collection_name: str, scroll_limit=100) -> list[MilvusVecDBItem]:
        """Retrieve all items in the vector database."""
        return self.get_by_filter(collection_name, {}, scroll_limit=scroll_limit)

    def count(self, collection_name: str, filter: dict[str, Any] | None = None) -> int:
        """Count items in the database, optionally with filter."""
        if filter:
            # If there's a filter, use query method
            expr = self._dict_to_expr(filter) if filter else ""
            results = self.client.query(
                collection_name=collection_name,
                filter=expr,
                output_fields=["id"],
            )
            return len(results)
        else:
            # For counting all items, use get_collection_stats for accurate count
            stats = self.client.get_collection_stats(collection_name)
            # Extract row count from stats - stats is a dict, not a list
            return int(stats.get("row_count", 0))

    def add(self, collection_name: str, data: list[MilvusVecDBItem | dict[str, Any]]) -> None:
        """
        Add data to the vector database.

        Args:
            data: List of MilvusVecDBItem objects or dictionaries containing:
                - 'id': unique identifier
                - 'memory': memory string
                - 'vector': embedding vector
                - 'payload': additional fields for filtering/retrieval
        """
        entities = []
        for item in data:
            if isinstance(item, dict):
                item = item.copy()
                item = MilvusVecDBItem.from_dict(item)

            # Prepare entity data
            entity = {
                "id": item.id[:65000],
                "memory": item.memory[:65000],
                "original_text": item.original_text[:65000],
                "vector": item.vector,
                "payload": item.payload if item.payload else {},
            }

            entities.append(entity)

        # Use upsert to be safe (insert or update)
        self.client.upsert(
            collection_name=collection_name,
            data=entities,
        )

    def update(self, collection_name: str, id: str, data: MilvusVecDBItem | dict[str, Any]) -> None:
        """Update an item in the vector database."""
        if id != data.id:
            raise ValueError(
                f"The id of the data to update must be the same as the id of the item to update, ID mismatch: expected {id}, got {data.id}"
            )
        if isinstance(data, dict):
            data = data.copy()
            data = MilvusVecDBItem.from_dict(data)

        # Use upsert for updates
        self.upsert(collection_name, [data])

    def ensure_payload_indexes(self, fields: list[str]) -> None:
        """
        Create payload indexes for specified fields in the collection.
        This is idempotent: it will skip if index already exists.

        Args:
            fields (list[str]): List of field names to index (as keyword).
        """
        # Note: Milvus doesn't have the same concept of payload indexes as Qdrant
        # Field indexes are created automatically for scalar fields
        logger.info(f"Milvus automatically indexes scalar fields: {fields}")

    def upsert(self, collection_name: str, data: list[MilvusVecDBItem | dict[str, Any]]) -> None:
        """
        Add or update data in the vector database.

        If an item with the same ID exists, it will be updated.
        Otherwise, it will be added as a new item.
        """
        # Reuse add method since it already uses upsert
        self.add(collection_name, data)

    def delete(self, collection_name: str, ids: list[str]) -> None:
        """Delete items from the vector database."""
        if not ids:
            return
        self.client.delete(
            collection_name=collection_name,
            ids=ids,
        )
