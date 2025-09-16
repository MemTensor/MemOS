import json
import os
import shutil
import tempfile

from datetime import datetime
from pathlib import Path
from typing import Any

from memos.configs.memory import PreferenceTextMemoryConfig
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder, ArkEmbedder, SenTranEmbedder, UniversalAPIEmbedder
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem
from memos.types import ChatHistory, MessageList
from memos.llms.base import BaseLLM
from memos.vec_dbs.factory import QdrantVecDB, VecDBFactory, MilvusVecDB
from memos.vec_dbs.item import VecDBItem
from memos.memories.textual.prefer_text_memory.factory import BuilderFactory, RetrieverFactory, UpdaterFactory, AssemblerFactory


class PreferenceTextMemory(BaseTextMemory):
    """Preference textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: PreferenceTextMemoryConfig):
        """Initialize memory with the given configuration."""
        self.config: PreferenceTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        self.vector_db: MilvusVecDB | QdrantVecDB = VecDBFactory.from_config(config.vector_db)
        self.embedder: OllamaEmbedder | ArkEmbedder | SenTranEmbedder | UniversalAPIEmbedder = \
            EmbedderFactory.from_config(config.embedder)

        self.builder = BuilderFactory.from_config(
            config.builder, 
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            vector_db=self.vector_db
        )
        self.retriever = RetrieverFactory.from_config(
            config.retriever,
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            vector_db=self.vector_db
        )
        self.updater = UpdaterFactory.from_config(
            config.updater,
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            vector_db=self.vector_db
        )
        self.assembler = AssemblerFactory.from_config(
            config.assembler,
            llm_provider=self.extractor_llm,
            embedder=self.embedder,
            vector_db=self.vector_db
        )

    def build_preferences(self, history: ChatHistory) -> None:
        """Build memory from the original dialogs. (Initialize memory)
        
        Args:
            history: The chat history to build memory from.
            
        Returns:
            Memory content string formatted according to the build strategy
        """
        return self.builder.build(history)

    def update_preferences(self, new_dialog: MessageList) -> None:
        """Update a memory by new dialog.
        Args:
            new_dialog (MessageList): The new dialog to update.
        """
        self.updater.update(new_dialog)

    def search_preferences(self, query: str, top_k: int, info=None) -> list[TextualMemoryItem]:
        """Search for preferences based on a query.
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
        """
        return self.retriever.retrieve(query, top_k, info)
    
    def search(self, query: str, top_k: int, info=None, **kwargs) -> list[TextualMemoryItem]:
        """Search for memories based on a query.
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
        return self.retriever.retrieve(query, top_k, info)

            
    def get_prompt(self, query: str, memories: list[TextualMemoryItem]) -> str:
        """Construct the prompt for the query with memories.
        Args:
            query (str): The query to get the prompt for.
            memories (list[TextualMemoryItem]): The memories to get the prompt for.
        Returns:
            str: The prompt for the query with memories.
        """
        return self.assembler.assemble(query, memories)

    def load(self, dir: str) -> None:
        """Load memories from the specified directory.
        Args:
            dir (str): The directory containing the memory files.
        """
        # For preference memory, we don't need to load from files
        # as the data is stored in the vector database
        pass

    def dump(self, dir: str) -> None:
        """Dump memories to the specified directory.
        Args:
            dir (str): The directory where the memory files will be saved.
        """
        # For preference memory, we don't need to dump to files
        # as the data is stored in the vector database
        pass

    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages.
        Args:
            messages (MessageList): The messages to extract memories from.
        Returns:
            list[TextualMemoryItem]: List of extracted memory items.
        """
        pass

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> list[str]:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        """
        if self.config.backend == "naive":
            pass
        else:
            memory_items = [TextualMemoryItem(**m) if isinstance(m, dict) else m for m in memories]

            # Memory encode
            embed_memories = self.embedder.embed([m.memory for m in memory_items])

            # Create vector db items
            vec_db_items = []
            for item, emb in zip(memory_items, embed_memories, strict=True):
                vec_db_items.append(
                    VecDBItem(
                        id=item.id,
                        payload=item.model_dump(),
                        vector=emb,
                    )
                )

            # Add to vector db
            self.vector_db.add(vec_db_items)
    
    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        """Update a memory by memory_id."""
        pass
    
    def get(self, memory_id: str) -> TextualMemoryItem:
        """Get a memory by its ID.
        Args:
            memory_id (str): The ID of the memory to retrieve.
        Returns:
            TextualMemoryItem: The memory with the given ID.
        """
        pass
    
    def get_by_ids(self, memory_ids: list[str]) -> list[TextualMemoryItem]:
        """Get memories by their IDs.
        Args:
            memory_ids (list[str]): List of memory IDs to retrieve.
        Returns:
            list[TextualMemoryItem]: List of memories with the specified IDs.
        """
        pass
    
    def get_all(self) -> list[TextualMemoryItem]:
        """Get all memories.
        Returns:
            list[TextualMemoryItem]: List of all memories.
        """
        pass
    
    def delete(self, memory_ids: list[str]) -> None:
        """Delete memories.
        Args:
            memory_ids (list[str]): List of memory IDs to delete.
        """
        pass
    
    def delete_all(self) -> None:
        """Delete all memories."""
        pass
    
    def drop(
        self,
    ) -> None:
        """Drop all databases."""
        pass