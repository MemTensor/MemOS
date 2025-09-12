from abc import ABC, abstractmethod
from memos.memories.textual.item import TextualMemoryItem


class BaseAssembler(ABC):
    """Abstract base class for assemblers."""
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the assembler."""

    @abstractmethod
    def assemble(self, query: str, memories: list[TextualMemoryItem]) -> str:
        """Assemble query and memories into a single memory."""


class NaiveAssembler(BaseAssembler):
    """Naive assembler."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive assembler."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def assemble(self, query: str, memories: list[TextualMemoryItem]) -> str:
        """Assemble query and memories into a single memory."""
        return f"Query: {query}\nMemories: {memories}"

