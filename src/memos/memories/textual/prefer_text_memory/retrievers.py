import os

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
        self,
        query: str,
        top_k: int,
        info: dict[str, Any] | None = None,
        search_filter: dict[str, Any] | None = None,
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
            prefs_mem_reranked = []
            prefs_mem_tuple = self.reranker.rerank(query, prefs_mem, top_k)
            for item, score in prefs_mem_tuple:
                item.metadata.score = score
                prefs_mem_reranked.append(item)
        return prefs_mem_reranked

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
            reranked_results = self.reranker.rerank(query, prefs_mem_for_reranker, top_k)
            prefs_mem_for_reranker = [item for item, _ in reranked_results]
            prefs_ids = [item.id for item in prefs_mem_for_reranker]
            prefs_dict = {item.id: item for item in prefs_mem}

            # Create mapping from id to score from reranked results
            reranked_scores = {item.id: score for item, score in reranked_results}

            # Assign scores to the original items
            result_items = []
            for item_id in prefs_ids:
                if item_id in prefs_dict:
                    original_item = prefs_dict[item_id]
                    original_item.metadata.score = reranked_scores.get(item_id)
                    result_items.append(original_item)
            return result_items
        return prefs_mem

    def retrieve(
        self,
        query: str,
        top_k: int,
        info: dict[str, Any] | None = None,
        search_filter: dict[str, Any] | None = None,
    ) -> list[TextualMemoryItem]:
        """Retrieve memories from the naive retriever."""
        # TODO: un-support rewrite query and session filter now
        if info:
            info = info.copy()  # Create a copy to avoid modifying the original
            info.pop("chat_history", None)
            info.pop("session_id", None)
        search_filter = {"and": [info, search_filter]}
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
                search_filter,
            )
            future_implicit = executor.submit(
                self.vector_db.search,
                query_embedding,
                query,
                "implicit_preference",
                top_k * 2,
                search_filter,
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

        reranker_map = {
            "naive": self._naive_reranker,
            "original_text": self._original_text_reranker,
        }
        reranker_func = reranker_map["naive"]
        prefs_mem_explicit = reranker_func(
            query=query,
            prefs_mem=explicit_prefs_mem,
            prefs=explicit_prefs,
            top_k=top_k,
        )
        prefs_mem_implicit = reranker_func(
            query=query,
            prefs_mem=implicit_prefs_mem,
            prefs=implicit_prefs,
            top_k=top_k,
        )

        # filter explicit mem by score bigger than threshold
        prefs_mem_explicit = [
            item
            for item in prefs_mem_explicit
            if item.metadata.score >= float(os.getenv("PREFERENCE_SEARCH_THRESHOLD", 0.0))
        ]
        prefs_mem_implicit = [
            item
            for item in prefs_mem_implicit
            if item.metadata.score >= float(os.getenv("PREFERENCE_SEARCH_THRESHOLD", 0.0))
        ]

        return prefs_mem_explicit + prefs_mem_implicit
