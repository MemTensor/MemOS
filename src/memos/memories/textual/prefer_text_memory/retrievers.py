from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from memos.memories.textual.item import PreferenceTextualMemoryMetadata, TextualMemoryItem


class BaseRetriever(ABC):
    """Abstract base class for retrievers."""

    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, reranker=None, vector_db=None):
        """Initialize the retriever."""

    @abstractmethod
    def retrieve(
        self, query: str, top_k: int, info: dict[str, Any] | None = None
    ) -> list[TextualMemoryItem]:
        """Retrieve memories from the retriever."""


class NaiveRetriever(BaseRetriever):
    """Naive retriever."""

    def __init__(self, llm_provider=None, embedder=None, reranker=None, vector_db=None):
        """Initialize the naive retriever."""
        super().__init__(llm_provider, embedder, reranker, vector_db)
        self.reranker = reranker
        self.vector_db = vector_db
        self.embedder = embedder

    def retrieve(
        self, query: str, top_k: int, info: dict[str, Any] | None = None
    ) -> list[TextualMemoryItem]:
        """Retrieve memories from the naive retriever."""
        # TODO: un-support rewrite query and session filter now
        if info:
            info = info.copy()  # Create a copy to avoid modifying the original
            info.pop("chat_history", None)
            info.pop("session_id", None)
        query_embeddings = self.embedder.embed([query])  # Pass as list to get list of embeddings
        query_embedding = query_embeddings[0]  # Get the first (and only) embedding

        # Use thread pool to parallelize the searches
        with ThreadPoolExecutor(max_workers=2) as executor:
            # Submit all search tasks
            future_explicit = executor.submit(
                self.vector_db.search, query_embedding, "explicit_preference", top_k * 2, info
            )
            future_implicit = executor.submit(
                self.vector_db.search, query_embedding, "implicit_preference", top_k * 2, info
            )

            # Wait for all results
            explicit_prefs = future_explicit.result()
            implicit_prefs = future_implicit.result()

        # sort by score
        explicit_prefs.sort(key=lambda x: x.score, reverse=True)
        implicit_prefs.sort(key=lambda x: x.score, reverse=True)

        explicit_prefs = [
            TextualMemoryItem(
                id=pref.id,
                memory=pref.memory,
                metadata=PreferenceTextualMemoryMetadata(**pref.payload),
            )
            for pref in explicit_prefs
            if pref.payload["explicit_preference"]
        ]

        implicit_prefs = [
            TextualMemoryItem(
                id=pref.id,
                memory=pref.memory,
                metadata=PreferenceTextualMemoryMetadata(**pref.payload),
            )
            for pref in implicit_prefs
            if pref.payload["implicit_preference"]
        ]

        if self.reranker:
            explicit_prefs = self.reranker.rerank(query, explicit_prefs, top_k)
            implicit_prefs = self.reranker.rerank(query, implicit_prefs, top_k)
            explicit_prefs = [item for item, _ in explicit_prefs]
            implicit_prefs = [item for item, _ in implicit_prefs]

        return explicit_prefs + implicit_prefs
