import re

from abc import ABC, abstractmethod

from memos.configs.embedder import BaseEmbedderConfig


def _count_tokens_for_embedding(text: str) -> int:
    """
    Count tokens in text for embedding truncation.
    Uses tiktoken if available, otherwise falls back to heuristic.

    Args:
        text: Text to count tokens for.

    Returns:
        Number of tokens.
    """
    try:
        import tiktoken

        try:
            enc = tiktoken.encoding_for_model("gpt-4o-mini")
        except Exception:
            enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text or "", disallowed_special=()))
    except Exception:
        # Heuristic fallback: zh chars ~1 token, others ~1 token per ~4 chars
        if not text:
            return 0
        zh_chars = re.findall(r"[\u4e00-\u9fff]", text)
        zh = len(zh_chars)
        rest = len(text) - zh
        return zh + max(1, rest // 4)


def _truncate_text_to_tokens(text: str, max_tokens: int) -> str:
    """
    Truncate text to fit within max_tokens limit.
    Uses binary search to find the optimal truncation point.

    Args:
        text: Text to truncate.
        max_tokens: Maximum number of tokens allowed.

    Returns:
        Truncated text.
    """
    if not text or max_tokens is None or max_tokens <= 0:
        return text

    current_tokens = _count_tokens_for_embedding(text)
    if current_tokens <= max_tokens:
        return text

    # Binary search for the right truncation point
    low, high = 0, len(text)
    best_text = ""

    while low < high:
        mid = (low + high + 1) // 2  # Use +1 to avoid infinite loop
        truncated = text[:mid]
        tokens = _count_tokens_for_embedding(truncated)

        if tokens <= max_tokens:
            best_text = truncated
            low = mid
        else:
            high = mid - 1

    return best_text if best_text else text[:1]  # Fallback to at least one character


class BaseEmbedder(ABC):
    """Base class for all Embedding models."""

    @abstractmethod
    def __init__(self, config: BaseEmbedderConfig):
        """Initialize the embedding model with the given configuration."""
        self.config = config

    def _truncate_texts(self, texts: list[str], approx_char_per_token=1.0) -> (list)[str]:
        """
        Truncate texts to fit within max_tokens limit if configured.

        Args:
            texts: List of texts to truncate.

        Returns:
            List of truncated texts.
        """
        if not hasattr(self, "config") or self.config.max_tokens is None:
            return texts
        max_tokens = self.config.max_tokens

        truncated = []
        for t in texts:
            if len(t) < max_tokens * approx_char_per_token:
                truncated.append(t)
            else:
                truncated.append(t[:max_tokens])
        return truncated

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for the given texts."""
