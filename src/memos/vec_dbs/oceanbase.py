"""OceanBase / seekdb vector database backend for MemOS.

Implemented on top of pyseekdb's Collection / vector API (chromadb-style). The
same implementation connects to seekdb Server and OceanBase Server; only the
endpoint differs.

The MemOS ``VecDBItem`` is mapped onto a pyseekdb Collection record as:
- ``vector``   -> ``embeddings``
- ``memory``   -> ``documents`` (best-effort, taken from payload)
- ``payload``  -> ``metadatas`` (stored directly; pyseekdb's ``metadata`` is a JSON
  column, so the full nested payload is persisted and read back verbatim).
"""

from typing import Any

from memos.configs.vec_db import OceanBaseVecDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.vec_dbs.base import BaseVecDB
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)

# MemOS distance metric -> pyseekdb distance metric.
_DISTANCE_MAP = {
    "cosine": "cosine",
    "euclidean": "l2",
    "dot": "inner_product",
}


class OceanBaseVecDB(BaseVecDB):
    """OceanBase / seekdb vector database implementation (via pyseekdb)."""

    @require_python_package(
        import_name="pyseekdb",
        install_command="pip install MemoryOS[ob-mem]",
        install_link="https://github.com/oceanbase/pyseekdb",
    )
    def __init__(self, config: OceanBaseVecDBConfig):
        """Initialize the client and ensure the default collection exists."""
        import pyseekdb

        self.config = config
        metric = config.distance_metric or "cosine"
        if metric not in _DISTANCE_MAP:
            raise ValueError(
                f"Unsupported distance_metric '{metric}'. "
                f"Valid options are: {list(_DISTANCE_MAP.keys())}"
            )
        self._distance = _DISTANCE_MAP[metric]

        self.client = pyseekdb.Client(
            host=config.host,
            port=config.port,
            database=config.database,
            user=config.user,
            password=config.password,
        )
        self.collection = None
        self.create_collection()

    # ------------------------------------------------------------------
    # Collection management
    # ------------------------------------------------------------------

    def create_collection(self) -> None:
        """Create the default collection if it does not exist."""
        from pyseekdb import HNSWConfiguration

        name = self.config.collection_name
        if self.client.has_collection(name):
            logger.warning("Collection '%s' already exists. Skipping creation.", name)
            self.collection = self.client.get_collection(name, embedding_function=None)
            return

        configuration = HNSWConfiguration(
            dimension=self.config.vector_dimension,
            distance=self._distance,
        )
        self.collection = self.client.create_collection(
            name=name,
            configuration=configuration,
            embedding_function=None,
        )
        logger.info(
            "Collection '%s' created with %s dimensions (distance=%s).",
            name,
            self.config.vector_dimension,
            self._distance,
        )

    def list_collections(self) -> list[str]:
        """List all collections."""
        return [c.name for c in self.client.list_collections()]

    def delete_collection(self, name: str) -> None:
        """Delete a collection."""
        self.client.delete_collection(name)

    def collection_exists(self, name: str) -> bool:
        """Check if a collection exists."""
        return bool(self.client.has_collection(name))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _document_of(payload: dict[str, Any] | None) -> str:
        """Best-effort document text for full-text features."""
        if payload and isinstance(payload.get("memory"), str):
            return payload["memory"]
        return ""

    def _distance_to_score(self, distance: float | None) -> float | None:
        """Normalize a pyseekdb distance to a 'higher is more similar' score.

        For ``cosine`` the score is the cosine similarity (pyseekdb returns
        ``1 - cosine_similarity``), which is already a meaningful absolute value.

        For ``l2`` and ``inner_product`` the raw distance is unbounded (l2) or
        unbounded/signed (inner_product), which makes absolute-threshold
        comparisons unreliable. We defensively squash them into a bounded
        similarity in ``(0, 1]`` / ``(0, 1)`` while preserving the exact same
        monotonic ordering as the raw distance, so relative ranking is unchanged.
        """
        if distance is None:
            return None
        d = float(distance)
        if self._distance == "cosine":
            return 1.0 - d
        if self._distance == "inner_product":
            # Higher raw distance -> more similar. Squash to (0, 1) monotonically.
            return 0.5 * (1.0 + d / (1.0 + abs(d)))
        # l2 / euclidean: non-negative distance, smaller is closer. Map to (0, 1].
        return 1.0 / (1.0 + d)

    # ------------------------------------------------------------------
    # Search / read
    # ------------------------------------------------------------------

    def search(
        self, query_vector: list[float], top_k: int, filter: dict[str, Any] | None = None
    ) -> list[VecDBItem]:
        """Search for similar items in the collection."""
        response = self.collection.query(
            query_embeddings=query_vector,
            n_results=top_k,
            where=filter or None,
            include=["metadatas", "embeddings", "distances"],
        )
        ids = (response.get("ids") or [[]])[0]
        metadatas = (response.get("metadatas") or [[]])[0]
        embeddings = (response.get("embeddings") or [[]])[0]
        distances = (response.get("distances") or [[]])[0]

        results: list[VecDBItem] = []
        for idx, item_id in enumerate(ids):
            metadata = metadatas[idx] if idx < len(metadatas) else None
            vector = embeddings[idx] if idx < len(embeddings) else None
            distance = distances[idx] if idx < len(distances) else None
            results.append(
                VecDBItem(
                    id=item_id,
                    vector=list(vector) if vector is not None else None,
                    payload=metadata or None,
                    score=self._distance_to_score(distance),
                )
            )
        logger.info("OceanBase vector search completed with %s results.", len(results))
        return results

    def _items_from_get(self, response: dict[str, Any]) -> list[VecDBItem]:
        """Convert a pyseekdb ``get`` response (flat lists) into VecDBItems."""
        ids = response.get("ids") or []
        metadatas = response.get("metadatas") or []
        embeddings = response.get("embeddings") or []
        items: list[VecDBItem] = []
        for idx, item_id in enumerate(ids):
            metadata = metadatas[idx] if idx < len(metadatas) else None
            vector = embeddings[idx] if idx < len(embeddings) else None
            items.append(
                VecDBItem(
                    id=item_id,
                    vector=list(vector) if vector is not None else None,
                    payload=metadata or None,
                )
            )
        return items

    def get_by_id(self, id: str) -> VecDBItem | None:
        """Get a single item by ID."""
        response = self.collection.get(ids=[id], include=["metadatas", "embeddings"])
        items = self._items_from_get(response)
        return items[0] if items else None

    def get_by_ids(self, ids: list[str]) -> list[VecDBItem]:
        """Get multiple items by their IDs."""
        if not ids:
            return []
        response = self.collection.get(ids=ids, include=["metadatas", "embeddings"])
        return self._items_from_get(response)

    def get_by_filter(self, filter: dict[str, Any], scroll_limit: int = 100) -> list[VecDBItem]:
        """
        Retrieve all items matching the given filter, paginating through results.

        Args:
            filter: Payload filters to match against stored items
            scroll_limit: Maximum number of items to retrieve per scroll request
        """
        items: list[VecDBItem] = []
        offset = 0
        while True:
            response = self.collection.get(
                where=filter or None,
                limit=scroll_limit,
                offset=offset,
                include=["metadatas", "embeddings"],
            )
            batch = self._items_from_get(response)
            items.extend(batch)
            if len(batch) < scroll_limit:
                break
            offset += scroll_limit
        return items

    def get_all(self, scroll_limit: int = 100) -> list[VecDBItem]:
        """Retrieve all items in the collection."""
        return self.get_by_filter({}, scroll_limit=scroll_limit)

    def count(self, filter: dict[str, Any] | None = None) -> int:
        """Count items, optionally with a filter."""
        if not filter:
            return int(self.collection.count())
        return len(self.get_by_filter(filter))

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_item(item: VecDBItem | dict[str, Any]) -> VecDBItem:
        if isinstance(item, dict):
            return VecDBItem.from_dict(item.copy())
        return item

    def _columns_from(
        self, data: list[VecDBItem | dict[str, Any]]
    ) -> tuple[list[str], list[list[float] | None], list[str], list[dict[str, Any] | None]]:
        """Split items into the parallel column lists expected by pyseekdb.

        ``payload`` is mapped onto ``metadatas`` and ``payload['memory']`` onto
        ``documents`` (best-effort). ``payload`` may be ``None`` for a given item;
        pyseekdb persists that as a SQL ``NULL`` metadata value.
        """
        ids: list[str] = []
        embeddings: list[list[float] | None] = []
        documents: list[str] = []
        metadatas: list[dict[str, Any] | None] = []
        for raw in data:
            item = self._normalize_item(raw)
            ids.append(item.id)
            embeddings.append(item.vector)
            documents.append(self._document_of(item.payload))
            metadatas.append(item.payload)
        return ids, embeddings, documents, metadatas

    def add(self, data: list[VecDBItem | dict[str, Any]]) -> None:
        """Add data to the collection."""
        ids, embeddings, documents, metadatas = self._columns_from(data)
        if not ids:
            return
        self.collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas,
        )

    def update(self, id: str, data: VecDBItem | dict[str, Any]) -> None:
        """Update an item in the collection."""
        item = self._normalize_item(data)
        metadata = item.payload
        if item.vector is not None:
            self.collection.update(
                ids=id,
                embeddings=item.vector,
                documents=self._document_of(item.payload),
                metadatas=metadata,
            )
        else:
            self.collection.update(ids=id, metadatas=metadata)

    def upsert(self, data: list[VecDBItem | dict[str, Any]]) -> None:
        """Add or update data in the collection."""
        ids, embeddings, documents, metadatas = self._columns_from(data)
        if not ids:
            return
        self.collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas,
        )

    def delete(self, ids: list[str]) -> None:
        """Delete items from the collection by IDs."""
        if not ids:
            return
        self.collection.delete(ids=ids)

    def ensure_payload_indexes(self, fields: list[str]) -> None:
        """No-op: pyseekdb Collections index metadata automatically."""
        logger.debug("ensure_payload_indexes is a no-op for OceanBase Collection API: %s", fields)
