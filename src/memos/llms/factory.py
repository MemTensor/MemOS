from typing import Any, ClassVar

from memos.configs.llm import LLMConfigFactory
from memos.llms.base import BaseLLM
from memos.llms.deepseek import DeepSeekLLM
from memos.llms.hf import HFLLM
from memos.llms.hf_singleton import HFSingletonLLM
from memos.llms.ollama import OllamaLLM
from memos.llms.openai import AzureLLM, OpenAILLM
from memos.llms.openai_new import OpenAIResponsesLLM
from memos.llms.qwen import QwenLLM
from memos.llms.vllm import VLLMLLM
from memos.memos_tools.singleton import singleton_factory


class LLMFactory(BaseLLM):
    """Factory class for creating LLM instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "openai": OpenAILLM,
        "azure": AzureLLM,
        "ollama": OllamaLLM,
        "huggingface": HFLLM,
        "huggingface_singleton": HFSingletonLLM,  # Add singleton version
        "vllm": VLLMLLM,
        "qwen": QwenLLM,
        "deepseek": DeepSeekLLM,
        "openai_new": OpenAIResponsesLLM,
    }

    @classmethod
    @singleton_factory()
    def from_config(cls, config_factory: LLMConfigFactory) -> BaseLLM:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        llm_class = cls.backend_to_class[backend]
        return llm_class(config_factory.config)
