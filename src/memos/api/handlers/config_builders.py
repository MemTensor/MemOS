"""
Configuration builders for server handlers.

This module contains factory functions that build configurations for various
components used by the MemOS server. Each function constructs and validates
a configuration dictionary using the appropriate ConfigFactory.
"""

import json
import os

from typing import Any

from memos.api.config import APIConfig
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.internet_retriever import InternetRetrieverConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.configs.reranker import RerankerConfigFactory
from memos.configs.vec_db import VectorDBConfigFactory
from memos.memories.textual.prefer_text_memory.config import (
    AdderConfigFactory,
    ExtractorConfigFactory,
    RetrieverConfigFactory,
)


def build_graph_db_config(user_id: str = "default") -> dict[str, Any]:
    """
    Build graph database configuration.

    Args:
        user_id: User ID for configuration context (default: "default")

    Returns:
        Validated graph database configuration dictionary
    """
    graph_db_backend_map = {
        "neo4j-community": APIConfig.get_neo4j_community_config(user_id=user_id),
        "neo4j": APIConfig.get_neo4j_config(user_id=user_id),
        "nebular": APIConfig.get_nebular_config(user_id=user_id),
        "polardb": APIConfig.get_polardb_config(user_id=user_id),
    }

    graph_db_backend = os.getenv("NEO4J_BACKEND", "nebular").lower()
    return GraphDBConfigFactory.model_validate(
        {
            "backend": graph_db_backend,
            "config": graph_db_backend_map[graph_db_backend],
        }
    )


def build_vec_db_config() -> dict[str, Any]:
    """
    Build vector database configuration.

    Returns:
        Validated vector database configuration dictionary
    """
    return VectorDBConfigFactory.model_validate(
        {
            "backend": "milvus",
            "config": APIConfig.get_milvus_config(),
        }
    )


def build_llm_config() -> dict[str, Any]:
    """
    Build LLM configuration.

    Returns:
        Validated LLM configuration dictionary
    """
    return LLMConfigFactory.model_validate(
        {
            "backend": "openai",
            "config": APIConfig.get_openai_config(),
        }
    )


def build_chat_llm_config() -> list[dict[str, Any]]:
    """
    Build chat LLM configuration.

    Returns:
        Validated chat LLM configuration dictionary
    """
    configs = json.loads(os.getenv("CHAT_MODEL_LIST"))
    return [
        {
            "config_class": LLMConfigFactory.model_validate(
                {
                    "backend": cfg.get("backend", "openai"),
                    "config": (
                        {k: v for k, v in cfg.items() if k not in ["backend", "support_models"]}
                    )
                    if cfg
                    else APIConfig.get_openai_config(),
                }
            ),
            "support_models": cfg.get("support_models", None),
        }
        for cfg in configs
    ]


def build_embedder_config() -> dict[str, Any]:
    """
    Build embedder configuration.

    Returns:
        Validated embedder configuration dictionary
    """
    return EmbedderConfigFactory.model_validate(APIConfig.get_embedder_config())


def build_mem_reader_config() -> dict[str, Any]:
    """
    Build memory reader configuration.

    Returns:
        Validated memory reader configuration dictionary
    """
    return MemReaderConfigFactory.model_validate(
        APIConfig.get_product_default_config()["mem_reader"]
    )


def build_reranker_config() -> dict[str, Any]:
    """
    Build reranker configuration.

    Returns:
        Validated reranker configuration dictionary
    """
    return RerankerConfigFactory.model_validate(APIConfig.get_reranker_config())


def build_internet_retriever_config() -> dict[str, Any]:
    """
    Build internet retriever configuration.

    Returns:
        Validated internet retriever configuration dictionary
    """
    return InternetRetrieverConfigFactory.model_validate(APIConfig.get_internet_config())


def build_pref_extractor_config() -> dict[str, Any]:
    """
    Build preference memory extractor configuration.

    Returns:
        Validated extractor configuration dictionary
    """
    return ExtractorConfigFactory.model_validate({"backend": "naive", "config": {}})


def build_pref_adder_config() -> dict[str, Any]:
    """
    Build preference memory adder configuration.

    Returns:
        Validated adder configuration dictionary
    """
    return AdderConfigFactory.model_validate({"backend": "naive", "config": {}})


def build_pref_retriever_config() -> dict[str, Any]:
    """
    Build preference memory retriever configuration.

    Returns:
        Validated retriever configuration dictionary
    """
    return RetrieverConfigFactory.model_validate({"backend": "naive", "config": {}})
