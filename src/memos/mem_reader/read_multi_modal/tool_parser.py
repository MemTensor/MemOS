"""Parser for tool messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem
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
        message: ChatCompletionToolMessageParam | dict[str, Any],
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from tool message or custom tool format."""
        if not isinstance(message, dict):
            return SourceMessage(type="chat", role="tool")

        # Handle custom tool formats (tool_description, tool_input, tool_output)
        msg_type = message.get("type", "")
        if msg_type == "tool_description":
            name = message.get("name", "")
            description = message.get("description", "")
            parameters = message.get("parameters", {})
            content = f"[tool_description] name={name}, description={description}, parameters={parameters}"
            return SourceMessage(
                type="tool_description",
                content=content,
                original_part=message,
            )
        elif msg_type == "tool_input":
            call_id = message.get("call_id", "")
            name = message.get("name", "")
            argument = message.get("argument", {})
            content = f"[tool_input] call_id={call_id}, name={name}, argument={argument}"
            return SourceMessage(
                type="tool_input",
                content=content,
                message_id=call_id,
                original_part=message,
            )
        elif msg_type == "tool_output":
            call_id = message.get("call_id", "")
            name = message.get("name", "")
            output = message.get("output", {})
            content = f"[tool_output] call_id={call_id}, name={name}, output={output}"
            return SourceMessage(
                type="tool_output",
                content=content,
                message_id=call_id,
                original_part=message,
            )

        # Handle standard tool message
        content = _extract_text_from_content(message.get("content", ""))
        return SourceMessage(
            type="tool",
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
        message: ChatCompletionToolMessageParam | dict[str, Any],
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """Parse tool message in fast mode."""
        from memos.memories.textual.item import TreeNodeTextualMemoryMetadata

        from .base import _derive_key

        if not isinstance(message, dict):
            return []

        # Handle custom tool formats
        msg_type = message.get("type", "")
        if msg_type in ("tool_description", "tool_input", "tool_output"):
            # Create source
            source = self.create_source(message, info)
            content = source.content or ""
            if not content:
                return []

            # Extract info fields
            info_ = info.copy()
            user_id = info_.pop("user_id", "")
            session_id = info_.pop("session_id", "")

            # Create memory item
            memory_item = TextualMemoryItem(
                memory=content,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type="LongTermMemory",
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

        # Handle standard tool message
        return super().parse_fast(message, info, **kwargs)

    def parse_fine(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
