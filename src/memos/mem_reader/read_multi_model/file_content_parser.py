"""Parser for file content parts (RawMessageList)."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.parsers.factory import ParserFactory
from memos.types.openai_chat_completion_types import File

from .base import BaseMessageParser


logger = get_logger(__name__)


class FileContentParser(BaseMessageParser):
    """Parser for file content parts."""

    def __init__(
        self,
        embedder: BaseEmbedder,
        llm: BaseLLM | None = None,
        parser: Any | None = None,
    ):
        """
        Initialize FileContentParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
            parser: Optional parser for parsing file contents
        """
        self.embedder = embedder
        self.llm = llm
        self.parser = parser

    def _parse_file(self, file_info: dict[str, Any]) -> str:
        """
        Parse file content.

        Args:
            file_info: File information dictionary

        Returns:
            Parsed text content
        """
        if not self.parser:
            # Try to create a default parser
            try:
                from memos.configs.parser import ParserConfigFactory

                parser_config = ParserConfigFactory.model_validate(
                    {
                        "backend": "markitdown",
                        "config": {},
                    }
                )
                self.parser = ParserFactory.from_config(parser_config)
            except Exception as e:
                logger.warning(f"[FileContentParser] Failed to create parser: {e}")
                return ""

        file_path = file_info.get("path") or file_info.get("file_id", "")
        filename = file_info.get("filename", "unknown")

        if not file_path:
            logger.warning("[FileContentParser] No file path or file_id provided")
            return f"[File: {filename}]"

        try:
            import os

            if os.path.exists(file_path):
                parsed_text = self.parser.parse(file_path)
                return parsed_text
            else:
                logger.warning(f"[FileContentParser] File not found: {file_path}")
                return f"[File: {filename}]"
        except Exception as e:
            logger.error(f"[FileContentParser] Error parsing file {file_path}: {e}")
            return f"[File: {filename}]"

    def parse_fast(
        self,
        message: File,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []

    def parse_fine(
        self,
        message: File,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
