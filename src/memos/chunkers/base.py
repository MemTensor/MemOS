import re
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

    @abstractmethod
    def __init__(self, config: BaseChunkerConfig):
        """Initialize the chunker with the given configuration."""

    @abstractmethod
    def chunk(self, text: str) -> list[Chunk]:
        """Chunk the given text into smaller chunks."""

    def protect_urls(self, text: str) -> tuple[str, dict[str, str]]:
        """Protect URLs in text from being split during chunking.

        Returns:
            tuple: (Text with URLs replaced by placeholders, URL mapping dictionary)
        """
        url_pattern = r'https?://[^\s<>"{}|\\^`\[\]]+'
        url_map = {}

        def replace_url(match):
            url = match.group(0)
            placeholder = f"__URL_{len(url_map)}__"
            url_map[placeholder] = url
            return placeholder

        protected_text = re.sub(url_pattern, replace_url, text)
        return protected_text, url_map

    def restore_urls(self, text: str, url_map: dict[str, str]) -> str:
        """Restore protected URLs in text back to their original form."""
        restored_text = text
        for placeholder, url in url_map.items():
            restored_text = restored_text.replace(placeholder, url)
        return restored_text
