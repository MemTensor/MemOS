from memos.configs.chunker import MarkdownChunkerConfig
from memos.dependency import require_python_package
from memos.log import get_logger

from .base import BaseChunker, Chunk


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
        self.chunker = RecursiveCharacterTextSplitter(
            chunk_size=config.chunk_size if config else chunk_size,
            chunk_overlap=config.chunk_overlap if config else chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", ""],
        )

    def chunk(self, text: str, **kwargs) -> list[str] | list[Chunk]:
        """Chunk the given text into smaller chunks based on sentences."""
        chunks = self.chunker.split_text(text)
        logger.debug(f"Generated {len(chunks)} chunks from input text")
        return chunks
