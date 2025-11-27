"""Base parser interface for multi-model message parsing.

This module defines the base interface for parsing different message types
in both fast and fine modes.
"""

from abc import ABC, abstractmethod
from typing import Any

from memos import log
from memos.memories.textual.item import TextualMemoryItem


logger = log.get_logger(__name__)


class BaseMessageParser(ABC):
    """Base interface for message type parsers."""

    @abstractmethod
    def parse_fast(
        self,
        message: Any,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse message in fast mode (no LLM calls, quick processing).

        Args:
            message: The message to parse
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters

        Returns:
            List of TextualMemoryItem objects
        """
        res = []
        allowed_roles = {"user", "assistant", "system"}
        if not isinstance(message, dict):
            logger.warning(
                "Base Parser can only tackle with Naive Chat message, "
                f"your messages is {message}, skipping"
            )
            return res

        role = message.get("role") or ""
        role = role if isinstance(role, str) else str(role)
        role = role.strip().lower()
        if role not in allowed_roles:
            logger.warning(
                f"Base Parser can only tackle with Naive Chat message with "
                f"role in {allowed_roles}, your messages role is {role}, "
                f"skipping"
            )
            return res

        content = message.get("content", "")
        if not isinstance(content, str):
            logger.warning(
                f"Base Parser expects message content with str, your messages content"
                f"is {content!s}, skipping"
            )
            return res
        if not content:
            return res

        return TextualMemoryItem()

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
