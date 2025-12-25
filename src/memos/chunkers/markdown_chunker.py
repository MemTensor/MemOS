from memos.configs.chunker import MarkdownChunkerConfig
from memos.dependency import require_python_package
from memos.log import get_logger

from .base import BaseChunker, Chunk


logger = get_logger(__name__)


class MarkdownChunker(BaseChunker):
    """Markdown-based text chunker."""

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
        recursive: bool = False,
    ):
        from langchain_text_splitters import (
            MarkdownHeaderTextSplitter,
            RecursiveCharacterTextSplitter,
        )

        self.config = config
        self.chunker = MarkdownHeaderTextSplitter(
            headers_to_split_on=config.headers_to_split_on
            if config
            else [("#", "Header 1"), ("##", "Header 2"), ("###", "Header 3")],
            strip_headers=config.strip_headers if config else False,
        )
        self.chunker_recursive = None
        logger.info(f"Initialized MarkdownHeaderTextSplitter with config: {config}")
        if (config and config.recursive) or recursive:
            self.chunker_recursive = RecursiveCharacterTextSplitter(
                chunk_size=config.chunk_size if config else chunk_size,
                chunk_overlap=config.chunk_overlap if config else chunk_overlap,
                length_function=len,
            )

    def chunk(self, text: str, **kwargs) -> list[str] | list[Chunk]:
        """Chunk the given text into smaller chunks based on sentences."""
        md_header_splits = self.chunker.split_text(text)
        chunks = []
        if self.chunker_recursive:
            md_header_splits = self.chunker_recursive.split_documents(md_header_splits)
        for doc in md_header_splits:
            try:
                chunk = " ".join(list(doc.metadata.values())) + "\n" + doc.page_content
                chunks.append(chunk)
            except Exception as e:
                logger.warning(f"warning chunking document: {e}")
                chunks.append(doc.page_content)

        logger.debug(f"Generated {len(chunks)} chunks from input text")
        return chunks
