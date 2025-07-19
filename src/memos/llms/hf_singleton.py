import threading

from typing import ClassVar

from memos.configs.llm import HFLLMConfig
from memos.llms.hf import HFLLM
from memos.log import get_logger


logger = get_logger(__name__)


class HFSingletonLLM(HFLLM):
    """
    Singleton version of HFLLM that prevents multiple loading of the same model.
    This class inherits from HFLLM and adds singleton behavior.
    """

    _instances: ClassVar[dict[str, "HFSingletonLLM"]] = {}
    _lock: ClassVar[threading.Lock] = threading.Lock()

    def __new__(cls, config: HFLLMConfig):
        """
        Singleton pattern implementation.
        Returns existing instance if config already exists, otherwise creates new one.
        """
        config_key = cls._get_config_key(config)

        if config_key in cls._instances:
            logger.debug(f"Reusing existing HF model: {config.model_name_or_path}")
            return cls._instances[config_key]

        with cls._lock:
            # Double-check pattern to prevent race conditions
            if config_key in cls._instances:
                logger.debug(f"Reusing existing HF model: {config.model_name_or_path}")
                return cls._instances[config_key]

            logger.info(f"Creating new HF model: {config.model_name_or_path}")
            instance = super().__new__(cls)
            cls._instances[config_key] = instance
            return instance

    def __init__(self, config: HFLLMConfig):
        """
        Initialize the singleton HFLLM instance.
        Only initializes if this is a new instance.
        """
        # Check if already initialized
        if hasattr(self, "_initialized"):
            return

        # Call parent constructor
        super().__init__(config)
        self._initialized = True

    @classmethod
    def _get_config_key(cls, config: HFLLMConfig) -> str:
        """
        Generate a unique key for the HF model configuration.

        Args:
            config: The HFLLM configuration

        Returns:
            A unique string key representing the configuration
        """
        # Create a unique key based on model path and key parameters
        key_parts = [config.model_name_or_path]
        return "|".join(key_parts)

    @classmethod
    def get_instance_count(cls) -> int:
        """
        Get the number of unique HF model instances currently managed.

        Returns:
            Number of HF model instances
        """
        return len(cls._instances)

    @classmethod
    def get_instance_info(cls) -> dict[str, str]:
        """
        Get information about all managed HF model instances.

        Returns:
            Dictionary mapping config keys to model paths
        """
        return {key: instance.config.model_name_or_path for key, instance in cls._instances.items()}

    @classmethod
    def clear_all(cls) -> None:
        """
        Clear all HF model instances from memory.
        This should be used carefully as it will force reloading of models.
        """
        with cls._lock:
            cls._instances.clear()
            logger.info("All HF model instances cleared from singleton manager")


# Convenience function to get singleton manager info
def get_hf_singleton_info() -> dict[str, int]:
    """
    Get information about the HF singleton manager.

    Returns:
        Dictionary with instance count and info
    """
    return {
        "instance_count": HFSingletonLLM.get_instance_count(),
        "instance_info": HFSingletonLLM.get_instance_info(),
    }
