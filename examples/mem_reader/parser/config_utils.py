"""Shared configuration utilities for parser examples.

This module provides configuration functions that match the configuration
logic in examples/mem_reader/multimodal_struct_reader.py.
"""

import os

from typing import Any

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory


def get_reader_config() -> dict[str, Any]:
    """
    Get reader configuration from environment variables.

    Returns a dictionary that can be used to create MultiModalStructMemReaderConfig.
    Matches the configuration logic in examples/mem_reader/multimodal_struct_reader.py.

    Returns:
        Configuration dictionary with llm, embedder, and chunker configs
    """
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    ollama_api_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")

    # Get LLM backend and config
    llm_backend = os.getenv("MEM_READER_LLM_BACKEND", "openai")
    if llm_backend == "ollama":
        llm_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv("MEM_READER_LLM_MODEL", "qwen3:0.6b"),
                "api_base": ollama_api_base,
                "temperature": float(os.getenv("MEM_READER_LLM_TEMPERATURE", "0.0")),
                "remove_think_prefix": os.getenv(
                    "MEM_READER_LLM_REMOVE_THINK_PREFIX", "true"
                ).lower()
                == "true",
                "max_tokens": int(os.getenv("MEM_READER_LLM_MAX_TOKENS", "8192")),
            },
        }
    else:  # openai
        llm_config = {
            "backend": "openai",
            "config": {
                "model_name_or_path": os.getenv("MEM_READER_LLM_MODEL", "gpt-4o-mini"),
                "api_key": openai_api_key or os.getenv("MEMRADER_API_KEY", "EMPTY"),
                "api_base": openai_base_url,
                "temperature": float(os.getenv("MEM_READER_LLM_TEMPERATURE", "0.5")),
                "remove_think_prefix": os.getenv(
                    "MEM_READER_LLM_REMOVE_THINK_PREFIX", "true"
                ).lower()
                == "true",
                "max_tokens": int(os.getenv("MEM_READER_LLM_MAX_TOKENS", "8192")),
            },
        }

    # Get embedder backend and config
    embedder_backend = os.getenv(
        "MEM_READER_EMBEDDER_BACKEND", os.getenv("MOS_EMBEDDER_BACKEND", "ollama")
    )
    if embedder_backend == "universal_api":
        embedder_config = {
            "backend": "universal_api",
            "config": {
                "provider": os.getenv(
                    "MEM_READER_EMBEDDER_PROVIDER", os.getenv("MOS_EMBEDDER_PROVIDER", "openai")
                ),
                "api_key": os.getenv(
                    "MEM_READER_EMBEDDER_API_KEY",
                    os.getenv("MOS_EMBEDDER_API_KEY", openai_api_key or "sk-xxxx"),
                ),
                "model_name_or_path": os.getenv(
                    "MEM_READER_EMBEDDER_MODEL",
                    os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-3-large"),
                ),
                "base_url": os.getenv(
                    "MEM_READER_EMBEDDER_API_BASE",
                    os.getenv("MOS_EMBEDDER_API_BASE", openai_base_url),
                ),
            },
        }
    else:  # ollama
        embedder_config = {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv(
                    "MEM_READER_EMBEDDER_MODEL",
                    os.getenv("MOS_EMBEDDER_MODEL", "nomic-embed-text:latest"),
                ),
                "api_base": ollama_api_base,
            },
        }

    return {
        "llm": llm_config,
        "embedder": embedder_config,
        "chunker": {
            "backend": "sentence",
            "config": {
                "tokenizer_or_token_counter": "gpt2",
                "chunk_size": 512,
                "chunk_overlap": 128,
                "min_sentences_per_chunk": 1,
            },
        },
    }


def init_embedder_and_llm():
    """
    Initialize embedder and LLM from environment variables.

    Returns:
        Tuple of (embedder, llm) instances
    """
    config_dict = get_reader_config()

    # Initialize embedder
    embedder_config = EmbedderConfigFactory.model_validate(config_dict["embedder"])
    embedder = EmbedderFactory.from_config(embedder_config)

    # Initialize LLM
    llm_config = LLMConfigFactory.model_validate(config_dict["llm"])
    llm = LLMFactory.from_config(llm_config)

    return embedder, llm
