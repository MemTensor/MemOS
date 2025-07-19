from collections.abc import Generator

from memos.configs.llm import DeepSeekLLMConfig
from memos.llms.openai import OpenAILLM
from memos.llms.utils import remove_thinking_tags
from memos.log import get_logger
from memos.types import MessageList


logger = get_logger(__name__)


class DeepSeekLLM(OpenAILLM):
    """DeepSeek LLM via OpenAI-compatible API."""

    def __init__(self, config: DeepSeekLLMConfig):
        super().__init__(config)

    def generate(self, messages: MessageList) -> str:
        """Generate a response from DeepSeek."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            top_p=self.config.top_p,
            extra_body=self.config.extra_body,
        )
        logger.info(f"Response from DeepSeek: {response.model_dump_json()}")
        response_content = response.choices[0].message.content
        if self.config.remove_think_prefix:
            return remove_thinking_tags(response_content)
        else:
            return response_content

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """Stream response from DeepSeek."""
        response = self.client.chat.completions.create(
            model=self.config.model_name_or_path,
            messages=messages,
            stream=True,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            top_p=self.config.top_p,
            extra_body=self.config.extra_body,
        )
        # Streaming chunks of text
        for chunk in response:
            delta = chunk.choices[0].delta
            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                yield delta.reasoning_content

            if hasattr(delta, "content") and delta.content:
                yield delta.content
