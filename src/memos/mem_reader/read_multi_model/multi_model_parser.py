"""Unified multi-model parser for different message types.

This module provides a unified interface to parse different message types
in both fast and fine modes.
"""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessagesType

from .assistant_parser import AssistantParser
from .base import BaseMessageParser
from .file_content_parser import FileContentParser
from .string_parser import StringParser
from .system_parser import SystemParser
from .text_content_parser import TextContentParser
from .tool_parser import ToolParser
from .user_parser import UserParser
from .utils import extract_role


logger = get_logger(__name__)


class MultiModelParser:
    """Unified parser for different message types."""

    def __init__(
        self,
        embedder: BaseEmbedder,
        llm: BaseLLM | None = None,
        parser: Any | None = None,
    ):
        """
        Initialize MultiModelParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
            parser: Optional parser for parsing file contents
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
        self.file_content_parser = FileContentParser(embedder, llm, parser)

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
            logger.warning(f"[MultiModelParser] Unknown message type: {type(message)}")
            return None

        # Check if it's a RawMessageList item (text or file)
        if "type" in message:
            msg_type = message.get("type")
            if msg_type == "text":
                return self.text_content_parser
            elif msg_type == "file":
                return self.file_content_parser

        # Check if it's a MessageList item (system, user, assistant, tool)
        role = extract_role(message)
        parser_map = {
            "system": self.system_parser,
            "user": self.user_parser,
            "assistant": self.assistant_parser,
            "tool": self.tool_parser,
        }

        if role in parser_map:
            return parser_map[role]

        # Try to infer from structure
        role = extract_role(message)
        parser_map = {
            "system": self.system_parser,
            "user": self.user_parser,
            "assistant": self.assistant_parser,
            "tool": self.tool_parser,
        }

        if role in parser_map:
            return parser_map[role]

        logger.warning(f"[MultiModelParser] Could not determine parser for message: {message}")
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
            all_items = []
            for item in message:
                items = self.parse(item, info, mode, **kwargs)
                all_items.extend(items)
            return all_items

        # Get appropriate parser
        parser = self._get_parser(message)
        if not parser:
            logger.warning(f"[MultiModelParser] No parser found for message: {message}")
            return []

        # Parse using the appropriate parser
        try:
            return parser.parse(message, info, mode=mode, **kwargs)
        except Exception as e:
            logger.error(f"[MultiModelParser] Error parsing message: {e}")
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
