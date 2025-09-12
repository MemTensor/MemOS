from typing import Any, ClassVar

from memos.memories.textual.prefer_text_memory.builders import BaseBuilder, NaiveBuilder
from memos.memories.textual.prefer_text_memory.retrievers import BaseRetriever, NaiveRetriever
from memos.memories.textual.prefer_text_memory.updater import BaseUpdater, NaiveUpdater
from memos.memories.textual.prefer_text_memory.assemble import BaseAssembler, NaiveAssembler
from memos.memories.textual.prefer_text_memory.config import BuilderConfigFactory, RetrieverConfigFactory, UpdaterConfigFactory, AssemblerConfigFactory


class BuilderFactory(BaseBuilder):
    """Factory class for creating Builder instances."""
    
    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveBuilder,
    }
    
    @classmethod
    def from_config(cls, config_factory: BuilderConfigFactory, llm_provider=None, embedder=None, vector_db=None) -> BaseBuilder:
        """Create a Builder instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        builder_class = cls.backend_to_class[backend]
        return builder_class(llm_provider=llm_provider, embedder=embedder, vector_db=vector_db)

class RetrieverFactory(BaseRetriever):
    """Factory class for creating Retriever instances."""
    
    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveRetriever,
    }
    
    @classmethod
    def from_config(cls, config_factory: RetrieverConfigFactory, llm_provider=None, embedder=None, vector_db=None) -> BaseRetriever:
        """Create a Retriever instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        retriever_class = cls.backend_to_class[backend]
        return retriever_class(llm_provider=llm_provider, embedder=embedder, vector_db=vector_db)

class UpdaterFactory(BaseUpdater):
    """Factory class for creating Updater instances."""
    
    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveUpdater,
    }
    
    @classmethod
    def from_config(cls, config_factory: UpdaterConfigFactory, llm_provider=None, embedder=None, vector_db=None) -> BaseUpdater:
        """Create a Updater instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        updater_class = cls.backend_to_class[backend]
        return updater_class(llm_provider=llm_provider, embedder=embedder, vector_db=vector_db)

class AssemblerFactory(BaseAssembler):
    """Factory class for creating Assembler instances."""
    
    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive": NaiveAssembler,
    }
    
    @classmethod
    def from_config(cls, config_factory: AssemblerConfigFactory, llm_provider=None, embedder=None, vector_db=None) -> BaseAssembler:
        """Create a Assembler instance from a configuration factory."""
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        assembler_class = cls.backend_to_class[backend]
        return assembler_class(llm_provider=llm_provider, embedder=embedder, vector_db=vector_db)
        