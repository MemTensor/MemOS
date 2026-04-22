from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from memos.configs.mem_reader import BaseMemReaderConfig
from memos.memories.textual.item import TextualMemoryItem


if TYPE_CHECKING:
    from memos.graph_dbs.base import BaseGraphDB
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher


class BaseMemReader(ABC):
    """MemReader interface class for reading information."""

    # Optional graph database for recall operations (for deduplication, conflict
    # detection .etc)
    graph_db: "BaseGraphDB | None" = None

    @abstractmethod
    def __init__(self, config: BaseMemReaderConfig):
        """Initialize the MemReader with the given configuration."""

    @abstractmethod
    def set_graph_db(self, graph_db: "BaseGraphDB | None") -> None:
        """
        Set the graph database instance for recall operations.

        This enables the mem-reader to perform:
        - Semantic deduplication: avoid storing duplicate memories
        - Conflict detection: detect contradictions with existing memories

        Args:
            graph_db: The graph database instance, or None to disable recall operations.
        """

    @abstractmethod
    def set_searcher(self, searcher: "Searcher | None") -> None:
        """
        Set the searcher instance for recall operations.
        """

    @abstractmethod
    def get_memory(
        self, scene_data: list, type: str, info: dict[str, Any], mode: str = "fast", **kwargs
    ) -> list[list[TextualMemoryItem]]:
        """Various types of memories extracted from scene_data"""

    @abstractmethod
    def fine_transfer_simple_mem(
        self, input_memories: list[list[TextualMemoryItem]], type: str
    ) -> list[list[TextualMemoryItem]]:
        """Fine Transform TextualMemoryItem List into another list of
        TextualMemoryItem objects via calling llm to better understand users."""
