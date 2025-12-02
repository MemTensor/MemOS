from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseChunkerConfig(BaseConfig):
    """Base configuration class for chunkers."""

    tokenizer_or_token_counter: str = Field(
        default="gpt2", description="Tokenizer model name or a token counting function"
    )
    chunk_size: int = Field(default=512, description="Maximum tokens per chunk")
    chunk_overlap: int = Field(default=128, description="Overlap between chunks")
    min_sentences_per_chunk: int = Field(default=1, description="Minimum sentences in each chunk")


class SentenceChunkerConfig(BaseChunkerConfig):
    """Configuration for sentence-based text chunker."""


class MarkdownChunkerConfig(BaseChunkerConfig):
    """Configuration for markdown-based text chunker."""

    headers_to_split_on: list[tuple[str, str]] = Field(
        default=[("#", "Header 1"), ("##", "Header 2"), ("###", "Header 3")],
        description="Headers to split on",
    )
    strip_headers: bool = Field(default=True, description="Strip headers from the text")
    recursive: bool = Field(
        default=False, description="Whether to use recursive character text splitter"
    )


class ChunkerConfigFactory(BaseConfig):
    """Factory class for creating chunker configurations."""

    backend: str = Field(..., description="Backend for chunker")
    config: dict[str, Any] = Field(..., description="Configuration for the chunker backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "sentence": SentenceChunkerConfig,
        "markdown": MarkdownChunkerConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "ChunkerConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
