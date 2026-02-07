import re

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
        auto_fix_headers: bool = True,
    ):
        from langchain_text_splitters import (
            MarkdownHeaderTextSplitter,
            RecursiveCharacterTextSplitter,
        )

        self.config = config
        self.auto_fix_headers = auto_fix_headers
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
        # Protect URLs first
        protected_text, url_map = self.protect_urls(text)
        # Auto-detect and fix malformed header hierarchy if enabled
        if self.auto_fix_headers and self._detect_malformed_headers(protected_text):
            logger.info("detected malformed header hierarchy, attempting to fix...")
            protected_text = self._fix_header_hierarchy(protected_text)
            logger.info("Header hierarchy fix completed")

        md_header_splits = self.chunker.split_text(protected_text)
        chunks = []
        if self.chunker_recursive:
            md_header_splits = self.chunker_recursive.split_documents(md_header_splits)
        for doc in md_header_splits:
            try:
                chunk = " ".join(list(doc.metadata.values())) + "\n" + doc.page_content
                chunk = self.restore_urls(chunk, url_map)
                chunks.append(chunk)
            except Exception as e:
                logger.warning(f"warning chunking document: {e}")
                restored_chunk = self.restore_urls(doc.page_content, url_map)
                chunks.append(restored_chunk)
        logger.info(f"Generated chunks: {chunks[:5]}")
        logger.debug(f"Generated {len(chunks)} chunks from input text")
        return chunks

    def _detect_malformed_headers(self, text: str) -> bool:
        """Detect if markdown has improper header hierarchy usage."""
        header_levels = []
        pattern = re.compile(r'^#{1,6}\s+.+')
        for line in text.split('\n'):
            stripped_line = line.strip()
            if pattern.match(stripped_line):
                hash_match = re.match(r'^(#+)', stripped_line)
                if hash_match:
                    level = len(hash_match.group(1))
                    header_levels.append(level)

        total_headers = len(header_levels)
        if total_headers == 0:
            return False

        level1_count = sum(1 for level in header_levels if level == 1)

        # >90% are level-1 when total > 5, or all headers are level-1 when total <= 5
        if total_headers > 5:
            level1_ratio = level1_count / total_headers
            if level1_ratio > 0.9:
                logger.warning(
                    f"Detected header hierarchy issue: {level1_count}/{total_headers} "
                    f"({level1_ratio:.1%}) of headers are level 1"
                )
                return True
        elif level1_count == total_headers:
            logger.warning(
                f"Detected header hierarchy issue: all {total_headers} headers are level 1"
            )
            return True
        return False

    def _fix_header_hierarchy(self, text: str) -> str:
        """Fix markdown header hierarchy by keeping first header and incrementing the rest."""
        header_pattern = re.compile(r'^(#{1,6})\s+(.+)$')
        lines = text.split('\n')
        fixed_lines = []
        first_valid_header = False

        for line in lines:
            stripped_line = line.strip()
            header_match = header_pattern.match(stripped_line)
            if header_match:
                current_hashes, title_content = header_match.groups()
                current_level = len(current_hashes)

                if not first_valid_header:
                    fixed_line = f"{current_hashes} {title_content}"
                    first_valid_header = True
                else:
                    new_level = min(current_level + 1, 6)
                    new_hashes = '#' * new_level
                    fixed_line = f"{new_hashes} {title_content}"
                fixed_lines.append(fixed_line)
            else:
                fixed_lines.append(line)

        return '\n'.join(fixed_lines)
