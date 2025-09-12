from abc import ABC, abstractmethod
from typing import Any
from memos.memories.textual.item import TextualMemoryItem


class BaseUpdater(ABC):
    """Abstract base class for updaters."""
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the updater."""

    @abstractmethod
    def update(self, new_memory: TextualMemoryItem | dict[str, Any], *args, **kwargs) -> None:
        """Update the memory.
        Args:
            new_memory (TextualMemoryItem | dict[str, Any]): The new memory to update.
            *args: Additional positional arguments.
            **kwargs: Additional keyword arguments.
        """


class NaiveUpdater(BaseUpdater):
    """Naive updater."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive updater."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def update(self, new_memory: TextualMemoryItem | dict[str, Any], *args, **kwargs) -> None:
        """Update the memory.
        Args:
            new_memory (TextualMemoryItem | dict[str, Any]): The new memory to update.
            *args: Additional positional arguments.
            **kwargs: Additional keyword arguments.
        """
        pass


