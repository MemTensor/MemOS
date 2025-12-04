from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseEmbedderConfig(BaseConfig):
    """Base configuration class for embedding models."""

    model_name_or_path: str = Field(..., description="Model name or path")
    embedding_dims: int | None = Field(
        default=None, description="Number of dimensions for the embedding"
    )
    max_tokens: int | None = Field(
        default=8192,
        description="Maximum number of tokens per text. Texts exceeding this limit will be automatically truncated. Set to None to disable truncation.",
    )
    headers_extra: dict[str, Any] | None = Field(
        default=None,
        description="Extra headers for the embedding model, only for universal_api backend",
    )


class OllamaEmbedderConfig(BaseEmbedderConfig):
    api_base: str = Field(default="http://localhost:11434", description="Base URL for Ollama API")


class ArkEmbedderConfig(BaseEmbedderConfig):
    api_key: str = Field(..., description="Ark API key")
    api_base: str = Field(
        default="https://ark.cn-beijing.volces.com/api/v3/", description="Base URL for Ark API"
    )
    chunk_size: int = Field(default=1, description="Chunk size for Ark API")
    multi_modal: bool = Field(
        default=False,
        description="Whether to use multi-modal embedding (text + image) with Ark",
    )


class SenTranEmbedderConfig(BaseEmbedderConfig):
    """Configuration class for Sentence Transformer embeddings."""

    trust_remote_code: bool = Field(
        default=True,
        description="Whether to trust remote code when loading the model",
    )


class UniversalAPIEmbedderConfig(BaseEmbedderConfig):
    """
    Configuration class for universal API embedding providers, e.g.,
    OpenAI, etc.
    """

    provider: str = Field(..., description="Provider name, e.g., 'openai'")
    api_key: str = Field(..., description="API key for the embedding provider")
    base_url: str | None = Field(
        default=None, description="Optional base URL for custom or proxied endpoint"
    )


class EmbedderConfigFactory(BaseConfig):
    """Factory class for creating embedder configurations."""

    backend: str = Field(..., description="Backend for embedding model")
    config: dict[str, Any] = Field(..., description="Configuration for the embedding model backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "ollama": OllamaEmbedderConfig,
        "sentence_transformer": SenTranEmbedderConfig,
        "ark": ArkEmbedderConfig,
        "universal_api": UniversalAPIEmbedderConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "EmbedderConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
