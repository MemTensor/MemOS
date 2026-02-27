import json

from collections.abc import Generator
from typing import Any

from memos.configs.llm import LazyLLMOnlineChatConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList


logger = get_logger(__name__)


class LazyLLMOnlineChatLLM(BaseLLM):
    """LazyLLM OnlineChat backend."""

    def __init__(self, config: LazyLLMOnlineChatConfig):
        self.config = config
        try:
            import lazyllm
        except ImportError as exc:
            raise ImportError(
                "LazyLLM backend requires `lazyllm`. "
                "Install with: pip install 'git+https://github.com/LazyAGI/LazyLLM.git@main'"
            ) from exc

        module_kwargs: dict[str, Any] = {
            "source": config.source,
            "model": config.model_name_or_path,
            "stream": config.stream,
            "skip_auth": config.skip_auth,
        }
        if config.api_base:
            module_kwargs["base_url"] = config.api_base
        if config.api_key:
            module_kwargs["api_key"] = config.api_key
        if config.type:
            module_kwargs["type"] = config.type
        if config.extra_kwargs:
            module_kwargs.update(config.extra_kwargs)

        self.client = lazyllm.OnlineChatModule(**module_kwargs)
        logger.info("LazyLLM OnlineChat LLM instance initialized")

    def _normalize_messages(self, messages: MessageList | str) -> MessageList:
        if isinstance(messages, str):
            return [{"role": "user", "content": messages}]
        return messages

    def generate(self, messages: MessageList | str, **kwargs) -> str | list[dict]:
        normalized_messages = self._normalize_messages(messages)
        runtime_model = kwargs.get("model_name_or_path", self.config.model_name_or_path)

        request_kwargs: dict[str, Any] = {
            "messages": normalized_messages,
            "stream_output": False,
            "model_name": runtime_model,
            "temperature": kwargs.get("temperature", self.config.temperature),
            "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
            "top_p": kwargs.get("top_p", self.config.top_p),
            "top_k": kwargs.get("top_k", self.config.top_k),
        }
        if kwargs.get("tools"):
            request_kwargs["tools"] = kwargs["tools"]

        response = self.client("", **request_kwargs)
        if isinstance(response, dict):
            tool_calls = response.get("tool_calls")
            if isinstance(tool_calls, list) and len(tool_calls) > 0:
                return self.tool_call_parser(tool_calls)
            response_content = response.get("content", "")
            reasoning_content = response.get("reasoning_content")
            if isinstance(reasoning_content, str) and reasoning_content:
                reasoning_content = f"<think>{reasoning_content}</think>"
            if self.config.remove_think_prefix:
                return remove_thinking_tags(response_content)
            if reasoning_content:
                return reasoning_content + (response_content or "")
            return response_content or ""
        if isinstance(response, str):
            return remove_thinking_tags(response) if self.config.remove_think_prefix else response
        return str(response)

    def generate_stream(self, messages: MessageList | str, **kwargs) -> Generator[str, None, None]:
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        response = self.generate(messages, **kwargs)
        if isinstance(response, str):
            yield response
            return
        yield json.dumps(response, ensure_ascii=False)

    def tool_call_parser(self, tool_calls: list[dict]) -> list[dict]:
        parsed_calls = []
        for tool_call in tool_calls:
            function_data = tool_call.get("function", {})
            arguments = function_data.get("arguments", {})
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    pass
            parsed_calls.append(
                {
                    "tool_call_id": tool_call.get("id", ""),
                    "function_name": function_data.get("name", ""),
                    "arguments": arguments,
                }
            )
        return parsed_calls
