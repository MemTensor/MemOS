from abc import ABC, abstractmethod
from typing import Any, Dict, List


class BaseRetriever(ABC):
    """Abstract base class for retrievers."""
    
    @abstractmethod
    def __init__(self):
        """Initialize the retriever."""


    @abstractmethod
    def retrieve(self, task_description: str, k: int, threshold: float) -> List[Dict[str, Any]]:
        """Retrieve memories from the retriever."""

class NaiveRetriever(BaseRetriever):
    """Naive retriever."""
    def __init__(self):
        """Initialize the naive retriever."""
        super().__init__()

    def retrieve(self, task_description: str, k: int, threshold: float) -> List[Dict[str, Any]]:
        """Retrieve memories from the naive retriever."""
        pass