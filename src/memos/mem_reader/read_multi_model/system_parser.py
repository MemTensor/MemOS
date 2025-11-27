"""Parser for system messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionSystemMessageParam

from .base import BaseMessageParser, _extract_text_from_content


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

    def create_source(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from system message."""
        if not isinstance(message, dict):
            return SourceMessage(type="chat", role="system")

        content = _extract_text_from_content(message.get("content", ""))
        return SourceMessage(
            type="chat",
            role="system",
            chat_time=message.get("chat_time"),
            message_id=message.get("message_id"),
            content=content,
        )

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionSystemMessageParam:
        """Rebuild system message from SourceMessage."""
        return {
            "role": "system",
            "content": source.content or "",
            "chat_time": source.chat_time,
            "message_id": source.message_id,
        }

    def parse_fast(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return super().parse_fast(message, info, **kwargs)

    def parse_fine(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
