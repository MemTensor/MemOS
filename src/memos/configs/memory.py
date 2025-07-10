from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.vec_db import VectorDBConfigFactory
from memos.exceptions import ConfigurationError


# ─── 1. Global Base Memory Config ─────────────────────────────────────────────


class BaseMemoryConfig(BaseConfig):
    """Base configuration class for memories."""

    cube_id: str | None = Field(
        None,
        description="Unique identifier for a MemCube that contains this memory",
    )


class UninitializedMemoryConfig(BaseMemoryConfig):
    """Uninitialized memory configuration class."""


# ─── 2.1. Activation Memory Configs ───────────────────────────────────────────


class BaseActMemoryConfig(BaseMemoryConfig):
    """Base configuration class for activation memories."""

    memory_filename: str = Field(
        "activation_memory.pickle",
        description="Filename for storing memories",
    )


class KVCacheMemoryConfig(BaseActMemoryConfig):
    """LLM KV Cache Memory configuration class."""

    extractor_llm: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the memory extractor",
    )

    @field_validator("extractor_llm")
    @classmethod
    def validate_extractor_llm(cls, extractor_llm: LLMConfigFactory) -> LLMConfigFactory:
        """Validate the extractor_llm field."""
        if extractor_llm.backend != "huggingface":
            raise ConfigurationError(
                f"KVCacheMemoryConfig requires extractor_llm backend to be 'huggingface', got '{extractor_llm.backend}'"
            )
        return extractor_llm


# ─── 2.2. Parametric Memory Configs ───────────────────────────────────────────


class BaseParaMemoryConfig(BaseMemoryConfig):
    """Base configuration class for parametric memories."""

    memory_filename: str = Field(
        "parametric_memory.adapter",
        description="Filename for storing memories",
    )


class LoRAMemoryConfig(BaseParaMemoryConfig):
    """LoRA memory configuration class."""

    extractor_llm: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the memory extractor",
    )

    @field_validator("extractor_llm")
    @classmethod
    def validate_extractor_llm(cls, extractor_llm: LLMConfigFactory) -> LLMConfigFactory:
        """Validate the extractor_llm field."""
        if extractor_llm.backend not in ["huggingface"]:
            raise ConfigurationError(
                f"LoRAMemoryConfig requires extractor_llm backend to be 'huggingface', got '{extractor_llm.backend}'"
            )
        return extractor_llm


# ─── 2.3. Textual Memory Configs ──────────────────────────────────────────────


class BaseTextMemoryConfig(BaseMemoryConfig):
    """Base configuration class for textual memories."""

    memory_filename: str = Field(
        "textual_memory.json",
        description="Filename for storing memories",
    )


class NaiveTextMemoryConfig(BaseTextMemoryConfig):
    """Naive textual memory configuration class."""

    extractor_llm: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the memory extractor",
    )


class GeneralTextMemoryConfig(BaseTextMemoryConfig):
    """General memory configuration class."""

    extractor_llm: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the memory extractor",
    )
    vector_db: VectorDBConfigFactory = Field(
        ...,
        default_factory=VectorDBConfigFactory,
        description="Vector database configuration for the memory storage",
    )
    embedder: EmbedderConfigFactory = Field(
        ...,
        default_factory=EmbedderConfigFactory,
        description="Embedder configuration for the memory embedding",
    )


class TreeTextMemoryConfig(BaseTextMemoryConfig):
    """Tree text memory configuration class."""

    extractor_llm: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the memory extractor",
    )
    dispatcher_llm: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the memory dispatcher_llm in retrieve module",
    )
    embedder: EmbedderConfigFactory = Field(
        ...,
        default_factory=EmbedderConfigFactory,
        description="Embedder configuration for the memory embedding",
    )
    graph_db: GraphDBConfigFactory = Field(
        ...,
        default_factory=GraphDBConfigFactory,
        description="Graph database configuration for the tree-memory storage",
    )
    internet_retriever: InternetRetrieverConfigFactory | None = Field(
        None,
        description="Internet retriever configuration (optional)",
    )

    reorganize: bool | None = Field(
        False,
        description="Optional description for this memory configuration.",
    )


# ─── 3. Global Memory Config Factory ──────────────────────────────────────────


class MemoryConfigFactory(BaseConfig):
    """Factory class for creating memory configurations."""

    backend: str = Field("uninitialized", description="Backend for memory")
    config: dict[str, Any] = Field({}, description="Configuration for the memory backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive_text": NaiveTextMemoryConfig,
        "general_text": GeneralTextMemoryConfig,
        "tree_text": TreeTextMemoryConfig,
        "kv_cache": KVCacheMemoryConfig,
        "lora": LoRAMemoryConfig,
        "uninitialized": UninitializedMemoryConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ConfigurationError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "MemoryConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
