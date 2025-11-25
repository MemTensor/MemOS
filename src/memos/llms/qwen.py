from memos.configs.llm import QwenLLMConfig
from memos.llms.openai import OpenAILLM
from memos.log import get_logger


logger = get_logger(__name__)


class QwenLLM(OpenAILLM):
    """Qwen (DashScope) LLM class via OpenAI-compatible API."""

    def __init__(self, config: QwenLLMConfig):
        super().__init__(config)
