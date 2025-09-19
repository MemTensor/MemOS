from typing import Any
from pymilvus import MilvusClient, DataType
from memos.configs.vec_db import MilvusVecDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.vec_dbs.base import BaseVecDB
from memos.vec_dbs.item import VecDBItem


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

        self.config = config

        # Create Milvus client
        self.client = MilvusClient(uri=self.config.uri)
        self.schema = self.create_schema()
        self.index_params = self.create_index()
        self.create_collection()

    def create_schema(self):
        """Create schema for the milvus collection."""
        schema = self.client.create_schema(auto_id=False, enable_dynamic_field=True)
        schema.add_field(field_name="id", datatype=DataType.VARCHAR, max_length=65535, is_primary=True)
        schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=self.config.vector_dimension)
        schema.add_field(field_name="payload", datatype=DataType.JSON)

        return schema

    def create_index(self):
        """Create index for the milvus collection."""
        index_params = self.client.prepare_index_params()
        index_params.add_index(field_name="vector", index_type="FLAT", metric_type=self._get_metric_type())

        return index_params


    def create_collection(self) -> None:
        """Create a new collection with specified parameters."""
        for collection_name in self.config.collection_name:
            if self.collection_exists(collection_name):
                logger.warning(
                    f"Collection '{collection_name}' already exists. Skipping creation."
                )
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
            logger.warning(
                f"Collection '{collection_name}' already exists. Skipping creation."
            )
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

    def search(
        self, query_vector: list[float], collection_name: str, top_k: int, filter: dict[str, Any] | None = None
    ) -> list[VecDBItem]:
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
        expr = self._dict_to_expr(filter) if filter else None
        
        results = self.client.search(
            collection_name=collection_name,
            data=[query_vector],
            limit=top_k,
            filter=expr,
            output_fields=["*"],  # Return all fields
        )
        
        items = []
        for hit in results[0]:
            entity = hit.get("entity", {})
            
            items.append(VecDBItem(
                id=str(hit["id"]),
                vector=entity.get("vector"),
                payload=entity.get("payload", {}),
                score=1-float(hit["distance"]),
            ))
        
        logger.info(f"Milvus search completed with {len(items)} results.")
        return items

    def _dict_to_expr(self, filter_dict: dict[str, Any]) -> str:
        """Convert a dictionary filter to a Milvus expression string."""
        conditions = []
        for field, value in filter_dict.items():
            # For JSON fields, we need to use payload["field"] syntax
            if isinstance(value, str):
                conditions.append(f"payload['{field}'] == '{value}'")
            elif isinstance(value, list) and len(value) == 0:
                # Skip empty lists as they cause Milvus query syntax errors
                continue
            elif isinstance(value, list) and len(value) > 0:
                conditions.append(f"payload['{field}'] in {value}")
            else:
                conditions.append(f"payload['{field}'] == '{value}'")
        return " and ".join(conditions)

    def _get_metric_type(self) -> str:
        """Get the metric type for search."""
        metric_map = {
            "cosine": "COSINE",
            "euclidean": "L2",
            "dot": "IP",
        }
        return metric_map.get(self.config.distance_metric, "L2")

    def get_by_id(self, collection_name: str, id: str) -> VecDBItem | None:
        """Get a single item by ID."""
        results = self.client.get(
            collection_name=collection_name,
            ids=[id],
        )

        if not results:
            return None

        entity = results[0]
        payload = {k: v for k, v in entity.items() if k not in ["id", "vector", "score"]}
        
        return VecDBItem(
            id=entity["id"],
            vector=entity.get("vector"),
            payload=payload,
        )

    def get_by_ids(self, collection_name: str, ids: list[str]) -> list[VecDBItem]:
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
            items.append(VecDBItem(
                id=entity["id"],
                vector=entity.get("vector"),
                payload=payload,
            ))
        
        return items

    def get_by_filter(self, collection_name: str, filter: dict[str, Any], scroll_limit: int = 100) -> list[VecDBItem]:
        """
        Retrieve all items that match the given filter criteria using query_iterator.

        Args:
            filter: Payload filters to match against stored items
            scroll_limit: Maximum number of items to retrieve per batch (batch_size)

        Returns:
            List of items including vectors and payload that match the filter
        """
        expr = self._dict_to_expr(filter) if filter else None
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
                    
                # Convert batch results to VecDBItem objects
                for entity in batch_results:
                    payload = {k: v for k, v in entity.items() if k not in ["id", "vector", "score"]}
                    all_items.append(VecDBItem(
                        id=entity["id"],
                        vector=entity.get("vector"),
                        payload=payload,
                    ))
        except Exception as e:
            logger.warning(f"Error during Milvus query iteration: {e}. Returning {len(all_items)} items found so far.")
            # 返回已经找到的项目，而不是空列表
        finally:
            # Close the iterator
            iterator.close()

        logger.info(f"Milvus retrieve by filter completed with {len(all_items)} results.")
        return all_items

    def get_all(self, collection_name: str, scroll_limit=100) -> list[VecDBItem]:
        """Retrieve all items in the vector database."""
        return self.get_by_filter(collection_name, {}, scroll_limit=scroll_limit)

    def count(self, collection_name: str, filter: dict[str, Any] | None = None) -> int:
        """Count items in the database, optionally with filter."""
        if filter:
            # If there's a filter, use query method
            expr = self._dict_to_expr(filter)
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

    def add(self, collection_name: str, data: list[VecDBItem | dict[str, Any]]) -> None:
        """
        Add data to the vector database.

        Args:
            data: List of VecDBItem objects or dictionaries containing:
                - 'id': unique identifier
                - 'vector': embedding vector
                - 'payload': additional fields for filtering/retrieval
        """
        entities = []
        for item in data:
            if isinstance(item, dict):
                item = item.copy()
                item = VecDBItem.from_dict(item)
            
            # Prepare entity data
            entity = {
                "id": item.id,
                "vector": item.vector,
                "payload": item.payload if item.payload else {}
            }
            
            entities.append(entity)

        # Use upsert to be safe (insert or update)
        self.client.upsert(
            collection_name=collection_name,
            data=entities,
        )

    def update(self, collection_name: str, id: str, data: VecDBItem | dict[str, Any]) -> None:
        """Update an item in the vector database."""
        if isinstance(data, dict):
            data = data.copy()
            data = VecDBItem.from_dict(data)

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

    def upsert(self, collection_name: str, data: list[VecDBItem | dict[str, Any]]) -> None:
        """
        Add or update data in the vector database.

        If an item with the same ID exists, it will be updated.
        Otherwise, it will be added as a new item.
        """
        # Reuse add method since it already uses upsert
        self.add(collection_name, data)

    def delete(self, collection_name: str, ids: list[str]) -> None:
        """Delete items from the vector database."""
        self.client.delete(
            collection_name=collection_name,
            ids=ids,
        )