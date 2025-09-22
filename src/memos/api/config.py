import json
import os

from typing import Any

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube


# Load environment variables
load_dotenv()


class APIConfig:
    """Centralized configuration management for MemOS APIs."""

    @staticmethod
    def get_openai_config() -> dict[str, Any]:
        """Get OpenAI configuration."""
        return {
            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o-mini"),
            "temperature": float(os.getenv("MOS_CHAT_TEMPERATURE", "0.8")),
            "max_tokens": int(os.getenv("MOS_MAX_TOKENS", "1024")),
            "top_p": float(os.getenv("MOS_TOP_P", "0.9")),
            "top_k": int(os.getenv("MOS_TOP_K", "50")),
            "remove_think_prefix": True,
            "api_key": os.getenv("OPENAI_API_KEY", "your-api-key-here"),
            "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
        }

    @staticmethod
    def qwen_config() -> dict[str, Any]:
        """Get Qwen configuration."""
        return {
            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "Qwen/Qwen3-1.7B"),
            "temperature": float(os.getenv("MOS_CHAT_TEMPERATURE", "0.8")),
            "max_tokens": int(os.getenv("MOS_MAX_TOKENS", "4096")),
            "remove_think_prefix": True,
        }

    @staticmethod
    def vllm_config() -> dict[str, Any]:
        """Get Qwen configuration."""
        return {
            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "Qwen/Qwen3-1.7B"),
            "temperature": float(os.getenv("MOS_CHAT_TEMPERATURE", "0.8")),
            "max_tokens": int(os.getenv("MOS_MAX_TOKENS", "4096")),
            "remove_think_prefix": True,
            "api_key": os.getenv("VLLM_API_KEY", ""),
            "api_base": os.getenv("VLLM_API_BASE", "http://localhost:8088/v1"),
            "model_schema": os.getenv("MOS_MODEL_SCHEMA", "memos.configs.llm.VLLMLLMConfig"),
        }

    @staticmethod
    def get_activation_config() -> dict[str, Any]:
        """Get Ollama configuration."""
        return {
            "backend": "kv_cache",
            "config": {
                "memory_filename": "activation_memory.pickle",
                "extractor_llm": {
                    "backend": "huggingface_singleton",
                    "config": {
                        "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "Qwen/Qwen3-1.7B"),
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "top_p": 0.9,
                        "top_k": 50,
                        "add_generation_prompt": True,
                        "remove_think_prefix": False,
                    },
                },
            },
        }

    @staticmethod
    def get_activation_vllm_config() -> dict[str, Any]:
        """Get Ollama configuration."""
        return {
            "backend": "vllm_kv_cache",
            "config": {
                "memory_filename": "activation_memory.pickle",
                "extractor_llm": {
                    "backend": "vllm",
                    "config": APIConfig.vllm_config(),
                },
            },
        }

    @staticmethod
    def get_reranker_config() -> dict[str, Any]:
        """Get embedder configuration."""
        embedder_backend = os.getenv("MOS_RERANKER_BACKEND", "http_bge")

        if embedder_backend == "http_bge":
            return {
                "backend": "http_bge",
                "config": {
                    "url": os.getenv("MOS_RERANKER_URL"),
                    "model": "bge-reranker-v2-m3",
                    "timeout": 10,
                },
            }
        else:
            return {
                "backend": "cosine_local",
                "config": {
                    "level_weights": {"topic": 1.0, "concept": 1.0, "fact": 1.0},
                    "level_field": "background",
                },
            }

    @staticmethod
    def get_embedder_config() -> dict[str, Any]:
        """Get embedder configuration."""
        embedder_backend = os.getenv("MOS_EMBEDDER_BACKEND", "ollama")

        if embedder_backend == "universal_api":
            return {
                "backend": "universal_api",
                "config": {
                    "provider": os.getenv("MOS_EMBEDDER_PROVIDER", "openai"),
                    "api_key": os.getenv("MOS_EMBEDDER_API_KEY", "sk-xxxx"),
                    "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-3-large"),
                    "base_url": os.getenv("MOS_EMBEDDER_API_BASE", "http://openai.com"),
                },
            }
        else:  # ollama
            return {
                "backend": "ollama",
                "config": {
                    "model_name_or_path": os.getenv(
                        "MOS_EMBEDDER_MODEL", "nomic-embed-text:latest"
                    ),
                    "api_base": os.getenv("OLLAMA_API_BASE", "http://localhost:11434"),
                },
            }

    @staticmethod
    def get_internet_config() -> dict[str, Any]:
        """Get embedder configuration."""
        return {
            "backend": "bocha",
            "config": {
                "api_key": os.getenv("BOCHA_API_KEY"),
                "max_results": 15,
                "num_per_request": 10,
                "reader": {
                    "backend": "simple_struct",
                    "config": {
                        "llm": {
                            "backend": "openai",
                            "config": {
                                "model_name_or_path": os.getenv("MEMRADER_MODEL"),
                                "temperature": 0.6,
                                "max_tokens": 5000,
                                "top_p": 0.95,
                                "top_k": 20,
                                "api_key": os.getenv("MEMRADER_API_KEY", "EMPTY"),
                                "api_base": os.getenv("MEMRADER_API_BASE"),
                                "remove_think_prefix": True,
                                "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
                            },
                        },
                        "embedder": APIConfig.get_embedder_config(),
                        "chunker": {
                            "backend": "sentence",
                            "config": {
                                "tokenizer_or_token_counter": "gpt2",
                                "chunk_size": 512,
                                "chunk_overlap": 128,
                                "min_sentences_per_chunk": 1,
                            },
                        },
                    },
                },
            },
        }

    @staticmethod
    def get_neo4j_community_config(user_id: str | None = None) -> dict[str, Any]:
        """Get Neo4j community configuration."""
        return {
            "uri": os.getenv("NEO4J_URI", "bolt://localhost:7687"),
            "user": os.getenv("NEO4J_USER", "neo4j"),
            "db_name": os.getenv("NEO4J_DB_NAME", "neo4j"),
            "password": os.getenv("NEO4J_PASSWORD", "12345678"),
            "user_name": f"memos{user_id.replace('-', '')}",
            "auto_create": False,
            "use_multi_db": False,
            "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", 1024)),
            "vec_config": {
                # Pass nested config to initialize external vector DB
                # If you use qdrant, please use Server instead of local mode.
                "backend": "qdrant",
                "config": {
                    "collection_name": "neo4j_vec_db",
                    "vector_dimension": int(os.getenv("EMBEDDING_DIMENSION", 1024)),
                    "distance_metric": "cosine",
                    "host": os.getenv("QDRANT_HOST", "localhost"),
                    "port": int(os.getenv("QDRANT_PORT", "6333")),
                },
            },
        } 

    @staticmethod
    def get_neo4j_config(user_id: str | None = None) -> dict[str, Any]:
        """Get Neo4j configuration."""
        if os.getenv("MOS_NEO4J_SHARED_DB", "false").lower() == "true":
            return APIConfig.get_neo4j_shared_config(user_id)
        else:
            return APIConfig.get_noshared_neo4j_config(user_id)

    @staticmethod
    def get_noshared_neo4j_config(user_id) -> dict[str, Any]:
        """Get Neo4j configuration."""
        return {
            "uri": os.getenv("NEO4J_URI", "bolt://localhost:7687"),
            "user": os.getenv("NEO4J_USER", "neo4j"),
            "db_name": f"memos{user_id.replace('-', '')}",
            "password": os.getenv("NEO4J_PASSWORD", "12345678"),
            "auto_create": True,
            "use_multi_db": True,
            "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", 3072)),
        }

    @staticmethod
    def get_neo4j_shared_config(user_id: str | None = None) -> dict[str, Any]:
        """Get Neo4j configuration."""
        return {
            "uri": os.getenv("NEO4J_URI", "bolt://localhost:7687"),
            "user": os.getenv("NEO4J_USER", "neo4j"),
            "db_name": os.getenv("NEO4J_DB_NAME", "shared-tree-textual-memory"),
            "password": os.getenv("NEO4J_PASSWORD", "12345678"),
            "user_name": f"memos{user_id.replace('-', '')}",
            "auto_create": True,
            "use_multi_db": False,
            "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", 3072)),
        }

    @staticmethod
    def get_nebular_config(user_id: str | None = None) -> dict[str, Any]:
        """Get Nebular configuration."""
        return {
            "uri": json.loads(os.getenv("NEBULAR_HOSTS", '["localhost"]')),
            "user": os.getenv("NEBULAR_USER", "root"),
            "password": os.getenv("NEBULAR_PASSWORD", "xxxxxx"),
            "space": os.getenv("NEBULAR_SPACE", "shared-tree-textual-memory"),
            "user_name": f"memos{user_id.replace('-', '')}",
            "use_multi_db": False,
            "auto_create": True,
            "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", 3072)),
        }

    @staticmethod
    def get_mysql_config() -> dict[str, Any]:
        """Get MySQL configuration."""
        return {
            "host": os.getenv("MYSQL_HOST", "localhost"),
            "port": int(os.getenv("MYSQL_PORT", "3306")),
            "username": os.getenv("MYSQL_USERNAME", "root"),
            "password": os.getenv("MYSQL_PASSWORD", "12345678"),
            "database": os.getenv("MYSQL_DATABASE", "memos_users"),
            "charset": os.getenv("MYSQL_CHARSET", "utf8mb4"),
        }

    @staticmethod
    def get_scheduler_config() -> dict[str, Any]:
        """Get scheduler configuration."""
        return {
            "backend": "general_scheduler",
            "config": {
                "top_k": int(os.getenv("MOS_SCHEDULER_TOP_K", "10")),
                "act_mem_update_interval": int(
                    os.getenv("MOS_SCHEDULER_ACT_MEM_UPDATE_INTERVAL", "300")
                ),
                "context_window_size": int(os.getenv("MOS_SCHEDULER_CONTEXT_WINDOW_SIZE", "5")),
                "thread_pool_max_workers": int(
                    os.getenv("MOS_SCHEDULER_THREAD_POOL_MAX_WORKERS", "10")
                ),
                "consume_interval_seconds": int(
                    os.getenv("MOS_SCHEDULER_CONSUME_INTERVAL_SECONDS", "3")
                ),
                "enable_parallel_dispatch": os.getenv(
                    "MOS_SCHEDULER_ENABLE_PARALLEL_DISPATCH", "true"
                ).lower()
                == "true",
                "enable_activation_memory": True,
            },
        }

    @staticmethod
    def is_scheduler_enabled() -> bool:
        """Check if scheduler is enabled via environment variable."""
        return os.getenv("MOS_ENABLE_SCHEDULER", "false").lower() == "true"

    @staticmethod
    def is_default_cube_config_enabled() -> bool:
        """Check if default cube config is enabled via environment variable."""
        return os.getenv("MOS_ENABLE_DEFAULT_CUBE_CONFIG", "false").lower() == "true"

    @staticmethod
    def is_dingding_bot_enabled() -> bool:
        """Check if DingDing bot is enabled via environment variable."""
        return os.getenv("ENABLE_DINGDING_BOT", "false").lower() == "true"

    @staticmethod
    def get_dingding_bot_config() -> dict[str, Any] | None:
        """Get DingDing bot configuration if enabled."""
        if not APIConfig.is_dingding_bot_enabled():
            return None

        return {
            "enabled": True,
            "access_token_user": os.getenv("DINGDING_ACCESS_TOKEN_USER", ""),
            "secret_user": os.getenv("DINGDING_SECRET_USER", ""),
            "access_token_error": os.getenv("DINGDING_ACCESS_TOKEN_ERROR", ""),
            "secret_error": os.getenv("DINGDING_SECRET_ERROR", ""),
            "robot_code": os.getenv("DINGDING_ROBOT_CODE", ""),
            "app_key": os.getenv("DINGDING_APP_KEY", ""),
            "app_secret": os.getenv("DINGDING_APP_SECRET", ""),
            "oss_endpoint": os.getenv("OSS_ENDPOINT", ""),
            "oss_region": os.getenv("OSS_REGION", ""),
            "oss_bucket_name": os.getenv("OSS_BUCKET_NAME", ""),
            "oss_access_key_id": os.getenv("OSS_ACCESS_KEY_ID", ""),
            "oss_access_key_secret": os.getenv("OSS_ACCESS_KEY_SECRET", ""),
            "oss_public_base_url": os.getenv("OSS_PUBLIC_BASE_URL", ""),
        }

    @staticmethod
    def get_product_default_config() -> dict[str, Any]:
        """Get default configuration for Product API."""
        openai_config = APIConfig.get_openai_config()
        qwen_config = APIConfig.qwen_config()
        vllm_config = APIConfig.vllm_config()
        backend_model = {
            "openai": openai_config,
            "huggingface": qwen_config,
            "vllm": vllm_config,
        }
        backend = os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai")
        mysql_config = APIConfig.get_mysql_config()
        config = {
            "user_id": os.getenv("MOS_USER_ID", "root"),
            "chat_model": {"backend": backend, "config": backend_model[backend]},
            "mem_reader": {
                "backend": "simple_struct",
                "config": {
                    "llm": {
                        "backend": "openai",
                        "config": openai_config,
                    },
                    "embedder": APIConfig.get_embedder_config(),
                    "chunker": {
                        "backend": "sentence",
                        "config": {
                            "tokenizer_or_token_counter": "gpt2",
                            "chunk_size": 512,
                            "chunk_overlap": 128,
                            "min_sentences_per_chunk": 1,
                        },
                    },
                },
            },
            "enable_textual_memory": True,
            "enable_activation_memory": os.getenv("ENABLE_ACTIVATION_MEMORY", "false").lower()
            == "true",
            "top_k": int(os.getenv("MOS_TOP_K", "50")),
            "max_turns_window": int(os.getenv("MOS_MAX_TURNS_WINDOW", "20")),
        }

        # Add scheduler configuration if enabled
        if APIConfig.is_scheduler_enabled():
            config["mem_scheduler"] = APIConfig.get_scheduler_config()
            config["enable_mem_scheduler"] = True
        else:
            config["enable_mem_scheduler"] = False

        # Add user manager configuration if enabled
        if os.getenv("MOS_USER_MANAGER_BACKEND", "sqlite").lower() == "mysql":
            config["user_manager"] = {
                "backend": "mysql",
                "config": mysql_config,
            }

        return config

    @staticmethod
    def get_start_default_config() -> dict[str, Any]:
        """Get default configuration for Start API."""
        config = {
            "user_id": os.getenv("MOS_USER_ID", "default_user"),
            "session_id": os.getenv("MOS_SESSION_ID", "default_session"),
            "enable_textual_memory": True,
            "enable_activation_memory": os.getenv("ENABLE_ACTIVATION_MEMORY", "false").lower()
            == "true",
            "top_k": int(os.getenv("MOS_TOP_K", "5")),
            "chat_model": {
                "backend": os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai"),
                "config": {
                    "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o-mini"),
                    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxxx"),
                    "temperature": float(os.getenv("MOS_CHAT_TEMPERATURE", 0.7)),
                    "api_base": os.getenv("OPENAI_API_BASE", "http://xxxxxx:3000/v1"),
                    "max_tokens": int(os.getenv("MOS_MAX_TOKENS", 1024)),
                    "top_p": float(os.getenv("MOS_TOP_P", 0.9)),
                    "top_k": int(os.getenv("MOS_TOP_K", 50)),
                    "remove_think_prefix": True,
                },
            },
        }

        # Add scheduler configuration if enabled
        if APIConfig.is_scheduler_enabled():
            config["mem_scheduler"] = APIConfig.get_scheduler_config()
            config["enable_mem_scheduler"] = True
        else:
            config["enable_mem_scheduler"] = False

        return config

    @staticmethod
    def create_user_config(user_name: str, user_id: str) -> tuple[MOSConfig, GeneralMemCube]:
        """Create configuration for a specific user."""
        openai_config = APIConfig.get_openai_config()
        qwen_config = APIConfig.qwen_config()
        vllm_config = APIConfig.vllm_config()
        mysql_config = APIConfig.get_mysql_config()
        backend = os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai")
        backend_model = {
            "openai": openai_config,
            "huggingface": qwen_config,
            "vllm": vllm_config,
        }
        # Create MOSConfig
        config_dict = {
            "user_id": user_id,
            "chat_model": {
                "backend": backend,
                "config": backend_model[backend],
            },
            "mem_reader": {
                "backend": "simple_struct",
                "config": {
                    "llm": {
                        "backend": "openai",
                        "config": openai_config,
                    },
                    "embedder": APIConfig.get_embedder_config(),
                    "chunker": {
                        "backend": "sentence",
                        "config": {
                            "tokenizer_or_token_counter": "gpt2",
                            "chunk_size": 512,
                            "chunk_overlap": 128,
                            "min_sentences_per_chunk": 1,
                        },
                    },
                },
            },
            "enable_textual_memory": True,
            "enable_activation_memory": os.getenv("ENABLE_ACTIVATION_MEMORY", "false").lower()
            == "true",
            "top_k": 30,
            "max_turns_window": 20,
        }
        # Add scheduler configuration if enabled
        if APIConfig.is_scheduler_enabled():
            config_dict["mem_scheduler"] = APIConfig.get_scheduler_config()
            config_dict["enable_mem_scheduler"] = True
        else:
            config_dict["enable_mem_scheduler"] = False

        # Add user manager configuration if enabled
        if os.getenv("MOS_USER_MANAGER_BACKEND", "sqlite").lower() == "mysql":
            config_dict["user_manager"] = {
                "backend": "mysql",
                "config": mysql_config,
            }

        default_config = MOSConfig(**config_dict)

        neo4j_community_config = APIConfig.get_neo4j_community_config(user_id)
        neo4j_config = APIConfig.get_neo4j_config(user_id)
        nebular_config = APIConfig.get_nebular_config(user_id)
        internet_config = (
            APIConfig.get_internet_config()
            if os.getenv("ENABLE_INTERNET", "false").lower() == "true"
            else None
        )
        graph_db_backend_map = {
            "neo4j-community": neo4j_community_config,
            "neo4j": neo4j_config,
            "nebular": nebular_config,
        }
        graph_db_backend = os.getenv("NEO4J_BACKEND", "neo4j-community").lower()
        if graph_db_backend in graph_db_backend_map:
            # Create MemCube config

            default_cube_config = GeneralMemCubeConfig.model_validate(
                {
                    "user_id": user_id,
                    "cube_id": f"{user_name}_default_cube",
                    "text_mem": {
                        "backend": "tree_text",
                        "config": {
                            "extractor_llm": {"backend": "openai", "config": openai_config},
                            "dispatcher_llm": {"backend": "openai", "config": openai_config},
                            "graph_db": {
                                "backend": graph_db_backend,
                                "config": graph_db_backend_map[graph_db_backend],
                            },
                            "embedder": APIConfig.get_embedder_config(),
                            "internet_retriever": internet_config,
                            "reranker": APIConfig.get_reranker_config(),
                        },
                    },
                    "act_mem": {}
                    if os.getenv("ENABLE_ACTIVATION_MEMORY", "false").lower() == "false"
                    else APIConfig.get_activation_vllm_config(),
                    "para_mem": {},
                }
            )
        else:
            raise ValueError(f"Invalid Neo4j backend: {graph_db_backend}")
        default_mem_cube = GeneralMemCube(default_cube_config)
        return default_config, default_mem_cube

    @staticmethod
    def get_default_cube_config() -> GeneralMemCubeConfig | None:
        """Get default cube configuration for product initialization.

        Returns:
            GeneralMemCubeConfig | None: Default cube configuration if enabled, None otherwise.
        """
        if not APIConfig.is_default_cube_config_enabled():
            return None

        openai_config = APIConfig.get_openai_config()
        neo4j_community_config = APIConfig.get_neo4j_community_config(user_id="default")
        neo4j_config = APIConfig.get_neo4j_config(user_id="default")
        nebular_config = APIConfig.get_nebular_config(user_id="default")
        graph_db_backend_map = {
            "neo4j-community": neo4j_community_config,
            "neo4j": neo4j_config,
            "nebular": nebular_config,
        }
        internet_config = (
            APIConfig.get_internet_config()
            if os.getenv("ENABLE_INTERNET", "false").lower() == "true"
            else None
        )
        graph_db_backend = os.getenv("NEO4J_BACKEND", "neo4j-community").lower()
        if graph_db_backend in graph_db_backend_map:
            return GeneralMemCubeConfig.model_validate(
                {
                    "user_id": "default",
                    "cube_id": "default_cube",
                    "text_mem": {
                        "backend": "tree_text",
                        "config": {
                            "extractor_llm": {"backend": "openai", "config": openai_config},
                            "dispatcher_llm": {"backend": "openai", "config": openai_config},
                            "graph_db": {
                                "backend": graph_db_backend,
                                "config": graph_db_backend_map[graph_db_backend],
                            },
                            "embedder": APIConfig.get_embedder_config(),
                            "reranker": APIConfig.get_reranker_config(),
                            "reorganize": os.getenv("MOS_ENABLE_REORGANIZE", "false").lower()
                            == "true",
                            "internet_retriever": internet_config,
                        },
                    },
                    "act_mem": {}
                    if os.getenv("ENABLE_ACTIVATION_MEMORY", "false").lower() == "false"
                    else APIConfig.get_activation_vllm_config(),
                    "para_mem": {},
                }
            )
        else:
            raise ValueError(f"Invalid Neo4j backend: {graph_db_backend}")
