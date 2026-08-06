from .base import BaseChunker


class SimpleTextSplitter(BaseChunker):
    """Simple text splitter wrapper."""

    def __init__(self, chunk_size: int, chunk_overlap: int):
        if chunk_size <= 0:
            raise ValueError("chunk_size must be greater than 0")
        if chunk_overlap < 0:
            raise ValueError("chunk_overlap must be non-negative")
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be smaller than chunk_size")

        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(self, text: str, **kwargs) -> list[str]:
        return self._simple_split_text(text, self.chunk_size, self.chunk_overlap)

    @classmethod
    def _placeholder_spans(
        cls, protected_text: str, url_map: dict[str, str]
    ) -> list[tuple[int, int]]:
        """Return the protected-text ranges occupied by URL placeholders."""
        return [
            (match.start(), match.end())
            for match in cls._URL_PLACEHOLDER_PATTERN.finditer(protected_text)
            if match.group(0) in url_map
        ]

    @staticmethod
    def _align_end_to_placeholder(
        end: int,
        start: int,
        chunk_overlap: int,
        placeholder_spans: list[tuple[int, int]],
    ) -> int:
        """Move a chunk end away from the middle of a URL placeholder."""
        for placeholder_start, placeholder_end in placeholder_spans:
            if placeholder_start < end < placeholder_end:
                if placeholder_start - start > chunk_overlap:
                    return placeholder_start
                return placeholder_end
        return end

    @staticmethod
    def _align_start_to_placeholder(
        next_start: int,
        previous_start: int,
        placeholder_spans: list[tuple[int, int]],
    ) -> int:
        """Keep overlap starts from landing in the middle of a URL placeholder."""
        for placeholder_start, placeholder_end in placeholder_spans:
            if placeholder_start < next_start < placeholder_end:
                if placeholder_start > previous_start:
                    return placeholder_start
                return placeholder_end
        return next_start

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
        placeholder_spans = self._placeholder_spans(protected_text, url_map)

        while start < text_len:
            # Calculate end position
            end = min(start + chunk_size, text_len)

            # If not the last chunk, try to break at a good position
            if end < text_len:
                # Try to break at newline, sentence end, or space
                for separator in ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " "]:
                    last_sep = protected_text.rfind(separator, start, end)
                    if last_sep == -1:
                        continue
                    split_end = last_sep + len(separator)
                    if split_end - start > chunk_overlap:
                        end = split_end
                        break

                end = self._align_end_to_placeholder(end, start, chunk_overlap, placeholder_spans)

            chunk = protected_text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            if end >= text_len:
                break

            # Move start position with overlap
            next_start = max(start + 1, end - chunk_overlap)
            start = self._align_start_to_placeholder(next_start, start, placeholder_spans)

        return [self.restore_urls(chunk, url_map) for chunk in chunks]
