"""Parser for tool messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.openai_chat_completion_types import ChatCompletionToolMessageParam

from .base import BaseMessageParser, _extract_text_from_content


logger = get_logger(__name__)


class ToolParser(BaseMessageParser):
    """Parser for tool messages."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize ToolParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from tool message."""
        if not isinstance(message, dict):
            return SourceMessage(type="chat", role="tool")

        content = _extract_text_from_content(message.get("content", ""))
        return SourceMessage(
            type="chat",
            role="tool",
            chat_time=message.get("chat_time"),
            message_id=message.get("message_id"),
            content=content,
        )

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionToolMessageParam:
        """Rebuild tool message from SourceMessage."""
        return {
            "role": "tool",
            "content": source.content or "",
            "tool_call_id": source.message_id or "",  # tool_call_id might be in message_id
            "chat_time": source.chat_time,
            "message_id": source.message_id,
        }

    def parse_fast(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        memory = ""
        source = self.create_source(message, info)
        return [
            TextualMemoryItem(
                memory=memory, metadata=TreeNodeTextualMemoryMetadata(sources=[source])
            )
        ]

    def parse_fine(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
