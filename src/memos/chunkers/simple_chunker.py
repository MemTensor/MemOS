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
        import re

        # Protect URLs from being split
        url_pattern = r'https?://[^\s<>"{}|\\^`\[\]]+'
        url_map = {}

        def replace_url(match):
            url = match.group(0)
            placeholder = f"__URL_{len(url_map)}__"
            url_map[placeholder] = url
            return placeholder

        protected_text = re.sub(url_pattern, replace_url, text)

        if not protected_text or len(protected_text) <= chunk_size:
            chunks = [protected_text] if protected_text.strip() else []
            return [self._restore_urls(c, url_map) for c in chunks]

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

        return [self._restore_urls(c, url_map) for c in chunks]

    @staticmethod
    def _restore_urls(text: str, url_map: dict[str, str]) -> str:
        for placeholder, url in url_map.items():
            text = text.replace(placeholder, url)
        return text
