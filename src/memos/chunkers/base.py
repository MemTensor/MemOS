import re
import uuid

from abc import ABC, abstractmethod

from memos.configs.chunker import BaseChunkerConfig


class Chunk:
    """Class representing a text chunk."""

    def __init__(self, text: str, token_count: int, sentences: list[str]):
        self.text = text
        self.token_count = token_count
        self.sentences = sentences


class BaseChunker(ABC):
    """Base class for all text chunkers."""

    _URL_PATTERN = r'https?://[^\s<>"{}|\\^`\[\]]+'
    _URL_PLACEHOLDER_PREFIX = "__URL_"
    _URL_PLACEHOLDER_PATTERN = re.compile(
        rf"{re.escape(_URL_PLACEHOLDER_PREFIX)}(?:[0-9a-f]+_)?\d+__"
    )

    @abstractmethod
    def __init__(self, config: BaseChunkerConfig):
        """Initialize the chunker with the given configuration."""

    @abstractmethod
    def chunk(self, text: str) -> list[Chunk]:
        """Chunk the given text into smaller chunks."""

    @classmethod
    def _new_url_placeholder_prefix(cls, text: str) -> str:
        """Return a placeholder namespace that cannot collide with the input."""
        if cls._URL_PLACEHOLDER_PREFIX not in text:
            return cls._URL_PLACEHOLDER_PREFIX

        while True:
            placeholder_prefix = f"{cls._URL_PLACEHOLDER_PREFIX}{uuid.uuid4().hex[:8]}_"
            if placeholder_prefix not in text:
                return placeholder_prefix

    def protect_urls(self, text: str) -> tuple[str, dict[str, str]]:
        """
        Protect URLs in text from being split during chunking.

        Args:
            text: Text to process

        Returns:
            tuple: (Text with URLs replaced by placeholders, URL mapping dictionary)
        """
        url_map: dict[str, str] = {}
        placeholder_prefix = self._new_url_placeholder_prefix(text)

        def replace_url(match):
            url = match.group(0)
            placeholder = f"{placeholder_prefix}{len(url_map)}__"
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
        return self._URL_PLACEHOLDER_PATTERN.sub(
            lambda match: url_map.get(match.group(0), match.group(0)), text
        )
