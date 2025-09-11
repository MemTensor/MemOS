from abc import ABC, abstractmethod
from memos.memories.textual.item import TextualMemoryItem


class BaseUpdater(ABC):
    """Abstract base class for updaters."""
    
    @abstractmethod
    def __init__(self):
        """Initialize the updater."""


class NaiveUpdater(BaseUpdater):
    """Naive updater."""
    def __init__(self):
        """Initialize the naive updater."""
        super().__init__()

    def update(self, memories: list[TextualMemoryItem]) -> None:
        """Update the memory."""
        pass


