from typing import Any, ClassVar

from memos.memories.textual.prefer_text_memory.adder import BaseAdder, NaiveAdder
from memos.memories.textual.prefer_text_memory.config import (
    AdderConfigFactory,
    ExtractorConfigFactory,
    RetrieverConfigFactory,
)
from memos.memories.textual.prefer_text_memory.extractor import BaseExtractor, NaiveExtractor
from memos.memories.textual.prefer_text_memory.retrievers import BaseRetriever, NaiveRetriever


class AdderFactory(BaseAdder):
    """Factory class for creating Adder instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveAdder,
    }

    @classmethod
    def from_config(
        cls,
        config_factory: AdderConfigFactory,
        llm_provider=None,
        embedder=None,
        vector_db=None,
        text_mem=None,
    ) -> BaseAdder:
        """Create a Adder instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        adder_class = cls.backend_to_class[backend]
        return adder_class(
            llm_provider=llm_provider, embedder=embedder, vector_db=vector_db, text_mem=text_mem
        )


class ExtractorFactory(BaseExtractor):
    """Factory class for creating Extractor instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveExtractor,
    }

    @classmethod
    def from_config(
        cls,
        config_factory: ExtractorConfigFactory,
        llm_provider=None,
        embedder=None,
        vector_db=None,
    ) -> BaseExtractor:
        """Create a Extractor instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        extractor_class = cls.backend_to_class[backend]
        return extractor_class(llm_provider=llm_provider, embedder=embedder, vector_db=vector_db)


class RetrieverFactory(BaseRetriever):
    """Factory class for creating Retriever instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveRetriever,
    }

    @classmethod
    def from_config(
        cls,
        config_factory: RetrieverConfigFactory,
        llm_provider=None,
        embedder=None,
        reranker=None,
        vector_db=None,
    ) -> BaseRetriever:
        """Create a Retriever instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        retriever_class = cls.backend_to_class[backend]
        return retriever_class(
            llm_provider=llm_provider, embedder=embedder, reranker=reranker, vector_db=vector_db
        )
