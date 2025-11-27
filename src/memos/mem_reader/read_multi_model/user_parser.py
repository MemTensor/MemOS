"""Parser for user messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionUserMessageParam

from .base import BaseMessageParser


logger = get_logger(__name__)


class UserParser(BaseMessageParser):
    """Parser for user messages.

    Uses the default parse_fast implementation from BaseMessageParser.
    Can override parse_fine for custom fine mode behavior.
    """

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize UserParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def parse_fast(
        self,
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []

    def parse_fine(
        self,
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
