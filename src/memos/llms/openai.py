import json

from collections.abc import Generator

import openai

from openai._types import NOT_GIVEN
from openai.types.chat.chat_completion_message_tool_call import ChatCompletionMessageToolCall

from memos.configs.llm import AzureLLMConfig, OpenAILLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList
from memos.utils import timed_with_status


logger = get_logger(__name__)


class OpenAILLM(BaseLLM):
    """OpenAI LLM class via openai.chat.completions.create."""

    def __init__(self, config: OpenAILLMConfig):
        self.config = config
        self.client = openai.Client(
            api_key=config.api_key, base_url=config.api_base, default_headers=config.default_headers
        )
        logger.info("OpenAI LLM instance initialized")

    @timed_with_status(
        log_prefix="OpenAI LLM",
        log_extra_args=lambda self, messages, **kwargs: {
            "model_name_or_path": kwargs.get("model_name_or_path", self.config.model_name_or_path)
        },
    )
    def generate(self, messages: MessageList, **kwargs) -> str:
        """Generate a response from OpenAI LLM, optionally overriding generation params."""
        response = self.client.chat.completions.create(
            model=kwargs.get("model_name_or_path", self.config.model_name_or_path),
            messages=messages,
            temperature=kwargs.get("temperature", self.config.temperature),
            max_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            top_p=kwargs.get("top_p", self.config.top_p),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
            tools=kwargs.get("tools", NOT_GIVEN),
            timeout=kwargs.get("timeout", 30),
        )
        logger.info(f"Response from OpenAI: {response.model_dump_json()}")
        tool_calls = getattr(response.choices[0].message, "tool_calls", None)
        if isinstance(tool_calls, list) and len(tool_calls) > 0:
            return self.tool_call_parser(tool_calls)
        response_content = response.choices[0].message.content
        reasoning_content = getattr(response.choices[0].message, "reasoning_content", None)
        if isinstance(reasoning_content, str) and reasoning_content:
            reasoning_content = f"<think>{reasoning_content}</think>"
        if self.config.remove_think_prefix:
            return remove_thinking_tags(response_content)
        if reasoning_content:
            return reasoning_content + response_content
        return response_content

    @timed_with_status(
        log_prefix="OpenAI LLM",
        log_extra_args=lambda self, messages, **kwargs: {
            "model_name_or_path": self.config.model_name_or_path
        },
    )
    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """Stream response from OpenAI LLM with optional reasoning support."""
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            stream=True,
            temperature=kwargs.get("temperature", self.config.temperature),
            max_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            top_p=kwargs.get("top_p", self.config.top_p),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
            tools=kwargs.get("tools", NOT_GIVEN),
        )

        reasoning_started = False

        for chunk in response:
            delta = chunk.choices[0].delta

            # Support for custom 'reasoning_content' (if present in OpenAI-compatible models like Qwen, DeepSeek)
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

    def tool_call_parser(self, tool_calls: list[ChatCompletionMessageToolCall]) -> list[dict]:
        """Parse tool calls from OpenAI response."""
        return [
            {
                "tool_call_id": tool_call.id,
                "function_name": tool_call.function.name,
                "arguments": json.loads(tool_call.function.arguments),
            }
            for tool_call in tool_calls
        ]


class AzureLLM(BaseLLM):
    """Azure OpenAI LLM class with singleton pattern."""

    def __init__(self, config: AzureLLMConfig):
        self.config = config
        self.client = openai.AzureOpenAI(
            azure_endpoint=config.base_url,
            api_version=config.api_version,
            api_key=config.api_key,
        )
        logger.info("Azure LLM instance initialized")

    def generate(self, messages: MessageList, **kwargs) -> str:
        """Generate a response from Azure OpenAI LLM."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            temperature=kwargs.get("temperature", self.config.temperature),
            max_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            top_p=kwargs.get("top_p", self.config.top_p),
            tools=kwargs.get("tools", NOT_GIVEN),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
        )
        logger.info(f"Response from Azure OpenAI: {response.model_dump_json()}")
        if response.choices[0].message.tool_calls:
            return self.tool_call_parser(response.choices[0].message.tool_calls)
        response_content = response.choices[0].message.content
        if self.config.remove_think_prefix:
            return remove_thinking_tags(response_content)
        else:
            return response_content

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """Stream response from Azure OpenAI LLM with optional reasoning support."""
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            stream=True,
            temperature=kwargs.get("temperature", self.config.temperature),
            max_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            top_p=kwargs.get("top_p", self.config.top_p),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
        )

        reasoning_started = False

        for chunk in response:
            delta = chunk.choices[0].delta

            # Support for custom 'reasoning_content' (if present in OpenAI-compatible models like Qwen, DeepSeek)
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

    def tool_call_parser(self, tool_calls: list[ChatCompletionMessageToolCall]) -> list[dict]:
        """Parse tool calls from OpenAI response."""
        return [
            {
                "tool_call_id": tool_call.id,
                "function_name": tool_call.function.name,
                "arguments": json.loads(tool_call.function.arguments),
            }
            for tool_call in tool_calls
        ]
