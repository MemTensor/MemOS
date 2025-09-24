from collections.abc import Generator

from memos.configs.llm import QwenLLMConfig
from memos.llms.openai import OpenAILLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList
from memos.utils import timed


logger = get_logger(__name__)


class QwenLLM(OpenAILLM):
    """Qwen (DashScope) LLM class via OpenAI-compatible API."""

    def __init__(self, config: QwenLLMConfig):
        super().__init__(config)

    @timed
    def generate(self, messages: MessageList) -> str:
        """Generate a response from Qwen LLM."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            extra_body=self.config.extra_body,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            top_p=self.config.top_p,
        )
        logger.info(f"Response from Qwen: {response.model_dump_json()}")
        response_content = response.choices[0].message.content
        if self.config.remove_think_prefix:
            return remove_thinking_tags(response_content)
        else:
            return response_content

    @timed
    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """Stream response from Qwen LLM."""
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

            # Some models may have separate `reasoning_content` vs `content`
            # For Qwen (DashScope), likely only `content` is used
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
