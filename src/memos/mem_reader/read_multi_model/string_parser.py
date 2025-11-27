"""Parser for string format messages.

Handles simple string messages that need to be converted to memory items.
"""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem

from .base import BaseMessageParser


logger = get_logger(__name__)


class StringParser(BaseMessageParser):
    """Parser for string format messages."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize StringParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: str,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from string message."""
        return SourceMessage(
            type="doc",
            content=str(message),
        )

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> str:
        """Rebuild string message from SourceMessage."""
        return source.content or ""

    def parse_fast(
        self,
        message: str,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []

    def parse_fine(
        self,
        message: str,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
