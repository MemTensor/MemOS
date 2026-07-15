from memos.configs.llm import DeepSeekLLMConfig
from memos.llms.openai import OpenAILLM
from memos.log import get_logger


logger = get_logger(__name__)


class DeepSeekLLM(OpenAILLM):
    """DeepSeek LLM via OpenAI-compatible API."""

    def __init__(self, config: DeepSeekLLMConfig):
        super().__init__(config)
