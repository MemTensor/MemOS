from typing import Any

from memos.embedders.factory import (
    ArkEmbedder,
    OllamaEmbedder,
    SenTranEmbedder,
    UniversalAPIEmbedder,
)
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import PreferenceTextualMemoryMetadata, TextualMemoryItem
from memos.memories.textual.preference import PreferenceTextMemory
from memos.types import MessageList
from memos.vec_dbs.factory import MilvusVecDB, QdrantVecDB


logger = get_logger(__name__)


class SimplePreferenceTextMemory(PreferenceTextMemory):
    """Preference textual memory implementation for storing and retrieving memories."""

    def __init__(
        self,
        extractor_llm: OpenAILLM | OllamaLLM | AzureLLM,
        vector_db: MilvusVecDB | QdrantVecDB,
        embedder: OllamaEmbedder | ArkEmbedder | SenTranEmbedder | UniversalAPIEmbedder,
        reranker,
        extractor,
        adder,
        retriever,
    ):
        """Initialize memory with the given configuration."""
        self.extractor_llm = extractor_llm
        self.vector_db = vector_db
        self.embedder = embedder
        self.reranker = reranker
        self.extractor = extractor
        self.adder = adder
        self.retriever = retriever

    def get_memory(
        self, messages: list[MessageList], type: str, info: dict[str, Any]
    ) -> list[TextualMemoryItem]:
        """Get memory based on the messages.
        Args:
            messages (MessageList): The messages to get memory from.
            type (str): The type of memory to get.
            info (dict[str, Any]): The info to get memory.
        """
        return self.extractor.extract(messages, type, info)

    def search(
        self, query: str, top_k: int, info=None, search_filter=None, **kwargs
    ) -> list[TextualMemoryItem]:
        """Search for memories based on a query.
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        return self.retriever.retrieve(query, top_k, info, search_filter)

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> list[str]:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        """
        return self.adder.add(memories)

    def get_with_collection_name(
        self, collection_name: str, memory_id: str
    ) -> TextualMemoryItem | None:
        """Get a memory by its ID and collection name.
        Args:
            memory_id (str): The ID of the memory to retrieve.
            collection_name (str): The name of the collection to retrieve the memory from.
        Returns:
            TextualMemoryItem: The memory with the given ID and collection name.
        """
        try:
            res = self.vector_db.get_by_id(collection_name, memory_id)
            if res is None:
                return None
            return TextualMemoryItem(
                id=res.id,
                memory=res.payload.get("dialog_str", ""),
                metadata=PreferenceTextualMemoryMetadata(**res.payload),
            )
        except Exception as e:
            # Convert any other exception to ValueError for consistent error handling
            raise ValueError(
                f"Memory with ID {memory_id} not found in collection {collection_name}: {e}"
            ) from e

    def get_by_ids_with_collection_name(
        self, collection_name: str, memory_ids: list[str]
    ) -> list[TextualMemoryItem]:
        """Get memories by their IDs and collection name.
        Args:
            collection_name (str): The name of the collection to retrieve the memory from.
            memory_ids (list[str]): List of memory IDs to retrieve.
        Returns:
            list[TextualMemoryItem]: List of memories with the specified IDs and collection name.
        """
        try:
            res = self.vector_db.get_by_ids(collection_name, memory_ids)
            if not res:
                return []
            return [
                TextualMemoryItem(
                    id=memo.id,
                    memory=memo.payload.get("dialog_str", ""),
                    metadata=PreferenceTextualMemoryMetadata(**memo.payload),
                )
                for memo in res
            ]
        except Exception as e:
            # Convert any other exception to ValueError for consistent error handling
            raise ValueError(
                f"Memory with IDs {memory_ids} not found in collection {collection_name}: {e}"
            ) from e

    def get_all(self) -> list[TextualMemoryItem]:
        """Get all memories.
        Returns:
            list[TextualMemoryItem]: List of all memories.
        """
        all_collections = self.vector_db.list_collections()
        all_memories = {}
        for collection_name in all_collections:
            items = self.vector_db.get_all(collection_name)
            all_memories[collection_name] = [
                TextualMemoryItem(
                    id=memo.id,
                    memory=memo.payload.get("dialog_str", ""),
                    metadata=PreferenceTextualMemoryMetadata(**memo.payload),
                )
                for memo in items
            ]
        return all_memories

    def delete_with_collection_name(self, collection_name: str, memory_ids: list[str]) -> None:
        """Delete memories by their IDs and collection name.
        Args:
            collection_name (str): The name of the collection to delete the memory from.
            memory_ids (list[str]): List of memory IDs to delete.
        """
        self.vector_db.delete(collection_name, memory_ids)

    def delete_all(self) -> None:
        """Delete all memories."""
        for collection_name in self.vector_db.config.collection_name:
            self.vector_db.delete_collection(collection_name)
        self.vector_db.create_collection()
