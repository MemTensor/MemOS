from abc import ABC, abstractmethod
from typing import Any

from memos.configs.mem_reader import BaseMemReaderConfig
from memos.memories.textual.item import TextualMemoryItem


class BaseMemReader(ABC):
    """MemReader interface class for reading information."""

    @abstractmethod
    def __init__(self, config: BaseMemReaderConfig):
        """Initialize the MemReader with the given configuration."""

    @abstractmethod
    def get_memory(
        self, scene_data: list, type: str, info: dict[str, Any], mode: str = "fast"
    ) -> list[list[TextualMemoryItem]]:
        """Various types of memories extracted from scene_data"""

    @abstractmethod
    def fine_transfer_simple_mem(
        self, input_memories: list[list[TextualMemoryItem]], type: str
    ) -> list[list[TextualMemoryItem]]:
        """Fine Transform TextualMemoryItem List into another list of
        TextualMemoryItem objects via calling llm to better understand users."""
