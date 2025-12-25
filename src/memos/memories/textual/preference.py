import json
import os

from typing import Any

from memos.configs.memory import PreferenceTextMemoryConfig
from memos.embedders.factory import (
    ArkEmbedder,
    EmbedderFactory,
    OllamaEmbedder,
    SenTranEmbedder,
    UniversalAPIEmbedder,
)
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import PreferenceTextualMemoryMetadata, TextualMemoryItem
from memos.memories.textual.prefer_text_memory.factory import (
    AdderFactory,
    ExtractorFactory,
    RetrieverFactory,
)
from memos.reranker.factory import RerankerFactory
from memos.types import MessageList
from memos.vec_dbs.factory import MilvusVecDB, QdrantVecDB, VecDBFactory
from memos.vec_dbs.item import VecDBItem


logger = get_logger(__name__)


class PreferenceTextMemory(BaseTextMemory):
    """Preference textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: PreferenceTextMemoryConfig):
        """Initialize memory with the given configuration."""
        self.config: PreferenceTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        self.vector_db: MilvusVecDB | QdrantVecDB = VecDBFactory.from_config(config.vector_db)
        self.embedder: OllamaEmbedder | ArkEmbedder | SenTranEmbedder | UniversalAPIEmbedder = (
            EmbedderFactory.from_config(config.embedder)
        )
        self.reranker = RerankerFactory.from_config(config.reranker)

        self.extractor = ExtractorFactory.from_config(
            config.extractor,
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            vector_db=self.vector_db,
        )

        self.adder = AdderFactory.from_config(
            config.adder,
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            vector_db=self.vector_db,
        )
        self.retriever = RetrieverFactory.from_config(
            config.retriever,
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            reranker=self.reranker,
            vector_db=self.vector_db,
        )

    def get_memory(
        self, messages: list[MessageList], type: str, info: dict[str, Any]
    ) -> list[TextualMemoryItem]:
        """Get memory based on the messages.
        Args:
            messages (list[MessageList]): The messages to get memory from.
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
        logger.info(f"search_filter for preference memory: {search_filter}")
        return self.retriever.retrieve(query, top_k, info, search_filter)

    def load(self, dir: str) -> None:
        """Load memories from the specified directory.
        Args:
            dir (str): The directory containing the memory files.
        """
        # For preference memory, we don't need to load from files
        # as the data is stored in the vector database
        try:
            memory_file = os.path.join(dir, self.config.memory_filename)

            if not os.path.exists(memory_file):
                logger.warning(f"Memory file not found: {memory_file}")
                return

            with open(memory_file, encoding="utf-8") as f:
                memories = json.load(f)
            for collection_name, items in memories.items():
                vec_db_items = [VecDBItem.from_dict(m) for m in items]
                self.vector_db.add(collection_name, vec_db_items)
                logger.info(f"Loaded {len(items)} memories from {collection_name} in {memory_file}")

        except FileNotFoundError:
            logger.error(f"Memory file not found in directory: {dir}")
        except json.JSONDecodeError as e:
            if e.pos == 0 and "Expecting value" in str(e):
                logger.warning(f"Memory file is empty or contains only whitespace: {memory_file}")
            else:
                logger.error(f"Error decoding JSON from memory file: {e}")
        except Exception as e:
            logger.error(f"An error occurred while loading memories: {e}")

    def dump(self, dir: str) -> None:
        """Dump memories to the specified directory.
        Args:
            dir (str): The directory where the memory files will be saved.
        """
        # For preference memory, we don't need to dump to files
        # as the data is stored in the vector database
        try:
            json_memories = {}
            for collection_name in self.vector_db.config.collection_name:
                items = self.vector_db.get_all(collection_name)
                json_memories[collection_name] = [memory.to_dict() for memory in items]

            os.makedirs(dir, exist_ok=True)
            memory_file = os.path.join(dir, self.config.memory_filename)
            with open(memory_file, "w", encoding="utf-8") as f:
                json.dump(json_memories, f, indent=4, ensure_ascii=False)

            logger.info(
                f"Dumped {len(json_memories)} collections, {sum(len(items) for items in json_memories.values())} memories to {memory_file}"
            )

        except Exception as e:
            logger.error(f"An error occurred while dumping memories: {e}")
            raise

    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages.
        Args:
            messages (MessageList): The messages to extract memories from.
        Returns:
            list[TextualMemoryItem]: List of extracted memory items.
        """
        raise NotImplementedError

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> list[str]:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        """
        return self.adder.add(memories)

    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        """Update a memory by memory_id."""
        raise NotImplementedError

    def get(self, memory_id: str, user_name: str | None = None) -> TextualMemoryItem:
        """Get a memory by its ID.
        Args:
            memory_id (str): The ID of the memory to retrieve.
        Returns:
            TextualMemoryItem: The memory with the given ID.
        """
        raise NotImplementedError

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
                memory=res.memory,
                metadata=PreferenceTextualMemoryMetadata(**res.payload),
            )
        except Exception as e:
            # Convert any other exception to ValueError for consistent error handling
            raise ValueError(
                f"Memory with ID {memory_id} not found in collection {collection_name}: {e}"
            ) from e

    def get_by_ids(self, memory_ids: list[str]) -> list[TextualMemoryItem]:
        """Get memories by their IDs.
        Args:
            memory_ids (list[str]): List of memory IDs to retrieve.
        Returns:
            list[TextualMemoryItem]: List of memories with the specified IDs.
        """
        raise NotImplementedError

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
                    memory=memo.memory,
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
                    memory=memo.memory,
                    metadata=PreferenceTextualMemoryMetadata(**memo.payload),
                )
                for memo in items
            ]
        return all_memories

    def get_memory_by_filter(self, filter: dict[str, Any] | None = None) -> list[TextualMemoryItem]:
        """Get memories by filter.
        Args:
            filter (dict[str, Any]): Filter criteria.
        Returns:
            list[TextualMemoryItem]: List of memories that match the filter.
        """
        collection_list = self.vector_db.config.collection_name
        all_db_items = []
        for collection_name in collection_list:
            db_items = self.vector_db.get_by_filter(collection_name=collection_name, filter=filter)
            all_db_items.extend(db_items)
        memories = [
            TextualMemoryItem(
                id=memo.id,
                memory=memo.memory,
                metadata=PreferenceTextualMemoryMetadata(**memo.payload),
            )
            for memo in all_db_items
        ]
        return memories

    def delete(self, memory_ids: list[str]) -> None:
        """Delete memories.
        Args:
            memory_ids (list[str]): List of memory IDs to delete.
        """
        collection_list = self.vector_db.config.collection_name
        for collection_name in collection_list:
            self.vector_db.delete(collection_name, memory_ids)

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

    def drop(
        self,
    ) -> None:
        """Drop all databases."""
        raise NotImplementedError
