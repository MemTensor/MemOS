"""Parser for assistant messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionAssistantMessageParam

from .base import BaseMessageParser


logger = get_logger(__name__)


class AssistantParser(BaseMessageParser):
    """Parser for assistant messages."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize AssistantParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        self.embedder = embedder
        self.llm = llm

    def parse_fast(
        self,
        message: ChatCompletionAssistantMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []

    def parse_fine(
        self,
        message: ChatCompletionAssistantMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
