import functools
import re
import time

from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any, TypeVar, cast

from memos.configs.embedder import BaseEmbedderConfig
from memos.log import get_logger, text_hash


logger = get_logger(__name__)
EmbeddingCallable = TypeVar("EmbeddingCallable", bound=Callable[..., Any])

_SAFE_EMBEDDING_MAX_TOKENS: int = 3072


def log_embedding_call(func: EmbeddingCallable) -> EmbeddingCallable:
    """Log embedding request dimensions and timing without text or vectors."""

    @functools.wraps(func)
    def wrapper(self, texts, *args, **kwargs):
        normalized_texts = [texts] if isinstance(texts, str) else list(texts or [])
        text_lengths = [len(str(text or "")) for text in normalized_texts]
        config = getattr(self, "config", None)
        model = getattr(config, "model_name_or_path", None) or "unknown"
        backup_model = getattr(config, "backup_model_name_or_path", None) or "none"
        backup_enabled = bool(getattr(self, "use_backup_client", False))
        started_at = time.perf_counter()
        status = "success"
        error_type = None
        try:
            return func(self, texts, *args, **kwargs)
        except Exception as exc:
            status = "failed"
            error_type = type(exc).__name__
            raise
        finally:
            elapsed_ms = (time.perf_counter() - started_at) * 1000
            log_message = (
                "Embedding request model=%s backup_model=%s backup_enabled=%s "
                "batch_size=%d total_chars=%d max_chars=%d text_hash=%s "
                "elapsed_ms=%.2f status=%s"
            )
            log_values = (
                model,
                backup_model,
                backup_enabled,
                len(normalized_texts),
                sum(text_lengths),
                max(text_lengths, default=0),
                text_hash(normalized_texts),
                elapsed_ms,
                status,
            )
            if error_type is None:
                logger.info(log_message, *log_values)
            else:
                logger.info(log_message + " error_type=%s", *log_values, error_type)

    return cast("EmbeddingCallable", wrapper)


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
        Truncate texts to fit within a per-text token limit.

        When the configuration does not specify an explicit limit, the
        per-provider default supplied by :meth:`_effective_max_tokens` is
        used.  This avoids hard-coded 8192 limits that exceed the actual
        token budget (e.g. text-embedding-3's 3072-token input limit).

        Truncation is token-aware: each text is measured with
        :func:`_count_tokens_for_embedding` and, if necessary, truncated via
        :func:`_truncate_text_to_tokens` (binary search over prefix length).

        Args:
            texts: List of texts to truncate.
            approx_char_per_token: Ignored; retained for backwards
                compatibility with older call sites.

        Returns:
            List of truncated texts.
        """
        if not hasattr(self, "config"):
            return texts
        max_tokens = self._effective_max_tokens()
        if max_tokens is None or max_tokens <= 0:
            return texts

        truncated: list[str] = []
        for t in texts:
            # Cheap fast-path: if the text is obviously too short to exceed
            # the token budget, skip the (potentially expensive) token count.
            # ~1 char/token for CJK text is the worst case.
            if len(t) <= max_tokens:
                truncated.append(t)
                continue
            truncated.append(_truncate_text_to_tokens(t, max_tokens))
        return truncated

    def _effective_max_tokens(self) -> int | None:
        """Return the per-text token limit used for truncation.

        Callers can override ``self.config.max_tokens`` explicitly. When it
        is not set (``None`` or ``0`` after coercion through the config)
        this falls back to a safe provider-aware default so that APIs like
        text-embedding-3 (3072 input tokens) are never sent inputs that
        would otherwise trigger an out-of-budget error.
        """
        config = getattr(self, "config", None)
        if config is not None:
            configured = getattr(config, "max_tokens", None)
            if configured is not None and configured > 0:
                return configured
        return _SAFE_EMBEDDING_MAX_TOKENS

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for the given texts."""
