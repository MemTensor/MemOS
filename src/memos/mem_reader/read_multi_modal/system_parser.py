"""Parser for system messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.openai_chat_completion_types import ChatCompletionSystemMessageParam

from .base import BaseMessageParser, _derive_key, _extract_text_from_content


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
    ) -> SourceMessage | list[SourceMessage]:
        """
        Create SourceMessage(s) from system message.

        For multimodal messages (content is a list of text parts), creates one SourceMessage per part.
        For simple messages (content is str), creates a single SourceMessage.
        """
        if not isinstance(message, dict):
            return []

        role = message.get("role", "system")
        raw_content = message.get("content", "")
        chat_time = message.get("chat_time")
        message_id = message.get("message_id")

        sources = []

        if isinstance(raw_content, list):
            # Multimodal: create one SourceMessage per text part
            for part in raw_content:
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text":
                        sources.append(
                            SourceMessage(
                                type="chat",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=part.get("text", ""),
                            )
                        )
        else:
            # Simple message: single SourceMessage
            content = _extract_text_from_content(raw_content)
            if content:
                sources.append(
                    SourceMessage(
                        type="chat",
                        role=role,
                        chat_time=chat_time,
                        message_id=message_id,
                        content=content,
                    )
                )

        return (
            sources
            if len(sources) > 1
            else (sources[0] if sources else SourceMessage(type="chat", role=role))
        )

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionSystemMessageParam:
        """We only need rebuild from specific multimodal source"""

    def parse_fast(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        if not isinstance(message, dict):
            logger.warning(f"[SystemParser] Expected dict, got {type(message)}")
            return []

        role = message.get("role", "")
        raw_content = message.get("content", "")
        chat_time = message.get("chat_time", None)
        content = _extract_text_from_content(raw_content)
        if role != "system":
            logger.warning(f"[SystemParser] Expected role is `system`, got {role}")
            return []
        parts = [f"{role}: "]
        if chat_time:
            parts.append(f"[{chat_time}]: ")
        prefix = "".join(parts)
        line = f"{prefix}{content}\n"
        if not line:
            return []
        memory_type = "LongTermMemory"

        # Create source(s) using parser's create_source method
        sources = self.create_source(message, info)
        if isinstance(sources, SourceMessage):
            sources = [sources]
        elif not sources:
            return []

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # Create memory item (equivalent to _make_memory_item)
        memory_item = TextualMemoryItem(
            memory=line,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type=memory_type,
                status="activated",
                tags=["mode:fast"],
                key=_derive_key(line),
                embedding=self.embedder.embed([line])[0],
                usage=[],
                sources=sources,
                background="",
                confidence=0.99,
                type="fact",
                info=info_,
            ),
        )

        return [memory_item]

    def parse_fine(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
