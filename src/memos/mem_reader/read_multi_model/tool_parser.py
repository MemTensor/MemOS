"""Parser for tool messages."""

import json

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

from .base import BaseMessageParser


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
    ) -> SourceMessage | list[SourceMessage]:
        """Create SourceMessage from tool message."""

        if not isinstance(message, dict):
            return []

        role = message.get("role", "tool")
        raw_content = message.get("content", "")
        tool_call_id = message.get("tool_call_id", "")
        chat_time = message.get("chat_time")
        message_id = message.get("message_id")

        sources = []

        if isinstance(raw_content, list):
            # Multimodal: create one SourceMessage per part
            for part in raw_content:
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "file":
                        file_info = part.get("file", {})
                        sources.append(
                            SourceMessage(
                                type="file",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                doc_path=file_info.get("filename") or file_info.get("file_id", ""),
                                content=file_info.get("file_data", ""),
                                tool_call_id=tool_call_id,
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
                                tool_call_id=tool_call_id,
                                original_part=part,
                            )
                        )
        else:
            # Simple string content message: single SourceMessage
            content = raw_content
            if content:
                sources.append(
                    SourceMessage(
                        type="chat",
                        role=role,
                        chat_time=chat_time,
                        message_id=message_id,
                        content=content,
                        tool_call_id=tool_call_id,
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
    ) -> ChatCompletionToolMessageParam:
        """Rebuild tool message from SourceMessage."""

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
        memory = json.dumps(message)
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
