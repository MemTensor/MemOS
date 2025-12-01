"""Parser for user messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionUserMessageParam

from .base import BaseMessageParser, _extract_text_from_content


logger = get_logger(__name__)


class UserParser(BaseMessageParser):
    """Parser for user messages.

    Handles multimodal user messages by creating one SourceMessage per content part.
    """

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize UserParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
    ) -> SourceMessage | list[SourceMessage]:
        """
        Create SourceMessage(s) from user message.

        For multimodal messages (content is a list), creates one SourceMessage per part.
        For simple messages (content is str), creates a single SourceMessage.
        """
        if not isinstance(message, dict):
            return []

        role = message.get("role", "user")
        raw_content = message.get("content", "")
        chat_time = message.get("chat_time")
        message_id = message.get("message_id")

        sources = []

        if isinstance(raw_content, list):
            # Multimodal: create one SourceMessage per part
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
                                # Save original part for reconstruction
                                original_part=part,
                            )
                        )
                    elif part_type == "file":
                        file_info = part.get("file", {})
                        sources.append(
                            SourceMessage(
                                type="file",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                doc_path=file_info.get("filename") or file_info.get("file_id", ""),
                                content=file_info.get("file_data", ""),
                                original_part=part,
                            )
                        )
                    else:
                        # image_url, input_audio, etc.
                        sources.append(
                            SourceMessage(
                                type=part_type,
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=f"[{part_type}]",
                                original_part=part,
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
    ) -> ChatCompletionUserMessageParam:
        """
        Rebuild user message from SourceMessage.

        If source has original_part, use it directly.
        Otherwise, reconstruct from source fields.
        """
        # Priority 1: Use original_part if available
        if hasattr(source, "original_part") and source.original_part:
            original = source.original_part
            # If it's a content part, wrap it in a message
            if isinstance(original, dict) and "type" in original:
                return {
                    "role": source.role or "user",
                    "content": [original],
                    "chat_time": source.chat_time,
                    "message_id": source.message_id,
                }
            # If it's already a full message, return it
            if isinstance(original, dict) and "role" in original:
                return original

        # Priority 2: Rebuild from source fields
        if source.type == "file":
            return {
                "role": source.role or "user",
                "content": [
                    {
                        "type": "file",
                        "file": {
                            "filename": source.doc_path or "",
                            "file_data": source.content or "",
                        },
                    }
                ],
                "chat_time": source.chat_time,
                "message_id": source.message_id,
            }

        # Simple text message
        return {
            "role": source.role or "user",
            "content": source.content or "",
            "chat_time": source.chat_time,
            "message_id": source.message_id,
        }

    def parse_fast(
        self,
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return super().parse_fast(message, info, **kwargs)

    def parse_fine(
        self,
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
