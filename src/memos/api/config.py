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
            "model_name_or_path": os.getenv("MOS_OPENAI_MODEL", "gpt-4o-mini"),
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
    def get_neo4j_config() -> dict[str, Any]:
        """Get Neo4j configuration."""
        return {
            "uri": os.getenv("NEO4J_URI", "bolt://localhost:7687"),
            "user": os.getenv("NEO4J_USER", "neo4j"),
            "password": os.getenv("NEO4J_PASSWORD", "12345678"),
            "auto_create": True,
        }

    @staticmethod
    def get_scheduler_config() -> dict[str, Any]:
        """Get scheduler configuration."""
        return {
            "backend": "general_scheduler",
            "config": {
                "top_k": int(os.getenv("MOS_SCHEDULER_TOP_K", "10")),
                "top_n": int(os.getenv("MOS_SCHEDULER_TOP_N", "5")),
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
            },
        }

    @staticmethod
    def is_scheduler_enabled() -> bool:
        """Check if scheduler is enabled via environment variable."""
        return os.getenv("MOS_ENABLE_SCHEDULER", "false").lower() == "true"

    @staticmethod
    def get_product_default_config() -> dict[str, Any]:
        """Get default configuration for Product API."""
        openai_config = APIConfig.get_openai_config()
        qwen_config = APIConfig.qwen_config()
        config = {
            "user_id": os.getenv("MOS_USER_ID", "root"),
            "chat_model": {
                "backend": os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai"),
                "config": openai_config
                if os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai") == "openai"
                else qwen_config,
            },
            "mem_reader": {
                "backend": "simple_struct",
                "config": {
                    "llm": {
                        "backend": "openai",
                        "config": openai_config,
                    },
                    "embedder": {
                        "backend": "ollama",
                        "config": {
                            "model_name_or_path": "nomic-embed-text:latest",
                            "api_base": os.getenv("OLLAMA_API_BASE", "http://localhost:11434"),
                        },
                    },
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
        neo4j_config = APIConfig.get_neo4j_config()
        qwen_config = APIConfig.qwen_config()
        # Create MOSConfig
        config_dict = {
            "user_id": user_id,
            "chat_model": {
                "backend": os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai"),
                "config": openai_config
                if os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai") == "openai"
                else qwen_config,
            },
            "mem_reader": {
                "backend": "simple_struct",
                "config": {
                    "llm": {
                        "backend": "openai",
                        "config": openai_config,
                    },
                    "embedder": {
                        "backend": "ollama",
                        "config": {
                            "model_name_or_path": "nomic-embed-text:latest",
                            "api_base": os.getenv("OLLAMA_API_BASE", "http://localhost:11434"),
                        },
                    },
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

        default_config = MOSConfig(**config_dict)

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
                            "backend": "neo4j",
                            "config": {
                                "uri": neo4j_config["uri"],
                                "user": neo4j_config["user"],
                                "password": neo4j_config["password"],
                                "db_name": os.getenv(
                                    "NEO4J_DB_NAME", f"memos{user_id.replace('-', '')}"
                                ),  # , replace with
                                "auto_create": neo4j_config["auto_create"],
                            },
                        },
                        "embedder": {
                            "backend": "ollama",
                            "config": {
                                "model_name_or_path": "nomic-embed-text:latest",
                                "api_base": os.getenv("OLLAMA_API_BASE", "http://localhost:11434"),
                            },
                        },
                    },
                },
                "act_mem": {}
                if os.getenv("ENABLE_ACTIVATION_MEMORY", "false").lower() == "false"
                else APIConfig.get_activation_config(),
                "para_mem": {},
            }
        )

        default_mem_cube = GeneralMemCube(default_cube_config)
        return default_config, default_mem_cube
