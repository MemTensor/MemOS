import json
import os
import shutil
import tempfile

from datetime import datetime
from pathlib import Path
from typing import Any

from memos.configs.memory import GeneralTextMemoryConfig
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder, ArkEmbedder, SenTranEmbedder, UniversalAPIEmbedder
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageList
from memos.llms.base import BaseLLM
from memos.vec_dbs.factory import QdrantVecDB, VecDBFactory


class PreferenceTextMemory(BaseTextMemory):
    """Preference textual memory implementation for storing and retrieving memories."""

    def __init__(self, config: GeneralTextMemoryConfig):
        """Initialize memory with the given configuration."""
        self.config: GeneralTextMemoryConfig = config
        self.extractor_llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(
            config.extractor_llm
        )
        self.vector_db: QdrantVecDB = VecDBFactory.from_config(config.vector_db)
        self.embedder: OllamaEmbedder | ArkEmbedder | SenTranEmbedder | UniversalAPIEmbedder = \
            EmbedderFactory.from_config(config.embedder)


    def build_memory():
        """Build memory from the original dialogs. (Initialize memory)"""
        pass

    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages.
        Args:
            messages (MessageList): The messages to extract memories from.
        Returns:
            list[TextualMemoryItem]: List of extracted memory items.
        """
        pass
    
    def get_prompt(self, memories: list[TextualMemoryItem]) -> str:
        """Get the prompt for the memory.
        Args:
            memories (list[TextualMemoryItem]): The memories to get the prompt for.
        Returns:
            str: The prompt for the memory.
        """
        pass

    def add(self, memories: list[TextualMemoryItem | dict[str, Any]]) -> list[str]:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        """
        pass
    
    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        """Update a memory by memory_id."""
        pass
    
    def search(self, query: str, top_k: int, info=None, **kwargs) -> list[TextualMemoryItem]:
        """Search for memories based on a query.
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """
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