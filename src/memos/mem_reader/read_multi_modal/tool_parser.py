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
                                file_info=file_info,
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

    def parse_fast(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        role = message.get("role", "")
        content = message.get("content", "")
        chat_time = message.get("chat_time", None)

        if role != "tool":
            logger.warning(f"[ToolParser] Expected role is `tool`, got {role}")
            return []
        parts = [f"{role}: "]
        if chat_time:
            parts.append(f"[{chat_time}]: ")
        prefix = "".join(parts)
        content = json.dumps(content) if isinstance(content, list | dict) else content
        line = f"{prefix}{content}\n"
        if not line:
            return []

        sources = self.create_source(message, info)

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        content_chunks = self._split_text(line)
        memory_items = []
        for _chunk_idx, chunk_text in enumerate(content_chunks):
            if not chunk_text.strip():
                continue

            memory_item = TextualMemoryItem(
                memory=chunk_text,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type="LongTermMemory",  # only choce long term memory for tool messages as a placeholder
                    status="activated",
                    tags=["mode:fast"],
                    sources=sources,
                    info=info_,
                ),
            )
            memory_items.append(memory_item)
        return memory_items

    def parse_fine(
        self,
        message: ChatCompletionToolMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        # tool message no special multimodal handling is required in fine mode.
        return []
