from abc import ABC, abstractmethod
from typing import Any
from memos.memories.textual.item import TextualMemoryItem
from memos.vec_dbs.base import BaseVecDB
from memos.embedders.base import BaseEmbedder


class BaseRetriever(ABC):
    """Abstract base class for retrievers."""
    
    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the retriever."""


    @abstractmethod
    def retrieve(self, query: str, top_k: int, info: dict[str, Any]) -> list[TextualMemoryItem]:
        """Retrieve memories from the retriever."""

class NaiveRetriever(BaseRetriever):
    """Naive retriever."""
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive retriever."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.vector_db = vector_db
        self.embedder = embedder

    def retrieve(self, query: str, top_k: int, info: dict[str, Any]) -> list[TextualMemoryItem]:
        """Retrieve memories from the naive retriever."""
        query_embedding = self.embedder.embed(query)
        return self.vector_db.search(query_embedding, top_k, info)