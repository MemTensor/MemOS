"""Factory for creating internet retrievers."""

from typing import Any, ClassVar

from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.embedders.base import BaseEmbedder
from memos.mem_reader.factory import MemReaderFactory
from memos.memories.textual.tree_text_memory.retrieve.bochasearch import BochaAISearchRetriever
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever import (
    InternetGoogleRetriever,
)
from memos.memories.textual.tree_text_memory.retrieve.xinyusearch import XinyuSearchRetriever
from memos.memos_tools.singleton import singleton_factory


class InternetRetrieverFactory:
    """Factory class for creating internet retriever instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "google": InternetGoogleRetriever,
        "bing": InternetGoogleRetriever,  # TODO: Implement BingRetriever
        "xinyu": XinyuSearchRetriever,
        "bocha": BochaAISearchRetriever,
    }

    @classmethod
    @singleton_factory()
    def from_config(
        cls, config_factory: InternetRetrieverConfigFactory, embedder: BaseEmbedder
    ) -> InternetGoogleRetriever | None:
        """
        Create internet retriever from configuration.

        Args:
            config_factory: Internet retriever configuration
            embedder: Embedder instance for generating embeddings

        Returns:
            InternetRetriever instance or None if no configuration provided
        """
        if config_factory.backend is None:
            return None

        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid internet retriever backend: {backend}")

        retriever_class = cls.backend_to_class[backend]
        config = config_factory.config

        # Create retriever with appropriate parameters
        if backend == "google":
            return retriever_class(
                api_key=config.api_key,
                search_engine_id=config.search_engine_id,
                embedder=embedder,
                max_results=config.max_results,
                num_per_request=config.num_per_request,
            )
        elif backend == "bing":
            # TODO: Implement Bing retriever
            return retriever_class(
                api_key=config.api_key,
                search_engine_id=None,  # Bing doesn't use search_engine_id
                embedder=embedder,
                max_results=config.max_results,
                num_per_request=config.num_per_request,
            )
        elif backend == "xinyu":
            return retriever_class(
                access_key=config.api_key,  # Use api_key as access_key for xinyu
                search_engine_id=config.search_engine_id,
                embedder=embedder,
                reader=MemReaderFactory.from_config(config.reader),
                max_results=config.max_results,
            )
        elif backend == "bocha":
            return retriever_class(
                access_key=config.api_key,  # Use api_key as access_key for xinyu
                embedder=embedder,
                reader=MemReaderFactory.from_config(config.reader),
                max_results=config.max_results,
            )
        else:
            raise ValueError(f"Unsupported backend: {backend}")

    @classmethod
    def create_google_retriever(
        cls, api_key: str, search_engine_id: str, embedder: BaseEmbedder
    ) -> InternetGoogleRetriever:
        """
        Create Google Custom Search retriever.

        Args:
            api_key: Google API key
            search_engine_id: Google Custom Search Engine ID
            embedder: Embedder instance

        Returns:
            InternetRetriever instance
        """
        return InternetGoogleRetriever(api_key, search_engine_id, embedder)
