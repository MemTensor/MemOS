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
                    if part_type == "text":
                        sources.append(
                            SourceMessage(
                                type="text",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=part.get("text", ""),
                                tool_call_id=tool_call_id,
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
                                content=file_info.get("file_data", ""),
                                filename=file_info.get("filename", ""),
                                file_id=file_info.get("file_id", ""),
                                tool_call_id=tool_call_id,
                                original_part=part,
                            )
                        )
                    elif part_type == "image_url":
                        file_info = part.get("image_url", {})
                        sources.append(
                            SourceMessage(
                                type="image_url",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=file_info.get("url", ""),
                                detail=file_info.get("detail", "auto"),
                                tool_call_id=tool_call_id,
                                original_part=part,
                            )
                        )
                    elif part_type == "input_audio":
                        file_info = part.get("input_audio", {})
                        sources.append(
                            SourceMessage(
                                type="input_audio",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=file_info.get("data", ""),
                                format=file_info.get("format", "wav"),
                                tool_call_id=tool_call_id,
                                original_part=part,
                            )
                        )
                    else:
                        logger.warning(f"[ToolParser] Unsupported part type: {part_type}")
                        continue
        else:
            # Simple string content message: single SourceMessage
            if raw_content:
                sources.append(
                    SourceMessage(
                        type="chat",
                        role=role,
                        chat_time=chat_time,
                        message_id=message_id,
                        content=raw_content,
                        tool_call_id=tool_call_id,
                    )
                )

        return sources

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
                    "tool_call_id": source.tool_call_id or "",
                    "content": [original],
                    "chat_time": source.chat_time,
                    "message_id": source.message_id,
                }
            # If it's already a full message, return it
            if isinstance(original, dict) and "role" in original:
                return original

        # Priority 2: Rebuild from source fields
        if source.type == "text":
            return {
                "role": source.role or "tool",
                "content": [
                    {
                        "type": "text",
                        "text": source.content or "",
                    }
                ],
                "chat_time": source.chat_time,
                "message_id": source.message_id,
            }
        elif source.type == "file":
            return {
                "role": source.role or "tool",
                "content": [
                    {
                        "type": "file",
                        "file": {
                            "file_id": source.file_id or "",
                            "filename": source.filename or "",
                            "file_data": source.content or "",
                        },
                    }
                ],
                "chat_time": source.chat_time,
                "message_id": source.message_id,
            }
        elif source.type == "image_url":
            return {
                "role": source.role or "tool",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": source.content or "",
                            "detail": source.detail or "auto",
                        },
                    }
                ],
                "chat_time": source.chat_time,
                "message_id": source.message_id,
            }
        elif source.type == "input_audio":
            return {
                "role": source.role or "tool",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": source.content or "",
                            "format": source.format or "wav",
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
            "tool_call_id": source.message_id or "",
            "chat_time": source.chat_time,
            "message_id": source.message_id,
        }

    def parse_fast(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        role = message.get("role", "")
        content = message.get("content", "")
        chat_time = message.get("chat_time", None)

        if role != "user":
            logger.warning(f"[ToolParser] Expected role is `user`, got {role}")
            return []
        parts = [f"{role}: "]
        if chat_time:
            parts.append(f"[{chat_time}]: ")
        prefix = "".join(parts)
        content = json.dumps(content) if isinstance(content, list) else content
        line = f"{prefix}{content}\n"
        if not line:
            return []
        memory_type = (
            "LongTermMemory"  # only choce long term memory for tool messages as a placeholder
        )

        sources = self.create_source(message, info)
        return [
            TextualMemoryItem(
                memory=line,
                metadata=TreeNodeTextualMemoryMetadata(memory_type=memory_type, sources=sources),
            )
        ]

    def parse_fine(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        content = message.get("content", "")
        if isinstance(content, list):
            part_type = content[0].get("type", "")
            if part_type == "text":
                # text will fine parse in full chat content, no need to parse specially
                return []
            elif part_type == "file":
                # TODO: use OCR to extract text from file and generate mem by llm
                content = content[0].get("file", {}).get("file_data", "")
            elif part_type == "image_url":
                # TODO: use multi-modal llm to generate mem by image url
                content = content[0].get("image_url", {}).get("url", "")
            elif part_type == "input_audio":
                # TODO: unsupport audio for now
                return []
            else:
                logger.warning(f"[ToolParser] Unsupported part type: {part_type}")
                return []
        else:
            # simple string content message, fine parse in full chat content, no need to parse specially
            return []
        return []
