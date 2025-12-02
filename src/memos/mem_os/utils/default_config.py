"""
Default configuration utilities for MemOS.
Provides simplified configuration generation for users.
"""

from typing import Literal

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube


def get_default_config(
    openai_api_key: str,
    openai_api_base: str = "https://api.openai.com/v1",
    text_mem_type: Literal["tree_text", "general_text"] = "general_text",
    user_id: str = "default_user",
    **kwargs,
) -> MOSConfig:
    """
    Generate a default MOS configuration with minimal user input.

    Args:
        openai_api_key (str): OpenAI API key
        openai_api_base (str): OpenAI API base URL, defaults to "https://api.openai.com/v1"
        text_mem_type (str): Type of text memory, either "tree_text" or "general_text"
        user_id (str): User ID for the configuration
        **kwargs: Additional configuration overrides

    Returns:
        MOSConfig: Complete MOS configuration object

    Example:
        ```python
        config = get_default_config(
            openai_api_key="sk-...",
            openai_api_base="https://api.openai.com/v1",
            text_mem_type="general_text"
        )
        mos = MOS(config)
        ```
    """

    # Base OpenAI configuration
    openai_config = {
        "model_name_or_path": kwargs.get("model_name", "gpt-4o-mini"),
        "temperature": kwargs.get("temperature", 0.8),
        "max_tokens": kwargs.get("max_tokens", 1024),
        "top_p": kwargs.get("top_p", 0.9),
        "top_k": kwargs.get("top_k", 50),
        "remove_think_prefix": True,
        "api_key": openai_api_key,
        "api_base": openai_api_base,
    }

    # Universal API embedder configuration (using OpenAI)
    embedder_config = {
        "backend": "universal_api",
        "config": {
            "provider": "openai",
            "api_key": openai_api_key,
            "model_name_or_path": kwargs.get("embedder_model", "text-embedding-3-large"),
            "base_url": openai_api_base,
        },
    }

    # Base configuration
    config_dict = {
        "user_id": user_id,
        "chat_model": {
            "backend": "openai",
            "config": openai_config,
        },
        "mem_reader": {
            "backend": "simple_struct",
            "config": {
                "llm": {
                    "backend": "openai",
                    "config": openai_config,
                },
                "embedder": embedder_config,
                "chunker": {
                    "backend": "sentence",
                    "config": {
                        "tokenizer_or_token_counter": "gpt2",
                        "chunk_size": kwargs.get("chunk_size", 512),
                        "chunk_overlap": kwargs.get("chunk_overlap", 128),
                        "min_sentences_per_chunk": 1,
                    },
                },
            },
        },
        "enable_textual_memory": True,
        "enable_activation_memory": kwargs.get("enable_activation_memory", False),
        "top_k": kwargs.get("top_k", 5),
        "max_turns_window": kwargs.get("max_turns_window", 20),
        "enable_mem_scheduler": kwargs.get("enable_mem_scheduler", False),
    }

    # Note: text_mem configuration is handled in get_default_cube_config
    # MOSConfig doesn't have text_mem field, it's only in MemCube config

    # Add scheduler configuration if enabled
    if config_dict.get("enable_mem_scheduler", False):
        config_dict["mem_scheduler"] = {
            "backend": "general_scheduler",
            "config": {
                "top_k": kwargs.get("scheduler_top_k", 10),
                "top_n": kwargs.get("scheduler_top_n", 5),
                "act_mem_update_interval": kwargs.get("scheduler_act_mem_update_interval", 300),
                "context_window_size": kwargs.get("scheduler_context_window_size", 5),
                "thread_pool_max_workers": kwargs.get("scheduler_thread_pool_max_workers", 10),
                "consume_interval_seconds": kwargs.get("scheduler_consume_interval_seconds", 0.01),
                "enable_parallel_dispatch": kwargs.get("scheduler_enable_parallel_dispatch", True),
                "enable_activation_memory": True,
            },
        }

    # Add activation memory if enabled
    if config_dict.get("enable_activation_memory", False):
        config_dict["act_mem"] = {
            "backend": "kv_cache",
            "config": {
                "memory_filename": kwargs.get(
                    "activation_memory_filename", "activation_memory.pickle"
                ),
                "extractor_llm": {
                    "backend": "openai",
                    "config": openai_config,
                },
            },
        }

    return MOSConfig(**config_dict)


def get_default_cube_config(
    openai_api_key: str,
    openai_api_base: str = "https://api.openai.com/v1",
    text_mem_type: Literal["tree_text", "general_text"] = "general_text",
    user_id: str = "default_user",
    **kwargs,
) -> GeneralMemCubeConfig:
    """
    Generate a default MemCube configuration with minimal user input.

    Args:
        openai_api_key (str): OpenAI API key
        openai_api_base (str): OpenAI API base URL, defaults to "https://api.openai.com/v1"
        text_mem_type (str): Type of text memory, either "tree_text" or "general_text"
        user_id (str): User ID for the configuration
        **kwargs: Additional configuration overrides

    Returns:
        GeneralMemCubeConfig: Complete MemCube configuration object
    """

    # Base OpenAI configuration
    openai_config = {
        "model_name_or_path": kwargs.get("model_name", "gpt-4o-mini"),
        "temperature": kwargs.get("temperature", 0.8),
        "max_tokens": kwargs.get("max_tokens", 1024),
        "top_p": kwargs.get("top_p", 0.9),
        "top_k": kwargs.get("top_k", 50),
        "remove_think_prefix": True,
        "api_key": openai_api_key,
        "api_base": openai_api_base,
    }

    # Universal API embedder configuration (using OpenAI)
    embedder_config = {
        "backend": "universal_api",
        "config": {
            "provider": "openai",
            "api_key": openai_api_key,
            "model_name_or_path": kwargs.get("embedder_model", "text-embedding-3-large"),
            "base_url": openai_api_base,
        },
    }

    # Configure text memory based on type
    if text_mem_type == "tree_text":
        # Tree text memory requires Neo4j configuration
        db_name = f"memos{user_id.replace('-', '').replace('_', '')}"
        if not kwargs.get("use_multi_db", False):
            db_name = kwargs.get("neo4j_db_name", "defaultdb")
        neo4j_config = {
            "uri": kwargs.get("neo4j_uri", "bolt://localhost:7687"),
            "user": kwargs.get("neo4j_user", "neo4j"),
            "db_name": db_name,
            "password": kwargs.get("neo4j_password", "12345678"),
            "auto_create": True,
            "use_multi_db": kwargs.get("use_multi_db", False),
            "embedding_dimension": kwargs.get("embedding_dimension", 3072),
        }
        if not kwargs.get("use_multi_db", False):
            neo4j_config["user_name"] = f"memos{user_id.replace('-', '').replace('_', '')}"

        text_mem_config = {
            "backend": "tree_text",
            "config": {
                "extractor_llm": {"backend": "openai", "config": openai_config},
                "dispatcher_llm": {"backend": "openai", "config": openai_config},
                "graph_db": {
                    "backend": "neo4j",
                    "config": neo4j_config,
                },
                "embedder": embedder_config,
                "reorganize": kwargs.get("enable_reorganize", False),
            },
        }

    elif text_mem_type == "general_text":
        # General text memory with file storage
        text_mem_config = {
            "backend": "general_text",
            "config": {
                "cube_id": kwargs.get("cube_id", f"{user_id}_cube"),
                "memory_filename": kwargs.get("memory_filename", "textual_memory.json"),
                "extractor_llm": {"backend": "openai", "config": openai_config},
                "vector_db": {
                    "backend": "qdrant",
                    "config": {
                        "collection_name": kwargs.get("collection_name", f"{user_id}_collection"),
                        "vector_dimension": kwargs.get("vector_dimension", 3072),
                        "distance_metric": "cosine",
                    },
                },
                "embedder": embedder_config,
            },
        }

    # Configure activation memory if enabled
    act_mem_config = {}
    if kwargs.get("enable_activation_memory", False):
        act_mem_config = {
            "backend": "kv_cache",
            "config": {
                "memory_filename": kwargs.get(
                    "activation_memory_filename", "activation_memory.pickle"
                ),
                "extractor_llm": {
                    "backend": "openai",
                    "config": openai_config,
                },
            },
        }

    # Create MemCube configuration
    cube_config_dict = {
        "user_id": user_id,
        "cube_id": kwargs.get("cube_id", f"{user_id}_default_cube"),
        "text_mem": text_mem_config,
        "act_mem": act_mem_config,
        "para_mem": {},  # Empty parametric memory by default
    }

    return GeneralMemCubeConfig.model_validate(cube_config_dict)


def get_default(
    openai_api_key: str,
    openai_api_base: str = "https://api.openai.com/v1",
    text_mem_type: Literal["tree_text", "general_text"] = "general_text",
    user_id: str = "default_user",
    **kwargs,
) -> tuple[MOSConfig, GeneralMemCube]:
    """
    Generate both MOS configuration and default MemCube with minimal user input.

    This is the main convenience function for getting started with MemOS.

    Args:
        openai_api_key (str): OpenAI API key
        openai_api_base (str): OpenAI API base URL, defaults to "https://api.openai.com/v1"
        text_mem_type (str): Type of text memory, either "tree_text" or "general_text"
        user_id (str): User ID for the configuration
        **kwargs: Additional configuration overrides

    Returns:
        Tuple[MOSConfig, GeneralMemCube]: Complete MOS configuration and MemCube instance

    Example:
        ```python
        mos_config, default_cube = get_default(
            openai_api_key="sk-...",
            text_mem_type="general_text"
        )
        memory = MOS(mos_config)
        memory.register_mem_cube(default_cube)
        ```
    """

    # Generate MOS configuration
    mos_config = get_default_config(
        openai_api_key=openai_api_key,
        openai_api_base=openai_api_base,
        text_mem_type=text_mem_type,
        user_id=user_id,
        **kwargs,
    )

    # Generate MemCube configuration
    cube_config = get_default_cube_config(
        openai_api_key=openai_api_key,
        openai_api_base=openai_api_base,
        text_mem_type=text_mem_type,
        user_id=user_id,
        **kwargs,
    )

    # Create MemCube instance
    default_cube = GeneralMemCube(cube_config)

    return mos_config, default_cube


def get_simple_config(
    openai_api_key: str,
    openai_api_base: str = "https://api.openai.com/v1",
    text_mem_type: Literal["tree_text", "general_text"] = "general_text",
    user_id: str = "default_user",
) -> MOSConfig:
    """
    Get a minimal configuration with only essential parameters.

    This is the simplest way to get started with MemOS.

    Args:
        openai_api_key (str): OpenAI API key
        openai_api_base (str): OpenAI API base URL
        text_mem_type (str): Type of text memory
        user_id (str): User ID

    Returns:
        MOSConfig: Basic MOS configuration

    Example:
        ```python
        config = get_simple_config(
            openai_api_key="sk-...",
            text_mem_type="general_text"
        )
        mos = MOS(config)
        ```
    """
    return get_default_config(
        openai_api_key=openai_api_key,
        openai_api_base=openai_api_base,
        text_mem_type=text_mem_type,
        user_id=user_id,
    )
