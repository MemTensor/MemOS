"""
Configuration management for the basic MemOS API.
"""

import os

from typing import Any

from memos.configs.mem_os import MOSConfig
from memos.log import get_logger
from memos.mem_os.main import MOS
from memos.mem_user.user_manager import UserManager, UserRole


logger = get_logger(__name__)

# Global MOS instance with lazy initialization
_MOS_INSTANCE = None

# Default configuration from environment variables
DEFAULT_CONFIG = {
    "user_id": os.getenv("MOS_USER_ID", "default_user"),
    "session_id": os.getenv("MOS_SESSION_ID", "default_session"),
    "enable_textual_memory": True,
    "enable_activation_memory": False,
    "top_k": int(os.getenv("MOS_TOP_K", "5")),
    "chat_model": {
        "backend": os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai"),
        "config": {
            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-3.5-turbo"),
            "api_key": os.getenv("OPENAI_API_KEY", "apikey"),
            "temperature": float(os.getenv("MOS_CHAT_TEMPERATURE", "0.7")),
            "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
        },
    },
    "mem_reader": {
        "backend": "simple_struct",
        "config": {
            "llm": {
                "backend": os.getenv("MOS_MEM_READER_LLM_PROVIDER", "openai"),
                "config": {
                    "model_name_or_path": os.getenv("MOS_MEM_READER_MODEL", "gpt-3.5-turbo"),
                    "api_key": os.getenv("OPENAI_API_KEY", "apikey"),
                    "temperature": float(os.getenv("MOS_MEM_READER_TEMPERATURE", "0.7")),
                    "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
                },
            },
            "embedder": {
                "backend": "universal_api",
                "config": {
                    "provider": os.getenv("MOS_EMBEDDER_PROVIDER", "openai"),
                    "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "text-embedding-ada-002"),
                    "api_key": os.getenv("OPENAI_API_KEY", "apikey"),
                    "base_url": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
                },
            },
            "chunker": {
                "backend": "sentence",
                "config": {
                    "tokenizer_or_token_counter": "gpt2",
                    "chunk_size": int(os.getenv("MOS_CHUNK_SIZE", "512")),
                    "chunk_overlap": int(os.getenv("MOS_CHUNK_OVERLAP", "128")),
                    "min_sentences_per_chunk": 1,
                },
            },
        },
    },
}


def get_default_config() -> dict[str, Any]:
    """Get default configuration from environment variables."""
    return DEFAULT_CONFIG.copy()


def create_user_if_not_exists(user_id: str, user_manager: UserManager) -> None:
    """Create user if it doesn't exist."""
    if not user_manager.validate_user(user_id):
        user_manager.create_user(user_name=user_id, role=UserRole.USER, user_id=user_id)
        logger.info(f"Created default user: {user_id}")


def get_mos_instance() -> MOS:
    """
    Get or create MOS instance with default user creation.

    Returns:
        MOS: The MOS instance
    """
    global _MOS_INSTANCE

    if _MOS_INSTANCE is None:
        # Create configuration
        temp_config = MOSConfig(**DEFAULT_CONFIG)

        # Create a temporary MOS instance to access user manager
        # This is a workaround for the chicken-and-egg problem:
        # MOS needs a valid user, but we need MOS to create users
        temp_mos = MOS.__new__(MOS)
        temp_mos.config = temp_config
        temp_mos.user_id = temp_config.user_id
        temp_mos.session_id = temp_config.session_id
        temp_mos.mem_cubes = {}
        temp_mos.chat_llm = None
        temp_mos.user_manager = UserManager()

        # Create default user if it doesn't exist
        create_user_if_not_exists(temp_config.user_id, temp_mos.user_manager)

        # Now create the actual MOS instance
        _MOS_INSTANCE = MOS(config=temp_config)
        logger.info(f"MOS instance created successfully for user: {temp_config.user_id}")

    return _MOS_INSTANCE


def set_mos_instance(config: MOSConfig) -> MOS:
    """
    Set a new MOS instance with the provided configuration.

    Args:
        config: The MOSConfig to use

    Returns:
        MOS: The new MOS instance
    """
    global _MOS_INSTANCE

    # Create a temporary user manager to check/create default user
    temp_user_manager = UserManager()
    create_user_if_not_exists(config.user_id, temp_user_manager)

    # Create the MOS instance
    _MOS_INSTANCE = MOS(config=config)
    logger.info(f"MOS instance updated with new configuration for user: {config.user_id}")

    return _MOS_INSTANCE


def reset_mos_instance() -> None:
    """Reset the MOS instance (useful for testing)."""
    global _MOS_INSTANCE
    _MOS_INSTANCE = None
    logger.info("MOS instance reset")
