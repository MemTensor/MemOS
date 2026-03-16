import re

from collections import defaultdict
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

    def _sanitize_collection_name(self, name: str) -> str:
        """Normalize user-scope names so they are safe as Qdrant collection names."""
        normalized = (name or "").strip()
        if not normalized:
            return self.config.collection_name

        # Keep a conservative charset to avoid backend-specific naming issues.
        normalized = re.sub(r"[^a-zA-Z0-9_-]", "_", normalized).strip("_")
        if not normalized:
            return self.config.collection_name

        return normalized[:255]

    def _extract_user_scope(self, data: dict[str, Any] | None) -> str | None:
        """Extract user scope from payload/filter for per-user collection routing."""
        if not isinstance(data, dict):
            return None

        for key in ("user_id", "user_name"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        metadata = data.get("metadata")
        if isinstance(metadata, dict):
            for key in ("user_id", "user_name"):
                value = metadata.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

            metadata_info = metadata.get("info")
            if isinstance(metadata_info, dict):
                for key in ("user_id", "user_name"):
                    value = metadata_info.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()

        info = data.get("info")
        if isinstance(info, dict):
            for key in ("user_id", "user_name"):
                value = info.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

        return None

    def _resolve_collection_name(
        self,
        *,
        payload: dict[str, Any] | None = None,
        filter_dict: dict[str, Any] | None = None,
    ) -> str:
        """Resolve collection name from payload/filter, falling back to default config."""
        user_scope = self._extract_user_scope(payload) or self._extract_user_scope(filter_dict)
        if user_scope:
            return self._sanitize_collection_name(user_scope)
        return self.config.collection_name

    def _strip_scope_filter(self, filter_dict: dict[str, Any] | None) -> dict[str, Any] | None:
        """Drop user scope keys from filter when collection is already user-scoped."""
        if not filter_dict:
            return filter_dict

        effective_filter = dict(filter_dict)
        effective_filter.pop("user_id", None)
        effective_filter.pop("user_name", None)
        return effective_filter

    def _all_candidate_collections(self) -> list[str]:
        """Return all collections with default collection first for compatibility."""
        collections = self.list_collections()
        ordered = [self.config.collection_name]
        ordered.extend(name for name in collections if name != self.config.collection_name)
        return ordered

    def _ensure_collection_ready(self, collection_name: str) -> None:
        """Create collection and payload indexes if missing."""
        if self.collection_exists(collection_name):
            return

        self._create_collection_by_name(collection_name)
        try:
            self.ensure_payload_indexes(
                self._default_payload_index_fields,
                collection_name=collection_name,
            )
        except Exception as e:
            logger.warning(
                f"Failed to ensure payload indexes for collection '{collection_name}': {e}"
            )

    def create_collection(self) -> None:
        """Create the default configured collection with specified parameters."""
        self._create_collection_by_name(self.config.collection_name)

    def _create_collection_by_name(self, collection_name: str) -> None:
        """Create a specific collection with configured vector parameters."""
        from qdrant_client.http import models
        from qdrant_client.http.exceptions import UnexpectedResponse

        if self.collection_exists(collection_name):
            collection_info = self.client.get_collection(collection_name)
            logger.warning(
                f"Collection '{collection_name}' (vector dimension: {collection_info.config.params.vectors.size}) already exists. Skipping creation."
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
                collection_name=collection_name,
                vectors_config=models.VectorParams(
                    size=self.config.vector_dimension,
                    distance=distance_map[self.config.distance_metric],
                ),
            )
        except UnexpectedResponse as err:
            # Cloud Qdrant returns 409 when the collection already exists; tolerate and continue.
            if getattr(err, "status_code", None) == 409 or "already exists" in str(err).lower():
                logger.warning(
                    f"Collection '{collection_name}' already exists. Skipping creation."
                )
                return
            raise
        except Exception:
            # Bubble up other exceptions so callers can observe failures
            raise

        logger.info(
            f"Collection '{collection_name}' created with {self.config.vector_dimension} dimensions."
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
        collection_name = self._resolve_collection_name(filter_dict=filter)
        if not self.collection_exists(collection_name):
            logger.info(f"Qdrant collection '{collection_name}' does not exist, returning empty search result.")
            return []

        effective_filter = self._strip_scope_filter(filter)
        qdrant_filter = self._dict_to_filter(effective_filter) if effective_filter else None
        response = self.client.query_points(
            collection_name=collection_name,
            query=query_vector,
            limit=top_k,
            query_filter=qdrant_filter,
            with_vectors=True,
            with_payload=True,
        ).points
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
        for collection_name in self._all_candidate_collections():
            try:
                response = self.client.retrieve(
                    collection_name=collection_name,
                    ids=[id],
                    with_payload=True,
                    with_vectors=True,
                )
            except Exception:
                continue

            if response:
                point = response[0]
                return VecDBItem(
                    id=point.id,
                    vector=point.vector,
                    payload=point.payload,
                )

        return None

    def get_by_ids(self, ids: list[str]) -> list[VecDBItem]:
        """Get multiple items by their IDs."""
        remaining_ids = set(ids)
        found_items: dict[str, VecDBItem] = {}

        for collection_name in self._all_candidate_collections():
            if not remaining_ids:
                break

            try:
                response = self.client.retrieve(
                    collection_name=collection_name,
                    ids=list(remaining_ids),
                    with_payload=True,
                    with_vectors=True,
                )
            except Exception:
                continue

            for point in response:
                item = VecDBItem(
                    id=point.id,
                    vector=point.vector,
                    payload=point.payload,
                )
                found_items[item.id] = item
                remaining_ids.discard(item.id)

        return [found_items[id] for id in ids if id in found_items]

    def get_by_filter(self, filter: dict[str, Any], scroll_limit: int = 100) -> list[VecDBItem]:
        """
        Retrieve all items that match the given filter criteria.

        Args:
            filter: Payload filters to match against stored items
            scroll_limit: Maximum number of items to retrieve per scroll request

        Returns:
            List of items including vectors and payload that match the filter
        """
        collection_name = self._resolve_collection_name(filter_dict=filter)
        if not self.collection_exists(collection_name):
            logger.info(
                f"Qdrant collection '{collection_name}' does not exist, returning empty filter result."
            )
            return []

        effective_filter = self._strip_scope_filter(filter)
        qdrant_filter = self._dict_to_filter(effective_filter) if effective_filter else None
        all_points = []
        offset = None

        # Use scroll to paginate through all matching points
        while True:
            points, offset = self.client.scroll(
                collection_name=collection_name,
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
        collection_name = self._resolve_collection_name(filter_dict=filter)
        if not self.collection_exists(collection_name):
            logger.info(f"Qdrant collection '{collection_name}' does not exist, count=0.")
            return 0

        qdrant_filter = None
        if filter:
            effective_filter = self._strip_scope_filter(filter)
            qdrant_filter = self._dict_to_filter(effective_filter) if effective_filter else None

        response = self.client.count(
            collection_name=collection_name,
            count_filter=qdrant_filter,
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
        points_by_collection: dict[str, list[Any]] = defaultdict(list)
        for item in data:
            if isinstance(item, dict):
                item = item.copy()
                item = VecDBItem.from_dict(item)
            point = models.PointStruct(id=item.id, vector=item.vector, payload=item.payload)
            collection_name = self._resolve_collection_name(payload=item.payload)
            points_by_collection[collection_name].append(point)

        for collection_name, points in points_by_collection.items():
            self._ensure_collection_ready(collection_name)
            self.client.upsert(collection_name=collection_name, points=points)

    def update(self, id: str, data: VecDBItem | dict[str, Any]) -> None:
        """Update an item in the vector database."""
        from qdrant_client.http import models

        if isinstance(data, dict):
            data = data.copy()
            data = VecDBItem.from_dict(data)

        collection_name = self._resolve_collection_name(payload=data.payload)
        self._ensure_collection_ready(collection_name)

        if data.vector:
            # For vector updates (with or without payload), use upsert with the same ID
            self.client.upsert(
                collection_name=collection_name,
                points=[models.PointStruct(id=id, vector=data.vector, payload=data.payload)],
            )
        else:
            # For payload-only updates
            self.client.set_payload(
                collection_name=collection_name,
                payload=data.payload,
                points=[id],
            )

    def ensure_payload_indexes(self, fields: list[str], collection_name: str | None = None) -> None:
        """
        Create payload indexes for specified fields in the collection.
        This is idempotent: it will skip if index already exists.

        Args:
            fields (list[str]): List of field names to index (as keyword).
        """
        collection_name = collection_name or self.config.collection_name
        for field in fields:
            try:
                self.client.create_payload_index(
                    collection_name=collection_name,
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
        for collection_name in self._all_candidate_collections():
            self.client.delete(
                collection_name=collection_name,
                points_selector=models.PointIdsList(points=point_ids),
            )
