from typing import Any, ClassVar

from memos.configs.chunker import ChunkerConfigFactory

from .base import BaseChunker
from .markdown_chunker import MarkdownChunker
from .sentence_chunker import SentenceChunker


class ChunkerFactory:
    """Factory class for creating chunker instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "sentence": SentenceChunker,
        "markdown": MarkdownChunker,
    }

    @classmethod
    def from_config(cls, config_factory: ChunkerConfigFactory) -> BaseChunker:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        chunker_class = cls.backend_to_class[backend]
        return chunker_class(config_factory.config)
