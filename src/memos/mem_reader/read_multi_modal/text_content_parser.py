"""Parser for text content parts (RawMessageList).

Handles text content parts in multimodal messages.
Text content parts are typically used in user/assistant messages with multimodal content.
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
from memos.types.openai_chat_completion_types import ChatCompletionContentPartTextParam

from .base import BaseMessageParser, _derive_key


logger = get_logger(__name__)


class TextContentParser(BaseMessageParser):
    """Parser for text content parts.

    Handles text content parts in both fast and fine modes.
    - Fast mode: Directly converts text content to memory item
    - Fine mode: Returns empty list (text content is handled at parent message level)
    """

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
            )
        return SourceMessage(type="text", content=str(message))

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionContentPartTextParam:
        """We only need rebuild from specific multimodal source"""

    def parse_fast(
        self,
        message: ChatCompletionContentPartTextParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse text content part in fast mode.
        """
        if not isinstance(message, dict):
            logger.warning(f"[TextContentParser] Expected dict, got {type(message)}")
            return []

        # Extract text content
        text = message.get("text", "")
        if not isinstance(text, str):
            text = str(text) if text is not None else ""

        content = text.strip()
        if not content:
            return []

        # Create source
        source = self.create_source(message, info)

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # For text content parts, default to LongTermMemory
        # (since we don't have role information at this level)
        memory_type = "LongTermMemory"

        # Create memory item
        memory_item = TextualMemoryItem(
            memory=content,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type=memory_type,
                status="activated",
                tags=["mode:fast"],
                key=_derive_key(content),
                embedding=self.embedder.embed([content])[0],
                usage=[],
                sources=[source],
                background="",
                confidence=0.99,
                type="fact",
                info=info_,
            ),
        )

        return [memory_item]

    def parse_fine(
        self,
        message: ChatCompletionContentPartTextParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        logger.info(
            "Text content part is inherently a text-only modality. "
            "Fine mode processing is handled at the parent message level (user/assistant)."
        )
        return []
