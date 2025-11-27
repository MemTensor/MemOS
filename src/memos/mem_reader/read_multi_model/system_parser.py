"""Parser for system messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionSystemMessageParam

from .base import BaseMessageParser


logger = get_logger(__name__)


class SystemParser(BaseMessageParser):
    """Parser for system messages."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize SystemParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def parse_fast(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []

    def parse_fine(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
