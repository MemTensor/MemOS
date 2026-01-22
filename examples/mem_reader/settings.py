"""Configuration settings for MemReader examples.

This module handles environment variables and default configurations for
LLMs, Embedders, and Chunkers used in the examples.
"""

import os

from typing import Any

from dotenv import load_dotenv


# Load environment variables from .env file
load_dotenv()


def get_llm_config() -> dict[str, Any]:
    """Get LLM configuration from environment variables."""
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    ollama_api_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")

    # Use MEMRADER_ variables from .env as primary source
    reader_model = os.getenv("MEMRADER_MODEL", os.getenv("MOS_CHAT_MODEL", "gpt-4o-mini"))
    reader_api_key = os.getenv("MEMRADER_API_KEY", openai_api_key)
    reader_api_base = os.getenv("MEMRADER_API_BASE", openai_base_url)

    # Check for specific MemReader backend override, otherwise assume openai if keys present
    llm_backend = os.getenv("MEMRADER_LLM_BACKEND", "openai")

    if llm_backend == "ollama":
        return {
            "backend": "ollama",
            "config": {
                "model_name_or_path": reader_model,
                "api_base": ollama_api_base,
                "temperature": float(os.getenv("MEMRADER_TEMPERATURE", "0.0")),
                "remove_think_prefix": os.getenv("MEMRADER_REMOVE_THINK_PREFIX", "true").lower()
                == "true",
                "max_tokens": int(os.getenv("MEMRADER_MAX_TOKENS", "8192")),
            },
        }
    else:  # openai
        return {
            "backend": "openai",
            "config": {
                "model_name_or_path": reader_model,
                "api_key": reader_api_key or "EMPTY",
                "api_base": reader_api_base,
                "temperature": float(os.getenv("MEMRADER_TEMPERATURE", "0.5")),
                "remove_think_prefix": os.getenv("MEMRADER_REMOVE_THINK_PREFIX", "true").lower()
                == "true",
                "max_tokens": int(os.getenv("MEMRADER_MAX_TOKENS", "8192")),
            },
        }


def get_embedder_config() -> dict[str, Any]:
    """Get Embedder configuration from environment variables."""
    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    ollama_api_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")

    # .env uses MOS_EMBEDDER_BACKEND
    embedder_backend = os.getenv("MOS_EMBEDDER_BACKEND", "ollama")

    if embedder_backend == "universal_api":
        return {
            "backend": "universal_api",
            "config": {
                "provider": os.getenv("MOS_EMBEDDER_PROVIDER", "openai"),
                "api_key": os.getenv("MOS_EMBEDDER_API_KEY", openai_api_key or "sk-xxxx"),
                "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-3-large"),
                "base_url": os.getenv("MOS_EMBEDDER_API_BASE", openai_base_url),
            },
        }
    else:  # ollama
        return {
            "backend": "ollama",
            "config": {
                "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "nomic-embed-text:latest"),
                "api_base": ollama_api_base,
            },
        }


def get_chunker_config() -> dict[str, Any]:
    """Get Chunker configuration from environment variables."""
    return {
        "backend": "sentence",
        "config": {
            "tokenizer_or_token_counter": "gpt2",
            "chunk_size": 512,
            "chunk_overlap": 128,
            "min_sentences_per_chunk": 1,
        },
    }


def get_reader_config() -> dict[str, Any]:
    """Get full reader configuration."""
    return {
        "llm": get_llm_config(),
        "embedder": get_embedder_config(),
        "chunker": get_chunker_config(),
    }
