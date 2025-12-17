"""Base parser interface for multi-model message parsing.

This module defines the base interface for parsing different message types
in both fast and fine modes.
"""

import re

from abc import ABC, abstractmethod
from typing import Any

from memos import log
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)

from .utils import detect_lang, get_text_splitter


logger = log.get_logger(__name__)


def _derive_key(text: str, max_len: int = 80) -> str:
    """Default key when without LLM: first max_len words."""
    if not text:
        return ""
    sent = re.split(r"[。！？!?]\s*|\n", text.strip())[0]
    return (sent[:max_len]).strip()


def _extract_text_from_content(content: Any) -> str:
    """
    Extract text from message content.
    Handles str, list of parts, or None.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for part in content:
            if isinstance(part, dict):
                part_type = part.get("type", "")
                if part_type == "text":
                    texts.append(part.get("text", ""))
                elif part_type == "file":
                    file_info = part.get("file", {})
                    texts.append(file_info.get("file_data") or file_info.get("filename", "[file]"))
                else:
                    texts.append(f"[{part_type}]")
            else:
                texts.append(str(part))
        return " ".join(texts)
    return str(content)


def _add_lang_to_source(source: SourceMessage, content: str | None = None) -> SourceMessage:
    """
    Add lang field to SourceMessage based on content.

    Args:
        source: SourceMessage to add lang field to
        content: Optional content text for language detection.
                 If None, uses source.content

    Returns:
        SourceMessage with lang field added
    """
    if not hasattr(source, "lang") or getattr(source, "lang", None) is None:
        text_for_detection = content or getattr(source, "content", None) or ""
        lang = detect_lang(text_for_detection)
        source.lang = lang
    return source


class BaseMessageParser(ABC):
    """Base interface for message type parsers."""

    def __init__(self, embedder, llm=None):
        """
        Initialize BaseMessageParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        self.embedder = embedder
        self.llm = llm

    @abstractmethod
    def create_source(
        self,
        message: Any,
        info: dict[str, Any],
    ) -> SourceMessage | list[SourceMessage]:
        """
        Create SourceMessage(s) from the message.

        Each parser decides how to create sources:
        - Simple messages: return single SourceMessage
        - Multimodal messages: return list of SourceMessage (one per part)

        Args:
            message: The message to create source from
            info: Dictionary containing user_id and session_id

        Returns:
            SourceMessage or list of SourceMessage
        """

    @abstractmethod
    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> Any:
        """
        Rebuild original message from SourceMessage.

        Each parser knows how to reconstruct its own message type.

        Args:
            source: SourceMessage to rebuild from

        Returns:
            Rebuilt message in original format
        """

    def parse_fast(
        self,
        message: Any,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Default parse_fast implementation (equivalent to simple_struct fast mode).

        Fast mode logic:
        - Extract text content from message
        - Determine memory_type based on role (UserMemory for user, LongTermMemory otherwise)
        - Create TextualMemoryItem with tags=["mode:fast"]
        - No LLM calls, quick processing

        Subclasses can override this method for custom behavior.

        Args:
            message: The message to parse
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters

        Returns:
            List of TextualMemoryItem objects
        """
        if not isinstance(message, dict):
            logger.warning(f"[BaseParser] Expected dict, got {type(message)}")
            return []

        # Extract text content
        content = _extract_text_from_content(message.get("content"))
        if not content:
            return []

        # Determine memory_type based on role (equivalent to simple_struct logic)
        role = message.get("role", "").strip().lower()
        memory_type = "UserMemory" if role == "user" else "LongTermMemory"

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
            memory=content,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type=memory_type,
                status="activated",
                tags=["mode:fast"],
                key=_derive_key(content),
                embedding=self.embedder.embed([content])[0],
                usage=[],
                sources=sources,
                background="",
                confidence=0.99,
                type="fact",
                info=info_,
            ),
        )

        return [memory_item]

    @abstractmethod
    def parse_fine(
        self,
        message: Any,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse message in fine mode (with LLM calls for better understanding).

        Args:
            message: The message to parse
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters (e.g., llm, embedder)

        Returns:
            List of TextualMemoryItem objects
        """

    def parse(
        self,
        message: Any,
        info: dict[str, Any],
        mode: str = "fast",
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse message in the specified mode.

        Args:
            message: The message to parse
            info: Dictionary containing user_id and session_id
            mode: "fast" or "fine"
            **kwargs: Additional parameters

        Returns:
            List of TextualMemoryItem objects
        """
        if mode == "fast":
            return self.parse_fast(message, info, **kwargs)
        elif mode == "fine":
            return self.parse_fine(message, info, **kwargs)
        else:
            raise ValueError(f"Unknown mode: {mode}. Must be 'fast' or 'fine'")

    def _split_text(self, text: str, is_markdown: bool = False) -> list[str]:
        """
        Split text into chunks using text splitter from utils.

        Args:
            text: Text to split

        Returns:
            List of text chunks
        """
        if not text or not text.strip():
            return []

        splitter = get_text_splitter()
        if not splitter:
            # If text splitter is not available, return text as single chunk
            return [text] if text.strip() else []

        try:
            chunks = splitter.chunk(text)
            logger.debug(f"[FileContentParser] Split text into {len(chunks)} chunks")
            return chunks
        except Exception as e:
            logger.error(f"[FileContentParser] Error splitting text: {e}")
            # Fallback to single chunk
            return [text] if text.strip() else []
