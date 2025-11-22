from collections.abc import Generator
from typing import Any

from ollama import Client, Message

from memos.configs.llm import OllamaLLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList


logger = get_logger(__name__)


class OllamaLLM(BaseLLM):
    """Ollama LLM class."""

    def __init__(self, config: OllamaLLMConfig):
        self.config = config
        self.api_base = config.api_base

        # Default model if not specified
        if not self.config.model_name_or_path:
            self.config.model_name_or_path = "llama3.1:latest"

        # Initialize ollama client
        self.client = Client(host=self.api_base)

        # Ensure the model exists locally
        self._ensure_model_exists()

    def _list_models(self) -> list[str]:
        """
        List all models available in the Ollama client.

        Returns:
            List of model names.
        """
        local_models = self.client.list()["models"]
        return [model.model for model in local_models]

    def _ensure_model_exists(self):
        """
        Ensure the specified model exists locally. If not, pull it from Ollama.
        """
        try:
            local_models = self._list_models()
            if self.config.model_name_or_path not in local_models:
                logger.warning(
                    f"Model {self.config.model_name_or_path} not found locally. Pulling from Ollama..."
                )
                self.client.pull(self.config.model_name_or_path)
        except Exception as e:
            logger.warning(f"Could not verify model existence: {e}")

    def generate(self, messages: MessageList, **kwargs) -> Any:
        """
        Generate a response from Ollama LLM.

        Args:
            messages: List of message dicts containing 'role' and 'content'.

        Returns:
            str: The generated response.
        """
        response = self.client.chat(
            model=self.config.model_name_or_path,
            messages=messages,
            options={
                "temperature": kwargs.get("temperature", self.config.temperature),
                "num_predict": kwargs.get("max_tokens", self.config.max_tokens),
                "top_p": kwargs.get("top_p", self.config.top_p),
                "top_k": kwargs.get("top_k", self.config.top_k),
            },
            think=self.config.enable_thinking,
            tools=kwargs.get("tools"),
        )
        logger.info(f"Raw response from Ollama: {response.model_dump_json()}")
        tool_calls = getattr(response.message, "tool_calls", None)
        if isinstance(tool_calls, list) and len(tool_calls) > 0:
            return self.tool_call_parser(tool_calls)

        str_thinking = (
            f"<think>{response.message.thinking}</think>"
            if hasattr(response.message, "thinking")
            else ""
        )
        str_response = response.message.content
        if self.config.remove_think_prefix:
            return remove_thinking_tags(str_response)
        else:
            return str_thinking + str_response

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        response = self.client.chat(
            model=kwargs.get("model_name_or_path", self.config.model_name_or_path),
            messages=messages,
            options={
                "temperature": kwargs.get("temperature", self.config.temperature),
                "num_predict": kwargs.get("max_tokens", self.config.max_tokens),
                "top_p": kwargs.get("top_p", self.config.top_p),
                "top_k": kwargs.get("top_k", self.config.top_k),
            },
            think=self.config.enable_thinking,
            stream=True,
        )
        # Streaming chunks of text
        reasoning_started = False
        for chunk in response:
            if hasattr(chunk.message, "thinking") and chunk.message.thinking:
                if not reasoning_started and not self.config.remove_think_prefix:
                    yield "<think>"
                    reasoning_started = True
                yield chunk.message.thinking

            if hasattr(chunk.message, "content") and chunk.message.content:
                if reasoning_started and not self.config.remove_think_prefix:
                    yield "</think>"
                    reasoning_started = False
                yield chunk.message.content

    def tool_call_parser(self, tool_calls: list[Message.ToolCall]) -> list[dict]:
        """Parse tool calls from OpenAI response."""
        return [
            {
                "function_name": tool_call.function.name,
                "arguments": tool_call.function.arguments,
            }
            for tool_call in tool_calls
        ]
