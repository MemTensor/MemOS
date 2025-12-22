"""Unified multimodal parser for different message types.

This module provides a unified interface to parse different message types
in both fast and fine modes.
"""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem
from memos.types import MessagesType

from .assistant_parser import AssistantParser
from .base import BaseMessageParser
from .file_content_parser import FileContentParser
from .image_parser import ImageParser
from .string_parser import StringParser
from .system_parser import SystemParser
from .text_content_parser import TextContentParser
from .tool_parser import ToolParser
from .user_parser import UserParser
from .utils import extract_role


logger = get_logger(__name__)


class MultiModalParser:
    """Unified parser for different message types."""

    def __init__(
        self,
        embedder: BaseEmbedder,
        llm: BaseLLM | None = None,
        parser: Any | None = None,
        direct_markdown_hostnames: list[str] | None = None,
    ):
        """
        Initialize MultiModalParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
            parser: Optional parser for parsing file contents
            direct_markdown_hostnames: List of hostnames that should return markdown directly
                without parsing. If None, reads from FILE_PARSER_DIRECT_MARKDOWN_HOSTNAMES
                environment variable (comma-separated). Default: ["139.196.232.20"]
        """
        self.embedder = embedder
        self.llm = llm
        self.parser = parser

        # Initialize parsers for different message types
        self.string_parser = StringParser(embedder, llm)
        self.system_parser = SystemParser(embedder, llm)
        self.user_parser = UserParser(embedder, llm)
        self.assistant_parser = AssistantParser(embedder, llm)
        self.tool_parser = ToolParser(embedder, llm)
        self.text_content_parser = TextContentParser(embedder, llm)
        self.file_content_parser = FileContentParser(
            embedder, llm, parser, direct_markdown_hostnames=direct_markdown_hostnames
        )
        self.image_parser = ImageParser(embedder, llm)
        self.audio_parser = None  # future

        self.role_parsers = {
            "system": SystemParser(embedder, llm),
            "user": UserParser(embedder, llm),
            "assistant": AssistantParser(embedder, llm),
            "tool": ToolParser(embedder, llm),
        }

        self.type_parsers = {
            "text": self.text_content_parser,
            "file": self.file_content_parser,
            "image": self.image_parser,
            "image_url": self.image_parser,  # Support both "image" and "image_url"
            "audio": self.audio_parser,
            # Custom tool formats
            "tool_description": self.tool_parser,
            "tool_input": self.tool_parser,
            "tool_output": self.tool_parser,
        }

    def _get_parser(self, message: Any) -> BaseMessageParser | None:
        """
        Get appropriate parser for the message type.

        Args:
            message: Message to parse

        Returns:
            Appropriate parser or None
        """
        # Handle string messages
        if isinstance(message, str):
            return self.string_parser

        # Handle dict messages
        if not isinstance(message, dict):
            logger.warning(f"[MultiModalParser] Unknown message type: {type(message)}")
            return None

        # Check if it's a RawMessageList item (text or file)
        if "type" in message:
            msg_type = message.get("type")
            parser = self.type_parsers.get(msg_type)
            if parser:
                return parser

        # Check if it's a MessageList item (system, user, assistant, tool)
        role = extract_role(message)
        if role:
            parser = self.role_parsers.get(role)
            if parser:
                return parser

        logger.warning(f"[MultiModalParser] Could not determine parser for message: {message}")
        return None

    def parse(
        self,
        message: MessagesType,
        info: dict[str, Any],
        mode: str = "fast",
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse a single message in the specified mode.

        Args:
            message: Message to parse (can be str, MessageList item, or RawMessageList item)
            info: Dictionary containing user_id and session_id
            mode: "fast" or "fine"
            **kwargs: Additional parameters

        Returns:
            List of TextualMemoryItem objects
        """
        # Handle list of messages (MessageList or RawMessageList)
        if isinstance(message, list):
            return [item for msg in message for item in self.parse(msg, info, mode, **kwargs)]

        # Get appropriate parser
        parser = self._get_parser(message)
        if not parser:
            logger.warning(f"[MultiModalParser] No parser found for message: {message}")
            return []

        # Parse using the appropriate parser
        try:
            return parser.parse(message, info, mode=mode, **kwargs)
        except Exception as e:
            logger.error(f"[MultiModalParser] Error parsing message: {e}")
            return []

    def parse_batch(
        self,
        messages: list[MessagesType],
        info: dict[str, Any],
        mode: str = "fast",
        **kwargs,
    ) -> list[list[TextualMemoryItem]]:
        """
        Parse a batch of messages.

        Args:
            messages: List of messages to parse
            info: Dictionary containing user_id and session_id
            mode: "fast" or "fine"
            **kwargs: Additional parameters

        Returns:
            List of lists of TextualMemoryItem objects (one list per message)
        """
        results = []
        for message in messages:
            items = self.parse(message, info, mode, **kwargs)
            results.append(items)
        return results

    def process_transfer(
        self,
        source: SourceMessage,
        context_items: list[TextualMemoryItem] | None = None,
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Process transfer from SourceMessage to fine memory items.

        This method:
        1. Determines which parser to use based on source type
        2. Rebuilds message from source using parser's rebuild_from_source
        3. Calls parse_fine on the appropriate parser

        Args:
            source: SourceMessage to process
            context_items: Optional list of TextualMemoryItem for context
            **kwargs: Additional parameters (e.g., info dict with user_id, session_id, custom_tags)

        Returns:
            List of TextualMemoryItem objects from fine mode parsing
        """
        if not self.llm:
            logger.warning("[MultiModalParser] LLM not available for process_transfer")
            return []

        # Extract info from context_items if available
        info = kwargs.get("info", {})
        if context_items and len(context_items) > 0:
            first_item = context_items[0]
            if not info:
                info = {
                    "user_id": first_item.metadata.user_id,
                    "session_id": first_item.metadata.session_id,
                }

        # Try to determine parser from source.type
        parser = None
        if source.type == "file":
            parser = self.file_content_parser
        elif source.type == "text":
            parser = self.text_content_parser
        elif source.type in ["image", "image_url"]:
            parser = self.image_parser
        elif source.role:
            # Chat message, use role parser
            parser = self.role_parsers.get(source.role)

        if not parser:
            logger.warning(f"[MultiModalParser] Could not determine parser for source: {source}")
            return []

        # Rebuild message from source using parser's method
        try:
            message = parser.rebuild_from_source(source)
        except Exception as e:
            logger.error(f"[MultiModalParser] Error rebuilding message from source: {e}")
            return []

        # Parse in fine mode (pass context_items and custom_tags to parse_fine)
        try:
            custom_tags = kwargs.pop("custom_tags", None)
            info = kwargs.pop("info", None)
            return parser.parse_fine(
                message, info, context_items=context_items, custom_tags=custom_tags, **kwargs
            )
        except Exception as e:
            logger.error(f"[MultiModalParser] Error parsing in fine mode: {e}")
            return []
