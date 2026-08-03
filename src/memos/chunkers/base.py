import re

from abc import ABC, abstractmethod

from memos.configs.chunker import BaseChunkerConfig


class Chunk:
    """Class representing a text chunk."""

    def __init__(self, text: str, token_count: int, sentences: list[str]):
        self.text = text
        self.token_count = token_count
        self.sentences = sentences


class URLProtectionMixin:
    """Shared URL protect/restore helpers used across chunkers.

    Extracted so that lightweight fallbacks such as
    :class:`memos.chunkers.simple_chunker.SimpleTextSplitter` can reuse the
    same URL-aware splitting logic as :class:`BaseChunker` without inheriting
    the full chunker contract (see issue #2115).
    """

    _URL_PATTERN = r'https?://[^\s<>"{}|\\^`\[\]]+'
    # Prefix used for the placeholders emitted by :meth:`protect_urls`. Exposed
    # as a class-level constant so tests (and any other consumer that needs to
    # detect leaked placeholders) can reference it without hardcoding the
    # literal — keeping the assertion in sync with the implementation if the
    # placeholder format ever changes.
    _URL_PLACEHOLDER_PREFIX = "__URL_"

    def protect_urls(self, text: str) -> tuple[str, dict[str, str]]:
        """
        Protect URLs in text from being split during chunking.

        Args:
            text: Text to process

        Returns:
            tuple: (Text with URLs replaced by placeholders, URL mapping dictionary)
        """
        url_map: dict[str, str] = {}

        def replace_url(match):
            url = match.group(0)
            placeholder = f"{self._URL_PLACEHOLDER_PREFIX}{len(url_map)}__"
            url_map[placeholder] = url
            return placeholder

        protected_text = re.sub(self._URL_PATTERN, replace_url, text)
        return protected_text, url_map

    def restore_urls(self, text: str, url_map: dict[str, str]) -> str:
        """
        Restore protected URLs in text back to their original form.

        Args:
            text: Text with URL placeholders
            url_map: URL mapping dictionary from protect_urls

        Returns:
            str: Text with URLs restored
        """
        restored_text = text
        for placeholder, url in url_map.items():
            restored_text = restored_text.replace(placeholder, url)

        return restored_text


class BaseChunker(URLProtectionMixin, ABC):
    """Base class for all text chunkers."""

    @abstractmethod
    def __init__(self, config: BaseChunkerConfig):
        """Initialize the chunker with the given configuration."""

    @abstractmethod
    def chunk(self, text: str) -> list[Chunk]:
        """Chunk the given text into smaller chunks."""
