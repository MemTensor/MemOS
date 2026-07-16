from memos.chunkers.base import URLProtectionMixin


class SimpleTextSplitter(URLProtectionMixin):
    """Simple text splitter wrapper.

    Fallback used by :mod:`memos.mem_reader.read_multi_modal.utils` when the
    optional ``langchain_text_splitters``-backed chunkers (``CharacterTextChunker``
    / ``MarkdownChunker``) cannot be constructed at import time.

    Inherits URL protect/restore helpers from :class:`URLProtectionMixin`
    (see issue #2115: without the mixin, ``chunk()`` raised ``AttributeError``
    on every call that reached the fallback path).
    """

    def __init__(self, chunk_size: int, chunk_overlap: int):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(self, text: str, **kwargs) -> list[str]:
        return self._simple_split_text(text, self.chunk_size, self.chunk_overlap)

    def _simple_split_text(self, text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
        """
        Simple text splitter as fallback when langchain is not available.

        Args:
            text: Text to split
            chunk_size: Maximum size of chunks
            chunk_overlap: Overlap between chunks

        Returns:
            List of text chunks
        """
        protected_text, url_map = self.protect_urls(text)

        if not protected_text or len(protected_text) <= chunk_size:
            chunks = [protected_text] if protected_text.strip() else []
            return [self.restore_urls(chunk, url_map) for chunk in chunks]

        chunks = []
        start = 0
        text_len = len(protected_text)

        while start < text_len:
            # Calculate end position
            end = min(start + chunk_size, text_len)

            # If not the last chunk, try to break at a good position
            if end < text_len:
                # Try to break at newline, sentence end, or space
                for separator in ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " "]:
                    last_sep = protected_text.rfind(separator, start, end)
                    if last_sep != -1:
                        end = last_sep + len(separator)
                        break

            chunk = protected_text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # Move start position with overlap
            start = max(start + 1, end - chunk_overlap)

        return [self.restore_urls(chunk, url_map) for chunk in chunks]
