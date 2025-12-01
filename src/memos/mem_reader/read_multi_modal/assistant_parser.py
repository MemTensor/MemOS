"""Parser for assistant messages."""

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
from memos.types.openai_chat_completion_types import ChatCompletionAssistantMessageParam

from .base import BaseMessageParser, _derive_key, _extract_text_from_content


logger = get_logger(__name__)


class AssistantParser(BaseMessageParser):
    """Parser for assistant messages.

    Handles multimodal assistant messages by creating one SourceMessage per content part.
    Supports text and refusal content parts.
    """

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize AssistantParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: ChatCompletionAssistantMessageParam,
        info: dict[str, Any],
    ) -> SourceMessage | list[SourceMessage]:
        """
        Create SourceMessage(s) from assistant message.

        Handles:
        - content: str | list of content parts (text/refusal) | None
        - refusal: str | None (top-level refusal message)
        - tool_calls: list of tool calls (when content is None)
        - audio: Audio | None (audio response data)

        For multimodal messages (content is a list), creates one SourceMessage per part.
        For simple messages (content is str), creates a single SourceMessage.
        """
        if not isinstance(message, dict):
            return []

        role = message.get("role", "assistant")
        raw_content = message.get("content")
        refusal = message.get("refusal")
        tool_calls = message.get("tool_calls")
        audio = message.get("audio")
        chat_time = message.get("chat_time")
        message_id = message.get("message_id")

        sources = []

        if isinstance(raw_content, list):
            # Multimodal: create one SourceMessage per part
            # Note: Assistant messages only support "text" and "refusal" part types
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
                    elif part_type == "refusal":
                        sources.append(
                            SourceMessage(
                                type="refusal",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=part.get("refusal", ""),
                            )
                        )
                    else:
                        # Unknown part type - log warning but still create SourceMessage
                        logger.warning(
                            f"[AssistantParser] Unknown part type `{part_type}`. "
                            f"Expected `text` or `refusal`. Creating SourceMessage with placeholder content."
                        )
                        sources.append(
                            SourceMessage(
                                type="chat",
                                role=role,
                                chat_time=chat_time,
                                message_id=message_id,
                                content=f"[{part_type}]",
                            )
                        )
        elif raw_content is not None:
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

        # Handle top-level refusal field
        if refusal:
            sources.append(
                SourceMessage(
                    type="refusal",
                    role=role,
                    chat_time=chat_time,
                    message_id=message_id,
                    content=refusal,
                )
            )

        # Handle tool_calls (when content is None or empty)
        if tool_calls:
            tool_calls_str = (
                json.dumps(tool_calls, ensure_ascii=False)
                if isinstance(tool_calls, list | dict)
                else str(tool_calls)
            )
            sources.append(
                SourceMessage(
                    type="tool_calls",
                    role=role,
                    chat_time=chat_time,
                    message_id=message_id,
                    content=f"[tool_calls]: {tool_calls_str}",
                )
            )

        # Handle audio (optional)
        if audio:
            audio_id = audio.get("id", "") if isinstance(audio, dict) else str(audio)
            sources.append(
                SourceMessage(
                    type="audio",
                    role=role,
                    chat_time=chat_time,
                    message_id=message_id,
                    content=f"[audio]: {audio_id}",
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
    ) -> ChatCompletionAssistantMessageParam:
        """We only need rebuild from specific multimodal source"""

    def parse_fast(
        self,
        message: ChatCompletionAssistantMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        if not isinstance(message, dict):
            logger.warning(f"[AssistantParser] Expected dict, got {type(message)}")
            return []

        role = message.get("role", "")
        raw_content = message.get("content")
        refusal = message.get("refusal")
        tool_calls = message.get("tool_calls")
        audio = message.get("audio")
        chat_time = message.get("chat_time", None)

        if role != "assistant":
            logger.warning(f"[AssistantParser] Expected role is `assistant`, got {role}")
            return []

        # Build content string from various sources
        content_parts = []

        # Extract content (can be str, list, or None)
        if raw_content is not None:
            extracted_content = _extract_text_from_content(raw_content)
            if extracted_content:
                content_parts.append(extracted_content)

        # Add top-level refusal if present
        if refusal:
            content_parts.append(f"[refusal]: {refusal}")

        # Add tool_calls if present (when content is None or empty)
        if tool_calls:
            tool_calls_str = (
                json.dumps(tool_calls, ensure_ascii=False)
                if isinstance(tool_calls, list | dict)
                else str(tool_calls)
            )
            content_parts.append(f"[tool_calls]: {tool_calls_str}")

        # Add audio if present
        if audio:
            audio_id = audio.get("id", "") if isinstance(audio, dict) else str(audio)
            content_parts.append(f"[audio]: {audio_id}")

        # Combine all content parts
        content = " ".join(content_parts) if content_parts else ""

        # If content is empty but we have tool_calls, audio, or refusal, still create memory
        if not content and not tool_calls and not audio and not refusal:
            return []

        parts = [f"{role}: "]
        if chat_time:
            parts.append(f"[{chat_time}]: ")
        prefix = "".join(parts)
        line = f"{prefix}{content}\n"
        if not line.strip():
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
        message: ChatCompletionAssistantMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
