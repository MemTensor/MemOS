from typing import Any, ClassVar

from memos.configs.parser import ParserConfigFactory
from memos.memos_tools.singleton import singleton_factory
from memos.parsers.base import BaseParser
from memos.parsers.markitdown import MarkItDownParser


class ParserFactory(BaseParser):
    """Factory class for creating Parser instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {"markitdown": MarkItDownParser}

    @classmethod
    @singleton_factory()
    def from_config(cls, config_factory: ParserConfigFactory) -> BaseParser:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        parser_class = cls.backend_to_class[backend]
        return parser_class(config_factory.config)
