"""Builder functions for initializing MemReader components.

This module provides factory functions to create configured instances of
LLMs, Embedders, and MemReaders, simplifying the setup process in examples.
"""

from typing import Any

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_reader import (
    MultiModalStructMemReaderConfig,
    SimpleStructMemReaderConfig,
)
from memos.configs.parser import ParserConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.parsers.factory import ParserFactory

from .settings import get_embedder_config, get_llm_config, get_reader_config


def build_llm_and_embedder() -> tuple[Any, Any]:
    """Initialize and return configured LLM and Embedder instances."""
    llm_config_dict = get_llm_config()
    embedder_config_dict = get_embedder_config()

    llm_config = LLMConfigFactory.model_validate(llm_config_dict)
    embedder_config = EmbedderConfigFactory.model_validate(embedder_config_dict)

    llm = LLMFactory.from_config(llm_config)
    embedder = EmbedderFactory.from_config(embedder_config)

    return embedder, llm


def build_file_parser() -> Any:
    """Initialize and return a configured file parser (MarkItDown).

    Returns:
        Configured parser instance or None if initialization fails.
    """
    try:
        parser_config = ParserConfigFactory.model_validate(
            {
                "backend": "markitdown",
                "config": {},
            }
        )
        return ParserFactory.from_config(parser_config)
    except Exception as e:
        print(f"⚠️  Warning: Could not initialize file parser: {e}")
        return None


def build_simple_reader() -> SimpleStructMemReader:
    """Initialize and return a configured SimpleStructMemReader.

    Returns:
        Configured SimpleStructMemReader instance.
    """
    config_dict = get_reader_config()
    # Simple reader doesn't need file parser
    config = SimpleStructMemReaderConfig(**config_dict)
    return SimpleStructMemReader(config)


def build_multimodal_reader() -> MultiModalStructMemReader:
    """Initialize and return a configured MultiModalStructMemReader.

    Returns:
        Configured MultiModalStructMemReader instance.
    """
    config_dict = get_reader_config()
    config = MultiModalStructMemReaderConfig(**config_dict)
    return MultiModalStructMemReader(config)
