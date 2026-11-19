from memos.configs.chunker import MarkdownChunkerConfig
from memos.dependency import require_python_package
from memos.log import get_logger

from .base import BaseChunker, Chunk
from .simple_chunker import SimpleTextSplitter


logger = get_logger(__name__)


class CharacterTextChunker(BaseChunker):
    """Character-based text chunker."""

    @require_python_package(
        import_name="langchain_text_splitters",
        install_command="pip install langchain_text_splitters==1.0.0",
        install_link="https://github.com/langchain-ai/langchain-text-splitters",
    )
    def __init__(
        self,
        config: MarkdownChunkerConfig | None = None,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
    ):
        from langchain_text_splitters import (
            RecursiveCharacterTextSplitter,
        )

        self.config = config
        self.chunk_size = config.chunk_size if config else chunk_size
        self.chunk_overlap = config.chunk_overlap if config else chunk_overlap
        self.chunker = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", ""],
        )

    def chunk(self, text: str, **kwargs) -> list[str] | list[Chunk]:
        """Chunk the given text into smaller chunks based on sentences."""
        protected_text, url_map = self.protect_urls(text)
        if url_map:
            # Issue #2510: RecursiveCharacterTextSplitter can cut through the
            # __URL_<n>__ placeholders, so the URLs can no longer be restored
            # and placeholder fragments leak into the chunks. Reuse
            # SimpleTextSplitter for URL-containing inputs — it keeps
            # placeholders indivisible (see #2228).
            chunks = SimpleTextSplitter(
                chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap
            ).chunk(text, **kwargs)
            logger.debug(f"Generated {len(chunks)} chunks from input text")
            return chunks
        chunks = self.chunker.split_text(protected_text)
        chunks = [self.restore_urls(chunk, url_map) for chunk in chunks]
        logger.debug(f"Generated {len(chunks)} chunks from input text")
        return chunks
