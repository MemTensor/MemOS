from abc import ABC, abstractmethod
from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.memories.textual.item import PreferenceTextualMemoryMetadata, TextualMemoryItem
from memos.vec_dbs.item import MilvusVecDBItem


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

    def _naive_reranker(
        self, query: str, prefs_mem: list[TextualMemoryItem], top_k: int, **kwargs: Any
    ) -> list[TextualMemoryItem]:
        if self.reranker:
            prefs_mem = self.reranker.rerank(query, prefs_mem, top_k)
            return [item for item, _ in prefs_mem]
        return prefs_mem

    def _original_text_reranker(
        self,
        query: str,
        prefs_mem: list[TextualMemoryItem],
        prefs: list[MilvusVecDBItem],
        top_k: int,
        **kwargs: Any,
    ) -> list[TextualMemoryItem]:
        if self.reranker:
            from copy import deepcopy

            prefs_mem_for_reranker = deepcopy(prefs_mem)
            for pref_mem, pref in zip(prefs_mem_for_reranker, prefs, strict=False):
                pref_mem.memory = pref_mem.memory + "\n" + pref.original_text
            prefs_mem_for_reranker = self.reranker.rerank(query, prefs_mem_for_reranker, top_k)
            prefs_mem_for_reranker = [item for item, _ in prefs_mem_for_reranker]
            prefs_ids = [item.id for item in prefs_mem_for_reranker]
            prefs_dict = {item.id: item for item in prefs_mem}
            return [prefs_dict[item_id] for item_id in prefs_ids if item_id in prefs_dict]
        return prefs_mem

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
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            # Submit all search tasks
            future_explicit = executor.submit(
                self.vector_db.search,
                query_embedding,
                query,
                "explicit_preference",
                top_k * 2,
                info,
            )
            future_implicit = executor.submit(
                self.vector_db.search,
                query_embedding,
                query,
                "implicit_preference",
                top_k * 2,
                info,
            )

            # Wait for all results
            explicit_prefs = future_explicit.result()
            implicit_prefs = future_implicit.result()

        # sort by score
        explicit_prefs.sort(key=lambda x: x.score, reverse=True)
        implicit_prefs.sort(key=lambda x: x.score, reverse=True)

        explicit_prefs_mem = [
            TextualMemoryItem(
                id=pref.id,
                memory=pref.memory,
                metadata=PreferenceTextualMemoryMetadata(**pref.payload),
            )
            for pref in explicit_prefs
            if pref.payload.get("preference", None)
        ]

        implicit_prefs_mem = [
            TextualMemoryItem(
                id=pref.id,
                memory=pref.memory,
                metadata=PreferenceTextualMemoryMetadata(**pref.payload),
            )
            for pref in implicit_prefs
            if pref.payload.get("preference", None)
        ]

        # store explicit id and score, use it after reranker
        explicit_id_scores = {item.id: item.score for item in explicit_prefs}

        reranker_map = {
            "naive": self._naive_reranker,
            "original_text": self._original_text_reranker,
        }
        reranker_func = reranker_map["naive"]
        explicit_prefs_mem = reranker_func(
            query=query, prefs_mem=explicit_prefs_mem, prefs=explicit_prefs, top_k=top_k
        )
        implicit_prefs_mem = reranker_func(
            query=query, prefs_mem=implicit_prefs_mem, prefs=implicit_prefs, top_k=top_k
        )

        # filter explicit mem by score bigger than threshold
        explicit_prefs_mem = [
            item for item in explicit_prefs_mem if explicit_id_scores.get(item.id, 0) >= 0.0
        ]

        return explicit_prefs_mem + implicit_prefs_mem
