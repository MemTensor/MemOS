from abc import ABC, abstractmethod
from memos.memories.textual.item import TextualMemoryItem


class BaseAssembler(ABC):
    """Abstract base class for assemblers."""
    @abstractmethod
    def __init__(self):
        """Initialize the assembler."""

    @abstractmethod
    def assemble(self, memories: list[TextualMemoryItem]) -> str:
        """Assemble memories into a single memory."""


class NaiveAssembler(BaseAssembler):
    """Naive assembler."""
    def __init__(self):
        """Initialize the naive assembler."""
        super().__init__()

    def assemble(self, memories: list[TextualMemoryItem]) -> str:
        """Assemble memories into a single memory."""
        pass

