from abc import abstractmethod
from typing import Any

from memos.configs.memory import BaseTextMemoryConfig
from memos.memories.base import BaseMemory
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageList


class BaseTextMemory(BaseMemory):
    """Base class for all textual memory implementations."""

    # Default mode configuration - can be overridden by subclasses
    mode: str = "sync"  # Default mode: 'async' or 'sync'

    @abstractmethod
    def __init__(self, config: BaseTextMemoryConfig):
        """Initialize memory with the given configuration."""

    @abstractmethod
    def extract(self, messages: MessageList) -> list[TextualMemoryItem]:
        """Extract memories based on the messages.
        Args:
            messages (MessageList): The messages to extract memories from.
        Returns:
            list[TextualMemoryItem]: List of extracted memory items.
        """

    @abstractmethod
    def add(self, memories: list[TextualMemoryItem | dict[str, Any]], **kwargs) -> list[str]:
        """Add memories.

        Args:
            memories: List of TextualMemoryItem objects or dictionaries to add.
        """

    @abstractmethod
    def update(self, memory_id: str, new_memory: TextualMemoryItem | dict[str, Any]) -> None:
        """Update a memory by memory_id."""

    @abstractmethod
    def search(self, query: str, top_k: int, info=None, **kwargs) -> list[TextualMemoryItem]:
        """Search for memories based on a query.
        Args:
            query (str): The query to search for.
            top_k (int): The number of top results to return.
            info (dict): Leave a record of memory consumption.
        Returns:
            list[TextualMemoryItem]: List of matching memories.
        """

    @abstractmethod
    def get(self, memory_id: str, user_name: str | None = None) -> TextualMemoryItem:
        """Get a memory by its ID.
        Args:
            memory_id (str): The ID of the memory to retrieve.
        Returns:
            TextualMemoryItem: The memory with the given ID.
        """

    @abstractmethod
    def get_by_ids(self, memory_ids: list[str]) -> list[TextualMemoryItem]:
        """Get memories by their IDs.
        Args:
            memory_ids (list[str]): List of memory IDs to retrieve.
        Returns:
            list[TextualMemoryItem]: List of memories with the specified IDs.
        """

    @abstractmethod
    def get_all(self) -> list[TextualMemoryItem]:
        """Get all memories.
        Returns:
            list[TextualMemoryItem]: List of all memories.
        """

    @abstractmethod
    def delete(self, memory_ids: list[str]) -> None:
        """Delete memories.
        Args:
            memory_ids (list[str]): List of memory IDs to delete.
        """

    @abstractmethod
    def delete_all(self) -> None:
        """Delete all memories."""

    @abstractmethod
    def drop(
        self,
    ) -> None:
        """Drop all databases."""
