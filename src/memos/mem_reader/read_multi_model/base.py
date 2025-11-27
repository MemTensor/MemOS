"""Base parser interface for multi-model message parsing.

This module defines the base interface for parsing different message types
in both fast and fine modes.
"""

from abc import ABC, abstractmethod
from typing import Any

from memos.memories.textual.item import TextualMemoryItem


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
