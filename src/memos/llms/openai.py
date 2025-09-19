import hashlib
import json

from collections.abc import Generator
from typing import ClassVar

import openai

from memos.configs.llm import AzureLLMConfig, OpenAILLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList


logger = get_logger(__name__)


class OpenAILLM(BaseLLM):
    """OpenAI LLM class with singleton pattern."""

    _instances: ClassVar[dict] = {}  # Class variable to store instances

    def __new__(cls, config: OpenAILLMConfig) -> "OpenAILLM":
        config_hash = cls._get_config_hash(config)

        if config_hash not in cls._instances:
            logger.info(f"Creating new OpenAI LLM instance for config hash: {config_hash}")
            instance = super().__new__(cls)
            cls._instances[config_hash] = instance
        else:
            logger.info(f"Reusing existing OpenAI LLM instance for config hash: {config_hash}")

        return cls._instances[config_hash]

    def __init__(self, config: OpenAILLMConfig):
        # Avoid duplicate initialization
        if hasattr(self, "_initialized"):
            return

        self.config = config
        self.client = openai.Client(api_key=config.api_key, base_url=config.api_base)
        self._initialized = True
        logger.info("OpenAI LLM instance initialized")

    @classmethod
    def _get_config_hash(cls, config: OpenAILLMConfig) -> str:
        """Generate hash value of configuration"""
        config_dict = config.model_dump()
        config_str = json.dumps(config_dict, sort_keys=True)
        return hashlib.md5(config_str.encode()).hexdigest()

    @classmethod
    def clear_cache(cls):
        """Clear all cached instances"""
        cls._instances.clear()
        logger.info("OpenAI LLM instance cache cleared")

    def generate(self, messages: MessageList) -> str:
        """Generate a response from OpenAI LLM."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            extra_body=self.config.extra_body,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            top_p=self.config.top_p,
        )
        logger.info(f"Response from OpenAI: {response.model_dump_json()}")
        response_content = response.choices[0].message.content
        if self.config.remove_think_prefix:
            return remove_thinking_tags(response_content)
        else:
            return response_content

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """Stream response from OpenAI LLM with optional reasoning support."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            stream=True,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            top_p=self.config.top_p,
            extra_body=self.config.extra_body,
        )

        reasoning_started = False

        for chunk in response:
            delta = chunk.choices[0].delta

            # Support for custom 'reasoning_content' (if present in OpenAI-compatible models like Qwen)
            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                if not reasoning_started and not self.config.remove_think_prefix:
                    yield "<think>"
                    reasoning_started = True
                yield delta.reasoning_content
            elif hasattr(delta, "content") and delta.content:
                if reasoning_started and not self.config.remove_think_prefix:
                    yield "</think>"
                    reasoning_started = False
                yield delta.content

        # Ensure we close the <think> block if not already done
        if reasoning_started and not self.config.remove_think_prefix:
            yield "</think>"


class AzureLLM(BaseLLM):
    """Azure OpenAI LLM class with singleton pattern."""

    _instances: ClassVar[dict] = {}  # Class variable to store instances

    def __new__(cls, config: AzureLLMConfig):
        # Generate hash value of config as cache key
        config_hash = cls._get_config_hash(config)

        if config_hash not in cls._instances:
            logger.info(f"Creating new Azure LLM instance for config hash: {config_hash}")
            instance = super().__new__(cls)
            cls._instances[config_hash] = instance
        else:
            logger.info(f"Reusing existing Azure LLM instance for config hash: {config_hash}")

        return cls._instances[config_hash]

    def __init__(self, config: AzureLLMConfig):
        # Avoid duplicate initialization
        if hasattr(self, "_initialized"):
            return

        self.config = config
        self.client = openai.AzureOpenAI(
            azure_endpoint=config.base_url,
            api_version=config.api_version,
            api_key=config.api_key,
        )
        self._initialized = True
        logger.info("Azure LLM instance initialized")

    @classmethod
    def _get_config_hash(cls, config: AzureLLMConfig) -> str:
        """Generate hash value of configuration"""
        # Convert config to dict and sort to ensure consistency
        config_dict = config.model_dump()
        config_str = json.dumps(config_dict, sort_keys=True)
        return hashlib.md5(config_str.encode()).hexdigest()

    @classmethod
    def clear_cache(cls):
        """Clear all cached instances"""
        cls._instances.clear()
        logger.info("Azure LLM instance cache cleared")

    def generate(self, messages: MessageList) -> str:
        """Generate a response from Azure OpenAI LLM."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            top_p=self.config.top_p,
        )
        logger.info(f"Response from Azure OpenAI: {response.model_dump_json()}")
        response_content = response.choices[0].message.content
        if self.config.remove_think_prefix:
            return remove_thinking_tags(response_content)
        else:
            return response_content

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        raise NotImplementedError
