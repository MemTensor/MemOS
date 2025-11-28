"""Parser for text content parts (RawMessageList)."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionContentPartTextParam

from .base import BaseMessageParser


logger = get_logger(__name__)


class TextContentParser(BaseMessageParser):
    """Parser for text content parts."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize TextContentParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: ChatCompletionContentPartTextParam,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from text content part."""
        if isinstance(message, dict):
            text = message.get("text", "")
            return SourceMessage(
                type="text",
                content=text,
                original_part=message,
            )
        return SourceMessage(type="text", content=str(message))

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionContentPartTextParam:
        """Rebuild text content part from SourceMessage."""
        # Use original_part if available
        if hasattr(source, "original_part") and source.original_part:
            return source.original_part

        # Rebuild from source fields
        return {
            "type": "text",
            "text": source.content or "",
        }

    def parse_fast(
        self,
        message: ChatCompletionContentPartTextParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []

    def parse_fine(
        self,
        message: ChatCompletionContentPartTextParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
