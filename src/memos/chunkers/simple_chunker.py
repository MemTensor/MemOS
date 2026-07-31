"""Simple, dependency-free text splitter used as fallback chunker."""

from memos.chunkers.base import BaseChunker
from memos.configs.chunker import BaseChunkerConfig


class SimpleTextSplitter(BaseChunker):
    """Simple text splitter wrapper with URL protection support."""

    def __init__(self, chunk_size: int, chunk_overlap: int):
        """Initialize the splitter with explicit chunk_size/overlap.

        A minimal ``BaseChunkerConfig`` is synthesized so the base class can
        carry the ``protect_urls`` / ``restore_urls`` helpers without
        requiring the caller to build a full config.
        """
        config = BaseChunkerConfig(
            tokenizer_or_token_counter="simple",
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
        super().__init__(config)
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(self, text: str, **kwargs) -> list[str]:
        return self._simple_split_text(text, self.chunk_size, self.chunk_overlap)

    def _simple_split_text(self, text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
        """Split text into chunks with URL preservation.

        This is used as a fallback when langchain-style splitters are not
        available.  URLs are protected before splitting and restored after
        so that a URL is never truncated in the middle.
        """
        protected_text, url_map = self.protect_urls(text)

        if not protected_text or len(protected_text) <= chunk_size:
            chunks = [protected_text] if protected_text and protected_text.strip() else []
            return [self.restore_urls(chunk, url_map) for chunk in chunks]

        chunks: list[str] = []
        start = 0
        text_len = len(protected_text)

        while start < text_len:
            end = min(start + chunk_size, text_len)

            if end < text_len:
                for separator in [
                    "\n\n",
                    "\n",
                    "。",
                    "！",
                    "？",
                    ". ",
                    "! ",
                    "? ",
                    " ",
                ]:
                    last_sep = protected_text.rfind(separator, start, end)
                    if last_sep != -1:
                        end = last_sep + len(separator)
                        break

            chunk = protected_text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            start = max(start + 1, end - chunk_overlap)

        return [self.restore_urls(chunk, url_map) for chunk in chunks]
