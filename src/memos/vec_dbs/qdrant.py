from typing import Any

from memos.configs.vec_db import QdrantVecDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.vec_dbs.base import BaseVecDB
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)


class QdrantVecDB(BaseVecDB):
    """Qdrant vector database implementation."""

    @require_python_package(
        import_name="qdrant_client",
        install_command="pip install qdrant-client",
        install_link="https://python-client.qdrant.tech/",
    )
    def __init__(self, config: QdrantVecDBConfig):
        """Initialize the Qdrant vector database and the collection."""
        from qdrant_client import QdrantClient

        self.config = config
        # Default payload fields we always index because query filters rely on them
        self._default_payload_index_fields = [
            "memory_type",
            "status",
            "vector_sync",
            "user_name",
        ]

        client_kwargs: dict[str, Any] = {}
        if self.config.url:
            client_kwargs["url"] = self.config.url
            if self.config.api_key:
                client_kwargs["api_key"] = self.config.api_key
        else:
            client_kwargs.update(
                {
                    "host": self.config.host,
                    "port": self.config.port,
                    "path": self.config.path,
                }
            )

            # If both host and port are None, we are running in local/embedded mode
            if self.config.host is None and self.config.port is None:
                logger.warning(
                    "Qdrant is running in local mode (host and port are both None). "
                    "In local mode, there may be race conditions during concurrent reads/writes. "
                    "It is strongly recommended to deploy a standalone Qdrant server "
                    "(e.g., via Docker: https://qdrant.tech/documentation/quickstart/)."
                )

        self.client = QdrantClient(**client_kwargs)
        self.create_collection()
        # Ensure common payload indexes exist (idempotent)
        try:
            self.ensure_payload_indexes(self._default_payload_index_fields)
        except Exception as e:
            logger.warning(f"Failed to ensure default payload indexes: {e}")

    def create_collection(self) -> None:
        """Create a new collection with specified parameters."""
        from qdrant_client.http import models
        from qdrant_client.http.exceptions import UnexpectedResponse

        if self.collection_exists(self.config.collection_name):
            collection_info = self.client.get_collection(self.config.collection_name)
            logger.warning(
                f"Collection '{self.config.collection_name}' (vector dimension: {collection_info.config.params.vectors.size}) already exists. Skipping creation."
            )

            return

        # Map string distance metric to Qdrant Distance enum
        distance_map = {
            "cosine": models.Distance.COSINE,
            "euclidean": models.Distance.EUCLID,
            "dot": models.Distance.DOT,
        }

        try:
            self.client.create_collection(
                collection_name=self.config.collection_name,
                vectors_config=models.VectorParams(
                    size=self.config.vector_dimension,
                    distance=distance_map[self.config.distance_metric],
                ),
            )
        except UnexpectedResponse as err:
            # Cloud Qdrant returns 409 when the collection already exists; tolerate and continue.
            if getattr(err, "status_code", None) == 409 or "already exists" in str(err).lower():
                logger.warning(
                    f"Collection '{self.config.collection_name}' already exists. Skipping creation."
                )
                return
            raise
        except Exception:
            # Bubble up other exceptions so callers can observe failures
            raise

        logger.info(
            f"Collection '{self.config.collection_name}' created with {self.config.vector_dimension} dimensions."
        )

    def list_collections(self) -> list[str]:
        """List all collections."""
        collections = self.client.get_collections()
        return [collection.name for collection in collections.collections]

    def delete_collection(self, name: str) -> None:
        """Delete a collection."""
        self.client.delete_collection(collection_name=name)

    def collection_exists(self, name: str) -> bool:
        """Check if a collection exists."""
        try:
            self.client.get_collection(collection_name=name)
            return True
        except Exception:
            return False

    def search(
        self, query_vector: list[float], top_k: int, filter: dict[str, Any] | None = None
    ) -> list[VecDBItem]:
        """
        Search for similar items in the database.

        Args:
            query_vector: Single vector to search
            top_k: Number of results to return
            filter: Payload filters

        Returns:
            List of search results with distance scores and payloads.
        """
        qdrant_filter = self._dict_to_filter(filter) if filter else None
        response = self.client.search(
            collection_name=self.config.collection_name,
            query_vector=query_vector,
            limit=top_k,
            query_filter=qdrant_filter,
            with_vectors=True,
            with_payload=True,
        )
        logger.info(f"Qdrant search completed with {len(response)} results.")
        return [
            VecDBItem(
                id=point.id,
                vector=point.vector,
                payload=point.payload,
                score=point.score,
            )
            for point in response
        ]

    def _dict_to_filter(self, filter_dict: dict[str, Any]) -> Any:
        from qdrant_client.http import models

        """Convert a dictionary filter to a Qdrant Filter object."""
        conditions = []

        for field, value in filter_dict.items():
            # Simple exact match for now
            # TODO: Extend this to support more complex conditions
            conditions.append(
                models.FieldCondition(key=field, match=models.MatchValue(value=value))
            )

        return models.Filter(must=conditions)

    def get_by_id(self, id: str) -> VecDBItem | None:
        """Get a single item by ID."""
        response = self.client.retrieve(
            collection_name=self.config.collection_name,
            ids=[id],
            with_payload=True,
            with_vectors=True,
        )

        if not response:
            return None

        point = response[0]
        return VecDBItem(
            id=point.id,
            vector=point.vector,
            payload=point.payload,
        )

    def get_by_ids(self, ids: list[str]) -> list[VecDBItem]:
        """Get multiple items by their IDs."""
        response = self.client.retrieve(
            collection_name=self.config.collection_name,
            ids=ids,
            with_payload=True,
            with_vectors=True,
        )

        if not response:
            return []

        return [
            VecDBItem(
                id=point.id,
                vector=point.vector,
                payload=point.payload,
            )
            for point in response
        ]

    def get_by_filter(self, filter: dict[str, Any], scroll_limit: int = 100) -> list[VecDBItem]:
        """
        Retrieve all items that match the given filter criteria.

        Args:
            filter: Payload filters to match against stored items
            scroll_limit: Maximum number of items to retrieve per scroll request

        Returns:
            List of items including vectors and payload that match the filter
        """
        qdrant_filter = self._dict_to_filter(filter) if filter else None
        all_points = []
        offset = None

        # Use scroll to paginate through all matching points
        while True:
            points, offset = self.client.scroll(
                collection_name=self.config.collection_name,
                limit=scroll_limit,
                scroll_filter=qdrant_filter,
                offset=offset,
                with_vectors=True,
                with_payload=True,
            )

            if not points:
                break

            all_points.extend(points)

            # Update offset for next iteration
            if offset is None:
                break

        logger.info(f"Qdrant retrieve by filter completed with {len(all_points)} results.")
        return [
            VecDBItem(
                id=point.id,
                vector=point.vector,
                payload=point.payload,
            )
            for point in all_points
        ]

    def get_all(self, scroll_limit=100) -> list[VecDBItem]:
        """Retrieve all items in the vector database."""
        return self.get_by_filter({}, scroll_limit=scroll_limit)

    def count(self, filter: dict[str, Any] | None = None) -> int:
        """Count items in the database, optionally with filter."""
        qdrant_filter = None
        if filter:
            qdrant_filter = self._dict_to_filter(filter)

        response = self.client.count(
            collection_name=self.config.collection_name, count_filter=qdrant_filter
        )

        return response.count

    def add(self, data: list[VecDBItem | dict[str, Any]]) -> None:
        from qdrant_client.http import models

        """
        Add data to the vector database.

        Args:
            data: List of VecDBItem objects or dictionaries containing:
                - 'id': unique identifier
                - 'vector': embedding vector
                - 'payload': additional fields for filtering/retrieval
        """
        points = []
        for item in data:
            if isinstance(item, dict):
                item = item.copy()
                item = VecDBItem.from_dict(item)
            point = models.PointStruct(id=item.id, vector=item.vector, payload=item.payload)
            points.append(point)

        self.client.upsert(collection_name=self.config.collection_name, points=points)

    def update(self, id: str, data: VecDBItem | dict[str, Any]) -> None:
        """Update an item in the vector database."""
        from qdrant_client.http import models

        if isinstance(data, dict):
            data = data.copy()
            data = VecDBItem.from_dict(data)

        if data.vector:
            # For vector updates (with or without payload), use upsert with the same ID
            self.client.upsert(
                collection_name=self.config.collection_name,
                points=[models.PointStruct(id=id, vector=data.vector, payload=data.payload)],
            )
        else:
            # For payload-only updates
            self.client.set_payload(
                collection_name=self.config.collection_name, payload=data.payload, points=[id]
            )

    def ensure_payload_indexes(self, fields: list[str]) -> None:
        """
        Create payload indexes for specified fields in the collection.
        This is idempotent: it will skip if index already exists.

        Args:
            fields (list[str]): List of field names to index (as keyword).
        """
        for field in fields:
            try:
                self.client.create_payload_index(
                    collection_name=self.config.collection_name,
                    field_name=field,
                    field_schema="keyword",  # Could be extended in future
                )
                logger.debug(f"Qdrant payload index on '{field}' ensured.")
            except Exception as e:
                logger.warning(f"Failed to create payload index on '{field}': {e}")

    def upsert(self, data: list[VecDBItem | dict[str, Any]]) -> None:
        """
        Add or update data in the vector database.

        If an item with the same ID exists, it will be updated.
        Otherwise, it will be added as a new item.
        """
        # Qdrant's upsert operation already handles this logic
        self.add(data)

    def delete(self, ids: list[str]) -> None:
        from qdrant_client.http import models

        """Delete items from the vector database."""
        point_ids: list[str | int] = ids
        self.client.delete(
            collection_name=self.config.collection_name,
            points_selector=models.PointIdsList(points=point_ids),
        )
