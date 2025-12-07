from datetime import datetime
from typing import Any, ClassVar

from pydantic import ConfigDict, Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.configs.chunker import ChunkerConfigFactory
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.llm import LLMConfigFactory


class BaseMemReaderConfig(BaseConfig):
    """Base configuration class for MemReader."""

    created_at: datetime = Field(
        default_factory=datetime.now, description="Creation timestamp for the MemReader"
    )

    @field_validator("created_at", mode="before")
    @classmethod
    def parse_datetime(cls, value):
        """Parse datetime from string if needed."""
        if isinstance(value, str):
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    llm: LLMConfigFactory = Field(..., description="LLM configuration for the MemReader")
    embedder: EmbedderConfigFactory = Field(
        ..., description="Embedder configuration for the MemReader"
    )
    chunker: ChunkerConfigFactory = Field(
        ..., description="Chunker configuration for the MemReader"
    )
    remove_prompt_example: bool = Field(
        default=False,
        description="whether remove example in memory extraction prompt to save token",
    )

    chat_chunker: dict[str, Any] = Field(
        default=None, description="Configuration for the MemReader chat chunk strategy"
    )


class SimpleStructMemReaderConfig(BaseMemReaderConfig):
    """SimpleStruct MemReader configuration class."""

    # Allow passing additional fields without raising validation errors
    model_config = ConfigDict(extra="allow", strict=True)


class MultiModalStructMemReaderConfig(BaseMemReaderConfig):
    """MultiModalStruct MemReader configuration class."""

    direct_markdown_hostnames: list[str] | None = Field(
        default=None,
        description="List of hostnames that should return markdown directly without parsing. "
        "If None, reads from FILE_PARSER_DIRECT_MARKDOWN_HOSTNAMES environment variable.",
    )


class StrategyStructMemReaderConfig(BaseMemReaderConfig):
    """StrategyStruct MemReader configuration class."""

    model_config = ConfigDict(extra="allow", strict=True)


class MemReaderConfigFactory(BaseConfig):
    """Factory class for creating MemReader configurations."""

    backend: str = Field(..., description="Backend for MemReader")
    config: dict[str, Any] = Field(..., description="Configuration for the MemReader backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "simple_struct": SimpleStructMemReaderConfig,
        "multimodal_struct": MultiModalStructMemReaderConfig,
        "strategy_struct": StrategyStructMemReaderConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "MemReaderConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
