"""Parser for file content parts (RawMessageList)."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.parsers.factory import ParserFactory
from memos.types.openai_chat_completion_types import File

from .base import BaseMessageParser, _derive_key


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
        super().__init__(embedder, llm)
        self.parser = parser

    def create_source(
        self,
        message: File,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from file content part."""
        if isinstance(message, dict):
            file_info = message.get("file", {})
            return SourceMessage(
                type="file",
                doc_path=file_info.get("filename") or file_info.get("file_id", ""),
                content=file_info.get("file_data", ""),
                original_part=message,
            )
        return SourceMessage(type="file", doc_path=str(message))

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> File:
        """Rebuild file content part from SourceMessage."""
        # Use original_part if available
        if hasattr(source, "original_part") and source.original_part:
            return source.original_part

        # Rebuild from source fields
        return {
            "type": "file",
            "file": {
                "filename": source.doc_path or "",
                "file_data": source.content or "",
            },
        }

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
        """
        Parse file content part in fast mode.

        Fast mode extracts file information and creates a memory item without parsing file content.
        Handles various file parameter scenarios:
        - file_data: base64 encoded data, URL, or plain text content
        - file_id: ID of an uploaded file
        - filename: name of the file

        Args:
            message: File content part to parse (dict with "type": "file" and "file": {...})
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters

        Returns:
            List of TextualMemoryItem objects
        """
        if not isinstance(message, dict):
            logger.warning(f"[FileContentParser] Expected dict, got {type(message)}")
            return []

        # Extract file information
        file_info = message.get("file", {})
        if not isinstance(file_info, dict):
            logger.warning(f"[FileContentParser] Expected file dict, got {type(file_info)}")
            return []

        # Extract file parameters (all are optional)
        file_data = file_info.get("file_data", "")
        file_id = file_info.get("file_id", "")
        filename = file_info.get("filename", "")

        # Build content string based on available information
        content_parts = []

        # Priority 1: If file_data is provided, use it (could be base64, URL, or plain text)
        if file_data:
            # In fast mode, we don't decode base64 or fetch URLs, just record the reference
            if isinstance(file_data, str):
                # Check if it looks like base64 (starts with data: or is long base64 string)
                if file_data.startswith("data:") or (
                    len(file_data) > 100
                    and all(
                        c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
                        for c in file_data[:100]
                    )
                ):
                    content_parts.append(f"[File Data (base64/encoded): {len(file_data)} chars]")
                # Check if it looks like a URL
                elif file_data.startswith(("http://", "https://", "file://")):
                    content_parts.append(f"[File URL: {file_data}]")
                else:
                    # TODO: split into multiple memory items
                    content_parts.append(file_data)
            else:
                content_parts.append(f"[File Data: {type(file_data).__name__}]")

        # Priority 2: If file_id is provided, reference it
        if file_id:
            content_parts.append(f"[File ID: {file_id}]")

        # Priority 3: If filename is provided, include it
        if filename:
            content_parts.append(f"[Filename: {filename}]")

        # If no content can be extracted, create a placeholder
        if not content_parts:
            content_parts.append("[File: unknown]")

        # Combine content parts
        content = " ".join(content_parts)

        # Create source
        source = self.create_source(message, info)

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # For file content parts, default to LongTermMemory
        # (since we don't have role information at this level)
        memory_type = "LongTermMemory"

        # Create memory item
        memory_item = TextualMemoryItem(
            memory=content,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type=memory_type,
                status="activated",
                tags=["mode:fast", "multimodal:file"],
                key=_derive_key(content),
                embedding=self.embedder.embed([content])[0],
                usage=[],
                sources=[source],
                background="",
                confidence=0.99,
                type="fact",
                info=info_,
            ),
        )

        return [memory_item]

    def parse_fine(
        self,
        message: File,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        return []
