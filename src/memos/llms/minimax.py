from memos.configs.llm import MinimaxLLMConfig
from memos.llms.openai import OpenAILLM
from memos.log import get_logger


logger = get_logger(__name__)


class MinimaxLLM(OpenAILLM):
    """MiniMax LLM class via OpenAI-compatible API."""

    def __init__(self, config: MinimaxLLMConfig):
        super().__init__(config)
