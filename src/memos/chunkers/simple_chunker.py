class SimpleTextSplitter:
    """Simple text splitter wrapper."""

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
        if not text or len(text) <= chunk_size:
            return [text] if text.strip() else []

        chunks = []
        start = 0
        text_len = len(text)

        while start < text_len:
            # Calculate end position
            end = min(start + chunk_size, text_len)

            # If not the last chunk, try to break at a good position
            if end < text_len:
                # Try to break at newline, sentence end, or space
                for separator in ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " "]:
                    last_sep = text.rfind(separator, start, end)
                    if last_sep != -1:
                        end = last_sep + len(separator)
                        break

            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # Move start position with overlap
            start = max(start + 1, end - chunk_overlap)

        return chunks
