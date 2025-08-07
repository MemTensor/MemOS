import base64
import json

from typing import Any

from memos.configs.vec_db import ChromaVecDBConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.vec_dbs.base import BaseVecDB
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)


class ChromaVecDB(BaseVecDB):
    """Chroma vector database implementation."""

    @require_python_package(import_name="chromadb", install_command="pip install chromadb-client")
    def __init__(self, config: ChromaVecDBConfig):
        """Initialize the Chroma vector database and the collection."""
        from chromadb import HttpClient, PersistentClient
        from chromadb.config import DEFAULT_DATABASE, DEFAULT_TENANT

        self.config = config

        # If both host and port are None, we are running in local mode
        if self.config.host is None and self.config.port is None:
            logger.warning("Chroma is running in local mode (host and port are both None). ")
            self.client = PersistentClient(
                path=self.config.path,
                database=self.config.database or DEFAULT_DATABASE,
                tenant=self.config.tenant or DEFAULT_TENANT,
            )
        else:
            auth_credentials = f"{self.config.username}:{self.config.password}"

            encoded_credentials = base64.b64encode(auth_credentials.encode("utf-8")).decode("utf-8")
            self.client = HttpClient(
                host=self.config.host,
                port=self.config.port,
                headers={"Authorization": f"Basic {encoded_credentials}"},
                database=self.config.database or DEFAULT_DATABASE,
                tenant=self.config.tenant or DEFAULT_TENANT,
                ssl=self.config.ssl,
            )

        self.create_collection()

    @staticmethod
    def serialize_metadata(d: dict) -> dict:
        """Return a copy of the dict with list/dict values converted to JSON strings."""
        result = {}
        for key, value in d.items():
            if isinstance(value, dict | list):
                result[key] = json.dumps(value)
            else:
                result[key] = value
        return result

    @staticmethod
    def deserialize_metadata(d: dict) -> dict:
        """Return a copy of the dict with JSON string values parsed back to dict or list."""
        result = {}
        for key, value in d.items():
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, dict | list):
                        result[key] = parsed
                    else:
                        result[key] = value
                except (json.JSONDecodeError, TypeError):
                    result[key] = value
            else:
                result[key] = value
        return result

    def get_collection(self):
        """Get a collection by name."""
        try:
            return self.client.get_collection(self.config.collection_name)
        except Exception:
            self.create_collection()
            return self.client.get_collection(self.config.collection_name)

    def create_collection(self) -> None:
        if self.collection_exists(self.config.collection_name):
            logger.warning(
                f"Collection '{self.config.collection_name}' already exists. Skipping creation."
            )
            return

        self.client.create_collection(name=self.config.collection_name)

        logger.info(f"Collection '{self.config.collection_name}' created")

    def list_collections(self) -> list[str]:
        """List all collections."""
        collections = self.client.list_collections()
        return [collection.name for collection in collections]

    def delete_collection(self, name: str) -> None:
        """Delete a collection."""
        self.client.delete_collection(name=name)

    def collection_exists(self, name: str) -> bool:
        """Check if a collection exists."""
        try:
            self.client.get_collection(name=name)
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

        response = self.get_collection().query(
            query_embeddings=query_vector,
            n_results=top_k,
            where_document=filter,
        )
        logger.info(f"ChromaDb search completed with {len(response)} results.")
        return [
            VecDBItem(
                id=response["ids"][0][idx],
                vector=response["embeddings"][0][idx] if response["embeddings"] else None,
                payload=self.deserialize_metadata(response["metadatas"][0][idx])
                if response["metadatas"]
                else None,
                score=response["distances"][0][idx] if response["distances"][0] else None,
            )
            for idx, _ in enumerate(response["ids"][0])
        ]

    def get_by_id(self, id: str) -> VecDBItem | None:
        """Get a single item by ID."""
        response = self.get_collection().get(ids=[id])

        if not response["ids"]:
            return None

        return VecDBItem(
            id=response["ids"][0],
            vector=response["embeddings"][0],
            payload=self.deserialize_metadata(response["metadatas"][0]),
        )

    def get_by_ids(self, ids: list[str]) -> list[VecDBItem]:
        """Get multiple items by their IDs."""

        response = self.get_collection().get(ids=ids)

        if not response["ids"]:
            return []

        return [
            VecDBItem(
                id=response["ids"][idx],
                vector=self.deserialize_metadata(response["embeddings"][idx])
                if response["embeddings"]
                else None,
                payload=response["metadatas"][idx] if response["metadatas"] else None,
            )
            for idx, _ in enumerate(response["ids"])
        ]

    def get_by_filter(self, filter: dict[str, Any], limit: int = 100) -> list[VecDBItem]:
        """
        Retrieve all items that match the given filter criteria.

        Args:
            filter: Payload filters to match against stored items
            limit: Maximum number of items to retrieve per scroll request

        Returns:
            List of items including vectors and payload that match the filter"""

        response = self.get_collection().get(where=filter, limit=limit)

        logger.info(f"Chroma retrieve by filter completed with {len(response['ids'])} results.")

        if not response["ids"]:
            return []

        return [
            VecDBItem(
                id=response["ids"][idx],
                vector=self.deserialize_metadata(response["embeddings"][idx])
                if response["embeddings"]
                else None,
                payload=response["metadatas"][idx] if response["metadatas"] else None,
            )
            for idx, _ in enumerate(response["ids"])
        ]

    def get_all(self, limit=100) -> list[VecDBItem]:
        """Retrieve all items in the vector database."""
        return self.get_by_filter({}, limit=limit)

    def count(self, filter: dict[str, Any] | None = None) -> int:
        """Count items in the database, optionally with filter."""

        response = self.get_by_filter(filter)
        return len(response)

    def add(self, data: list[VecDBItem | dict[str, Any]]) -> None:
        """
        Add data to the vector database.

        Args:
            data: List of VecDBItem objects or dictionaries containing:
                - 'id': unique identifier
                - 'vector': embedding vector
                - 'payload': additional fields for filtering/retrieval
        """
        ids = []
        embeddings = []
        metadatas = []
        documents = []
        for item in data:
            if isinstance(item, dict):
                item = VecDBItem.from_dict(item)
            ids.append(str(item.id))
            embeddings.append(item.vector)
            metadatas.append(self.serialize_metadata(item.payload))
            documents.append(item.payload.get("memory"))

        self.get_collection().upsert(
            ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents
        )

    def update(self, id: str, data: VecDBItem | dict[str, Any]) -> None:
        """Update an item in the vector database."""

        if isinstance(data, dict):
            data = VecDBItem.from_dict(data)

        if data.vector:
            # For vector updates (with or without payload), use upsert with the same ID
            self.get_collection().upsert(
                ids=[id],
                embeddings=[data.vector],
                metadatas=[self.serialize_metadata(data.payload.get("metadata"))],
                documents=[data.payload.get("memory")],
            )
        else:
            # For payload-only updates
            self.get_collection().upsert(
                ids=[id], metadatas=[self.serialize_metadata(data.payload.get("metadata"))]
            )

    def upsert(self, data: list[VecDBItem | dict[str, Any]]) -> None:
        """
        Add or update data in the vector database.

        If an item with the same ID exists, it will be updated.
        Otherwise, it will be added as a new item.
        """
        self.add(data)

    def delete(self, ids: list[str]) -> None:
        """Delete items from the vector database."""
        self.get_collection().delete(ids=ids)

    def ensure_payload_indexes(self, fields: list[str]) -> None:
        """
        Create payload indexes for specified fields in the collection.
        This is idempotent: it will skip if index already exists.

        Args:
            fields (list[str]): List of field names to index (as keyword).
        """
        # chromadb does not implement crete index
