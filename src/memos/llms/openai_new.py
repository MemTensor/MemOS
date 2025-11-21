import json

from collections.abc import Generator

import openai

from openai._types import NOT_GIVEN
from openai.types.responses.response_function_tool_call import ResponseFunctionToolCall
from openai.types.responses.response_reasoning_item import ResponseReasoningItem

from memos.configs.llm import AzureLLMConfig, OpenAILLMConfig
from memos.llms.base import BaseLLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList
from memos.utils import timed


logger = get_logger(__name__)


class OpenAIResponsesLLM(BaseLLM):
    def __init__(self, config: OpenAILLMConfig):
        self.config = config
        self.client = openai.Client(
            api_key=config.api_key, base_url=config.api_base, default_headers=config.default_headers
        )

    @timed(log=True, log_prefix="OpenAI Responses LLM")
    def generate(self, messages: MessageList, **kwargs) -> str:
        response = self.client.responses.create(
            model=kwargs.get("model_name_or_path", self.config.model_name_or_path),
            input=messages,
            temperature=kwargs.get("temperature", self.config.temperature),
            top_p=kwargs.get("top_p", self.config.top_p),
            max_output_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            reasoning={"effort": "low", "summary": "auto"}
            if self.config.enable_thinking
            else NOT_GIVEN,
            tools=kwargs.get("tools", NOT_GIVEN),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
        )
        tool_call_outputs = [
            item for item in response.output if isinstance(item, ResponseFunctionToolCall)
        ]
        if tool_call_outputs:
            return self.tool_call_parser(tool_call_outputs)

        output_text = getattr(response, "output_text", "")
        output_reasoning = [
            item for item in response.output if isinstance(item, ResponseReasoningItem)
        ]
        summary = output_reasoning[0].summary

        if self.config.remove_think_prefix:
            return remove_thinking_tags(output_text)
        if summary:
            return f"<think>{summary[0].text}</think>" + output_text
        return output_text

    @timed(log=True, log_prefix="OpenAI Responses LLM")
    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        stream = self.client.responses.create(
            model=kwargs.get("model_name_or_path", self.config.model_name_or_path),
            input=messages,
            temperature=kwargs.get("temperature", self.config.temperature),
            top_p=kwargs.get("top_p", self.config.top_p),
            max_output_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            reasoning={"effort": "low", "summary": "auto"}
            if self.config.enable_thinking
            else NOT_GIVEN,
            extra_body=kwargs.get("extra_body", self.config.extra_body),
            stream=True,
        )

        reasoning_started = False

        for event in stream:
            event_type = getattr(event, "type", "")
            if event_type in (
                "response.reasoning.delta",
                "response.reasoning_summary_text.delta",
            ) and hasattr(event, "delta"):
                if not self.config.remove_think_prefix:
                    if not reasoning_started:
                        yield "<think>"
                        reasoning_started = True
                    yield event.delta
            elif event_type == "response.output_text.delta" and hasattr(event, "delta"):
                if reasoning_started and not self.config.remove_think_prefix:
                    yield "</think>"
                    reasoning_started = False
                yield event.delta

        if reasoning_started and not self.config.remove_think_prefix:
            yield "</think>"

    def tool_call_parser(self, tool_calls: list[ResponseFunctionToolCall]) -> list[dict]:
        """Parse tool calls from OpenAI response."""
        return [
            {
                "tool_call_id": tool_call.call_id,
                "function_name": tool_call.name,
                "arguments": json.loads(tool_call.arguments),
            }
            for tool_call in tool_calls
        ]


class AzureResponsesLLM(BaseLLM):
    def __init__(self, config: AzureLLMConfig):
        self.config = config
        self.client = openai.AzureOpenAI(
            azure_endpoint=config.base_url,
            api_version=config.api_version,
            api_key=config.api_key,
        )

    def generate(self, messages: MessageList, **kwargs) -> str:
        response = self.client.responses.create(
            model=self.config.model_name_or_path,
            input=messages,
            temperature=kwargs.get("temperature", self.config.temperature),
            top_p=kwargs.get("top_p", self.config.top_p),
            max_output_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            tools=kwargs.get("tools", NOT_GIVEN),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
            reasoning={"effort": "low", "summary": "auto"}
            if self.config.enable_thinking
            else NOT_GIVEN,
        )

        output_text = getattr(response, "output_text", "")
        output_reasoning = [
            item for item in response.output if isinstance(item, ResponseReasoningItem)
        ]
        summary = output_reasoning[0].summary

        if self.config.remove_think_prefix:
            return remove_thinking_tags(output_text)
        if summary:
            return f"<think>{summary[0].text}</think>" + output_text
        return output_text

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        if kwargs.get("tools"):
            logger.info("stream api not support tools")
            return

        stream = self.client.responses.create(
            model=self.config.model_name_or_path,
            input=messages,
            temperature=kwargs.get("temperature", self.config.temperature),
            top_p=kwargs.get("top_p", self.config.top_p),
            max_output_tokens=kwargs.get("max_tokens", self.config.max_tokens),
            extra_body=kwargs.get("extra_body", self.config.extra_body),
            stream=True,
            reasoning={"effort": "low", "summary": "auto"}
            if self.config.enable_thinking
            else NOT_GIVEN,
        )

        reasoning_started = False

        for event in stream:
            event_type = getattr(event, "type", "")
            if event_type in (
                "response.reasoning.delta",
                "response.reasoning_summary_text.delta",
            ) and hasattr(event, "delta"):
                if not self.config.remove_think_prefix:
                    if not reasoning_started:
                        yield "<think>"
                        reasoning_started = True
                    yield event.delta
            elif event_type == "response.output_text.delta" and hasattr(event, "delta"):
                if reasoning_started and not self.config.remove_think_prefix:
                    yield "</think>"
                    reasoning_started = False
                yield event.delta

        if reasoning_started and not self.config.remove_think_prefix:
            yield "</think>"

    def tool_call_parser(self, tool_calls: list[ResponseFunctionToolCall]) -> list[dict]:
        """Parse tool calls from OpenAI response."""
        return [
            {
                "tool_call_id": tool_call.call_id,
                "function_name": tool_call.name,
                "arguments": json.loads(tool_call.arguments),
            }
            for tool_call in tool_calls
        ]
