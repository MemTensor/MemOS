import json

from typing import Any, cast

import openai

from openai.types.chat.chat_completion_message_tool_call import ChatCompletionMessageToolCall

from memos.configs.llm import VLLMLLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageDict


logger = get_logger(__name__)


class VLLMLLM(BaseLLM):
    """
    VLLM LLM class for connecting to existing vLLM servers.
    """

    def __init__(self, config: VLLMLLMConfig):
        """
        Initialize the VLLM LLM to connect to an existing vLLM server.
        """
        self.config = config

        # Initialize OpenAI client for API calls
        self.client = None
        api_key = getattr(self.config, "api_key", "dummy")
        if not api_key:
            api_key = "dummy"

        self.client = openai.Client(
            api_key=api_key,
            base_url=getattr(self.config, "api_base", "http://localhost:8088/v1"),
            default_headers=self.config.default_headers,
        )

    def build_vllm_kv_cache(self, messages: Any) -> str:
        """
        Build a KV cache from chat messages via one vLLM request.
        Handles str, list[str], and MessageList formats.
        """
        # 1. Normalize input to a MessageList
        processed_messages: list[MessageDict] = []
        if isinstance(messages, str):
            processed_messages = [
                {
                    "role": "system",
                    "content": f"Below is some information about the user.\n{messages}",
                }
            ]
        elif isinstance(messages, list):
            if not messages:
                pass  # Empty list
            elif isinstance(messages[0], str):
                str_content = " ".join(str(msg) for msg in messages)
                processed_messages = [
                    {
                        "role": "system",
                        "content": f"Below is some information about the user.\n{str_content}",
                    }
                ]
            elif isinstance(messages[0], dict):
                processed_messages = cast("list[MessageDict]", messages)

        # 2. Convert to prompt for logging/return value.
        prompt = self._messages_to_prompt(processed_messages)

        if not prompt.strip():
            raise ValueError("Prompt is empty, cannot build KV cache.")

        # 3. Send request to vLLM server to preload the KV cache
        if self.client:
            try:
                # Use the processed messages for the API call
                prefill_kwargs = {
                    "model": self.config.model_name_or_path,
                    "messages": processed_messages,
                    "max_tokens": 2,
                    "temperature": 0.0,
                    "top_p": 1.0,
                }
                self.client.chat.completions.create(**prefill_kwargs)
                logger.info(f"vLLM KV cache prefill completed for prompt: '{prompt[:100]}...'")
            except Exception as e:
                logger.warning(f"Failed to prefill vLLM KV cache: {e}")

        return prompt

    def generate(self, messages: list[MessageDict], **kwargs) -> str:
        """
        Generate a response from the model.
        """
        if self.client:
            return self._generate_with_api_client(messages, **kwargs)
        else:
            raise RuntimeError("API client is not available")

    def _generate_with_api_client(self, messages: list[MessageDict], **kwargs) -> str:
        """
        Generate response using vLLM API client. detail view https://docs.vllm.ai/en/latest/features/reasoning_outputs/
        """
        if self.client:
            completion_kwargs = {
                "model": kwargs.get("model_name_or_path", self.config.model_name_or_path),
                "messages": messages,
                "temperature": kwargs.get("temperature", self.config.temperature),
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "top_p": kwargs.get("top_p", self.config.top_p),
                "extra_body": {
                    "chat_template_kwargs": {
                        "enable_thinking": kwargs.get(
                            "enable_thinking", self.config.enable_thinking
                        )
                    }
                },
            }
            if kwargs.get("tools"):
                completion_kwargs["tools"] = kwargs.get("tools")
                completion_kwargs["tool_choice"] = kwargs.get("tool_choice", "auto")

            response = self.client.chat.completions.create(**completion_kwargs)

            if response.choices[0].message.tool_calls:
                return self.tool_call_parser(response.choices[0].message.tool_calls)

            reasoning_content = (
                f"<think>{response.choices[0].message.reasoning}</think>"
                if hasattr(response.choices[0].message, "reasoning")
                else ""
            )
            response_text = response.choices[0].message.content or ""
            logger.info(f"VLLM API response: {response_text}")
            return (
                remove_thinking_tags(response_text)
                if getattr(self.config, "remove_think_prefix", False)
                else reasoning_content + response_text
            )
        else:
            raise RuntimeError("API client is not available")

    def _messages_to_prompt(self, messages: list[MessageDict]) -> str:
        """
        Convert messages to prompt string.
        """
        prompt_parts = []
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            prompt_parts.append(f"{role.capitalize()}: {content}")
        return "\n".join(prompt_parts)

    def generate_stream(self, messages: list[MessageDict], **kwargs):
        """
        Generate a response from the model using streaming.
        Yields content chunks as they are received.
        """
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        if self.client:
            completion_kwargs = {
                "model": self.config.model_name_or_path,
                "messages": messages,
                "temperature": kwargs.get("temperature", self.config.temperature),
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "top_p": kwargs.get("top_p", self.config.top_p),
                "stream": True,
                "extra_body": {
                    "chat_template_kwargs": {
                        "enable_thinking": kwargs.get(
                            "enable_thinking", self.config.enable_thinking
                        )
                    }
                },
            }

            stream = self.client.chat.completions.create(**completion_kwargs)

            reasoning_started = False
            for chunk in stream:
                delta = chunk.choices[0].delta
                if hasattr(delta, "reasoning") and delta.reasoning:
                    if not reasoning_started and not self.config.remove_think_prefix:
                        yield "<think>"
                        reasoning_started = True
                    yield delta.reasoning

            if hasattr(delta, "content") and delta.content:
                if reasoning_started and not self.config.remove_think_prefix:
                    yield "</think>"
                    reasoning_started = False
                yield delta.content

        else:
            raise RuntimeError("API client is not available")

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
