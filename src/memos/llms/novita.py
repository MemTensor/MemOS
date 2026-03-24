from memos.configs.llm import NovitaLLMConfig
from memos.llms.openai import OpenAILLM
from memos.log import get_logger


logger = get_logger(__name__)


class NovitaLLM(OpenAILLM):
    """Novita AI LLM class via OpenAI-compatible API."""

    def __init__(self, config: NovitaLLMConfig):
        super().__init__(config)
