from datetime import datetime
from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.configs.chunker import ChunkerConfigFactory
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.llm import LLMConfigFactory


class BaseMemReaderConfig(BaseConfig):
    """Base configuration class for MemReader."""

    created_at: datetime = Field(
        default_factory=datetime.now, description="Creation timestamp for the MemReader"
    )
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


class SimpleStructMemReaderConfig(BaseMemReaderConfig):
    """SimpleStruct MemReader configuration class."""


class MemReaderConfigFactory(BaseConfig):
    """Factory class for creating MemReader configurations."""

    backend: str = Field(..., description="Backend for MemReader")
    config: dict[str, Any] = Field(..., description="Configuration for the MemReader backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "simple_struct": SimpleStructMemReaderConfig,
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
