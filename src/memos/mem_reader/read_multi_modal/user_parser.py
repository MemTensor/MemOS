"""Parser for user messages."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.openai_chat_completion_types import ChatCompletionUserMessageParam

from .base import BaseMessageParser, _add_lang_to_source, _derive_key, _extract_text_from_content
from .utils import detect_lang


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
            # Multimodal: first collect all text content to detect overall language
            text_contents = []
            for part in raw_content:
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text":
                        text_contents.append(part.get("text", ""))

            # Detect overall language from all text content
            overall_lang = "en"
            if text_contents:
                combined_text = " ".join(text_contents)
                overall_lang = detect_lang(combined_text)

            # Create one SourceMessage per part, all with the same detected language
            for part in raw_content:
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text":
                        source = SourceMessage(
                            type="chat",
                            role=role,
                            chat_time=chat_time,
                            message_id=message_id,
                            content=part.get("text", ""),
                        )
                        source.lang = overall_lang
                        sources.append(source)
                    elif part_type == "file":
                        file_info = part.get("file", {})
                        source = SourceMessage(
                            type="file",
                            role=role,
                            chat_time=chat_time,
                            message_id=message_id,
                            doc_path=file_info.get("filename") or file_info.get("file_id", ""),
                            content=file_info.get("file_data", ""),
                            file_info=file_info,
                        )
                        source.lang = overall_lang
                        sources.append(source)
                    elif part_type == "image_url":
                        image_info = part.get("image_url", {})
                        source = SourceMessage(
                            type="image",
                            role=role,
                            chat_time=chat_time,
                            message_id=message_id,
                            image_path=image_info.get("url"),
                        )
                        source.lang = overall_lang
                        sources.append(source)
                    else:
                        # input_audio, etc.
                        source = SourceMessage(
                            type=part_type,
                            role=role,
                            chat_time=chat_time,
                            message_id=message_id,
                            content=f"[{part_type}]",
                        )
                        source.lang = overall_lang
                        sources.append(source)
        else:
            # Simple message: single SourceMessage
            content = _extract_text_from_content(raw_content)
            if content:
                source = SourceMessage(
                    type="chat",
                    role=role,
                    chat_time=chat_time,
                    message_id=message_id,
                    content=content,
                )
                sources.append(_add_lang_to_source(source, content))

        if not sources:
            return _add_lang_to_source(SourceMessage(type="chat", role=role), None)
        if len(sources) > 1:
            return sources
        return sources[0]

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionUserMessageParam:
        """We only need rebuild from specific multimodal source"""

    def parse_fast(
        self,
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        if not isinstance(message, dict):
            logger.warning(f"[UserParser] Expected dict, got {type(message)}")
            return []

        role = message.get("role", "")
        content = message.get("content", "")
        chat_time = message.get("chat_time", None)
        if role != "user":
            logger.warning(f"[UserParser] Expected role is `user`, got {role}")
            return []
        parts = [f"{role}: "]
        if chat_time:
            parts.append(f"[{chat_time}]: ")
        prefix = "".join(parts)
        line = f"{prefix}{content}\n"
        if not line:
            return []
        memory_type = "UserMemory"

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
        message: ChatCompletionUserMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        logger.info(
            "ChatCompletionUserMessageParam is inherently a "
            "text-only modality. No special multimodal handling"
            " is required in fine mode."
        )
        return []
