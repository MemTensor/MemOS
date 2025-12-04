"""Parser for string format messages.

Handles simple string messages that need to be converted to memory items.
"""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)

from .base import BaseMessageParser, _derive_key


logger = get_logger(__name__)


class StringParser(BaseMessageParser):
    """Parser for string format messages.

    Handles simple string messages in both fast and fine modes.
    - Fast mode: Directly converts string to memory item
    - Fine mode: Uses LLM to extract structured memories from string
    """

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
        """We only need rebuild from specific multimodal source"""

    def parse_fast(
        self,
        message: str,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse string message in fast mode.

        Fast mode directly converts the string to a memory item without LLM processing.
        This is equivalent to simple_struct fast mode for string messages.

        Args:
            message: String message to parse
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters

        Returns:
            List of TextualMemoryItem objects
        """
        if not isinstance(message, str):
            logger.warning(f"[StringParser] Expected str, got {type(message)}")
            return []

        content = message.strip()
        if not content:
            return []

        # Split parsed text into chunks
        content_chunks = self._split_text(content)

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # For string messages, default to LongTermMemory
        memory_type = "LongTermMemory"

        # Create memory items for each chunk
        memory_items = []
        for _chunk_idx, chunk_text in enumerate(content_chunks):
            if not chunk_text.strip():
                continue

            # Create source
            source = self.create_source(chunk_text, info)

            memory_item = TextualMemoryItem(
                memory=chunk_text,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type=memory_type,
                    status="activated",
                    tags=["mode:fast"],
                    key=_derive_key(chunk_text),
                    embedding=self.embedder.embed([chunk_text])[0],
                    usage=[],
                    sources=[source],
                    background="",
                    confidence=0.99,
                    type="fact",
                    info=info_,
                ),
            )
            memory_items.append(memory_item)
        return memory_items

    def parse_fine(
        self,
        message: str,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        logger.info(
            "str memory is inherently a "
            "text-only modality. No special multimodal handling"
            " is required in fine mode."
        )
        return []
