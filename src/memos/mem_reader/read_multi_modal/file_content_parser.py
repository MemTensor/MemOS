"""Parser for file content parts (RawMessageList)."""

import concurrent.futures
import os
import re
import tempfile

from typing import Any

from tqdm import tqdm

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_reader.read_multi_modal.base import BaseMessageParser, _derive_key
from memos.mem_reader.read_multi_modal.image_parser import ImageParser
from memos.mem_reader.read_multi_modal.utils import (
    detect_lang,
    get_parser,
    parse_json_result,
)
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.templates.mem_reader_prompts import (
    CUSTOM_TAGS_INSTRUCTION,
    CUSTOM_TAGS_INSTRUCTION_ZH,
    SIMPLE_STRUCT_DOC_READER_PROMPT,
    SIMPLE_STRUCT_DOC_READER_PROMPT_ZH,
)
from memos.types.openai_chat_completion_types import File


logger = get_logger(__name__)

# Prompt dictionary for doc processing (shared by simple_struct and file_content_parser)
DOC_PROMPT_DICT = {
    "doc": {"en": SIMPLE_STRUCT_DOC_READER_PROMPT, "zh": SIMPLE_STRUCT_DOC_READER_PROMPT_ZH},
    "custom_tags": {"en": CUSTOM_TAGS_INSTRUCTION, "zh": CUSTOM_TAGS_INSTRUCTION_ZH},
}


class FileContentParser(BaseMessageParser):
    """Parser for file content parts."""

    def _get_doc_llm_response(self, chunk_text: str, custom_tags: list[str] | None = None) -> dict:
        """
        Call LLM to extract memory from document chunk.
        Uses doc prompts from DOC_PROMPT_DICT.

        Args:
            chunk_text: Text chunk to extract memory from
            custom_tags: Optional list of custom tags for LLM extraction

        Returns:
            Parsed JSON response from LLM or empty dict if failed
        """
        if not self.llm:
            logger.warning("[FileContentParser] LLM not available for fine mode")
            return {}

        lang = detect_lang(chunk_text)
        template = DOC_PROMPT_DICT["doc"][lang]
        prompt = template.replace("{chunk_text}", chunk_text)

        custom_tags_prompt = (
            DOC_PROMPT_DICT["custom_tags"][lang].replace("{custom_tags}", str(custom_tags))
            if custom_tags
            else ""
        )
        prompt = prompt.replace("{custom_tags_prompt}", custom_tags_prompt)

        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages)
            response_json = parse_json_result(response_text)
        except Exception as e:
            logger.error(f"[FileContentParser] LLM generation error: {e}")
            response_json = {}
        return response_json

    def _handle_url(self, url_str: str, filename: str) -> tuple[str, str | None, bool]:
        """Download and parse file from URL."""
        try:
            from urllib.parse import urlparse

            import requests

            parsed_url = urlparse(url_str)
            hostname = parsed_url.hostname or ""

            response = requests.get(url_str, timeout=30)
            response.raise_for_status()

            if not filename:
                filename = os.path.basename(parsed_url.path) or "downloaded_file"

            if hostname in self.direct_markdown_hostnames:
                return response.text, None, True

            file_ext = os.path.splitext(filename)[1].lower()
            if file_ext in [".md", ".markdown", ".txt"]:
                return response.text, None, True
            with tempfile.NamedTemporaryFile(mode="wb", delete=False, suffix=file_ext) as temp_file:
                temp_file.write(response.content)
            return "", temp_file.name, False
        except Exception as e:
            logger.error(f"[FileContentParser] URL processing error: {e}")
            return f"[File URL download failed: {url_str}]", None

    def _is_base64(self, data: str) -> bool:
        """Quick heuristic to check base64-like string."""
        return data.startswith("data:") or (
            len(data) > 100
            and all(
                c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
                for c in data[:100]
            )
        )

    def _handle_base64(self, data: str) -> str:
        """Base64 not implemented placeholder."""
        logger.info("[FileContentParser] Base64 content detected but decoding is not implemented.")
        return ""

    def _handle_local(self, data: str) -> str:
        """Base64 not implemented placeholder."""
        logger.info("[FileContentParser] Local file paths are not supported in fine mode.")
        return ""

    def _process_single_image(
        self, image_url: str, original_ref: str, info: dict[str, Any], **kwargs
    ) -> tuple[str, str]:
        """
        Process a single image and return (original_ref, replacement_text).

        Args:
            image_url: URL of the image to process
            original_ref: Original markdown image reference to replace
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters for ImageParser

        Returns:
            Tuple of (original_ref, replacement_text)
        """
        try:
            # Construct image message format for ImageParser
            image_message = {
                "type": "image_url",
                "image_url": {
                    "url": image_url,
                    "detail": "auto",
                },
            }

            # Process image using ImageParser
            logger.debug(f"[FileContentParser] Processing image: {image_url}")
            memory_items = self.image_parser.parse_fine(image_message, info, **kwargs)

            # Extract text content from memory items (only strings as requested)
            extracted_texts = []
            for item in memory_items:
                if hasattr(item, "memory") and item.memory:
                    extracted_texts.append(str(item.memory))

            if extracted_texts:
                # Combine all extracted texts
                extracted_content = "\n".join(extracted_texts)
                # Replace image with extracted content
                return (
                    original_ref,
                    f"\n[Image Content from {image_url}]:\n{extracted_content}\n",
                )
            else:
                # If no content extracted, keep original with a note
                logger.warning(f"[FileContentParser] No content extracted from image: {image_url}")
                return (
                    original_ref,
                    f"\n[Image: {image_url} - No content extracted]\n",
                )

        except Exception as e:
            logger.error(f"[FileContentParser] Error processing image {image_url}: {e}")
            # On error, keep original image reference
            return (original_ref, original_ref)

    def _extract_and_process_images(self, text: str, info: dict[str, Any], **kwargs) -> str:
        """
        Extract all images from markdown text and process them using ImageParser in parallel.
        Replaces image references with extracted text content.

        Args:
            text: Markdown text containing image references
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters for ImageParser

        Returns:
            Text with image references replaced by extracted content
        """
        if not text or not self.image_parser:
            return text

        # Pattern to match markdown images: ![](url) or ![alt](url)
        image_pattern = r"!\[([^\]]*)\]\(([^)]+)\)"

        # Find all image matches first
        image_matches = list(re.finditer(image_pattern, text))
        if not image_matches:
            return text

        logger.info(f"[FileContentParser] Found {len(image_matches)} images to process in parallel")

        # Prepare tasks for parallel processing
        tasks = []
        for match in image_matches:
            image_url = match.group(2)
            original_ref = match.group(0)
            tasks.append((image_url, original_ref))

        # Process images in parallel
        replacements = {}
        max_workers = min(len(tasks), 10)  # Limit concurrent image processing

        with ContextThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    self._process_single_image, image_url, original_ref, info, **kwargs
                ): (image_url, original_ref)
                for image_url, original_ref in tasks
            }

            # Collect results with progress tracking
            for future in tqdm(
                concurrent.futures.as_completed(futures),
                total=len(futures),
                desc="[FileContentParser] Processing images",
            ):
                try:
                    original_ref, replacement = future.result()
                    replacements[original_ref] = replacement
                except Exception as e:
                    image_url, original_ref = futures[future]
                    logger.error(f"[FileContentParser] Future failed for image {image_url}: {e}")
                    # On error, keep original image reference
                    replacements[original_ref] = original_ref

        # Replace all images in the text
        processed_text = text
        for original, replacement in replacements.items():
            processed_text = processed_text.replace(original, replacement, 1)

        # Count successfully extracted images
        success_count = sum(
            1 for replacement in replacements.values() if "Image Content from" in replacement
        )
        logger.info(
            f"[FileContentParser] Processed {len(image_matches)} images in parallel, "
            f"extracted content for {success_count} images"
        )
        return processed_text

    def __init__(
        self,
        embedder: BaseEmbedder,
        llm: BaseLLM | None = None,
        parser: Any | None = None,
        direct_markdown_hostnames: list[str] | None = None,
    ):
        """
        Initialize FileContentParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
            parser: Optional parser for parsing file contents
            direct_markdown_hostnames: List of hostnames that should return markdown directly
                without parsing. If None, reads from FILE_PARSER_DIRECT_MARKDOWN_HOSTNAMES
                environment variable (comma-separated).
        """
        super().__init__(embedder, llm)
        self.parser = parser
        # Initialize ImageParser for processing images in markdown
        self.image_parser = ImageParser(embedder, llm) if llm else None

        # Get inner markdown hostnames from config or environment
        if direct_markdown_hostnames is not None:
            self.direct_markdown_hostnames = direct_markdown_hostnames
        else:
            env_hostnames = os.getenv("FILE_PARSER_DIRECT_MARKDOWN_HOSTNAMES", "")
            if env_hostnames:
                # Support comma-separated list
                self.direct_markdown_hostnames = [
                    h.strip() for h in env_hostnames.split(",") if h.strip()
                ]
            else:
                self.direct_markdown_hostnames = []

    def create_source(
        self,
        message: File,
        info: dict[str, Any],
        chunk_index: int | None = None,
        chunk_total: int | None = None,
        chunk_content: str | None = None,
        file_url_flag: bool = False,
    ) -> SourceMessage:
        """Create SourceMessage from file content part."""
        if isinstance(message, dict):
            file_info = message.get("file", {})
            source_dict = {
                "type": "file",
                "doc_path": file_info.get("filename") or file_info.get("file_id", ""),
                "content": chunk_content if chunk_content else file_info.get("file_data", ""),
                "file_info": file_info if file_url_flag else {},
            }
            # Add chunk ordering information if provided
            if chunk_index is not None:
                source_dict["chunk_index"] = chunk_index
            if chunk_total is not None:
                source_dict["chunk_total"] = chunk_total
            return SourceMessage(**source_dict)
        source_dict = {"type": "file", "doc_path": str(message)}
        if chunk_index is not None:
            source_dict["chunk_index"] = chunk_index
        if chunk_total is not None:
            source_dict["chunk_total"] = chunk_total
        if chunk_content is not None:
            source_dict["content"] = chunk_content
        return SourceMessage(**source_dict)

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> File:
        """Rebuild file content part from SourceMessage."""
        # Rebuild from source fields
        return {
            "type": "file",
            "file": source.file_info,
        }

    def _parse_file(self, file_info: dict[str, Any]) -> str:
        """
        Parse file content.

        Args:
            file_info: File information dictionary

        Returns:
            Parsed text content
        """
        parser = self.parser or get_parser()
        if not parser:
            logger.warning("[FileContentParser] Parser not available")
            return ""

        file_path = file_info.get("path") or file_info.get("file_id", "")
        filename = file_info.get("filename", "unknown")

        if not file_path:
            logger.warning("[FileContentParser] No file path or file_id provided")
            return f"[File: {filename}]"

        try:
            if os.path.exists(file_path):
                parsed_text = parser.parse(file_path)
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
        file_url_flag = False
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
                    file_url_flag = True
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

        # Split content into chunks
        content_chunks = self._split_text(content)

        # Extract info fields
        info_ = info.copy()
        if file_id:
            info_.update({"file_id": file_id})
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # For file content parts, default to LongTermMemory
        # (since we don't have role information at this level)
        memory_type = "LongTermMemory"
        file_ids = [file_id] if file_id else []
        total_chunks = len(content_chunks)

        # Create memory items for each chunk
        content_chunk_embeddings = self.embedder.embed(content_chunks)
        memory_items = []
        for chunk_idx, chunk_text in enumerate(content_chunks):
            if not chunk_text.strip():
                continue

            # Create source for this specific chunk with its index and content
            source = self.create_source(
                message,
                info,
                chunk_index=chunk_idx,
                chunk_total=total_chunks,
                chunk_content=chunk_text,
                file_url_flag=file_url_flag,
            )

            memory_item = TextualMemoryItem(
                memory=chunk_text,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type=memory_type,
                    status="activated",
                    tags=[
                        "mode:fast",
                        "multimodal:file",
                        f"chunk:{chunk_idx + 1}/{total_chunks}",
                    ],
                    key=_derive_key(chunk_text),
                    embedding=content_chunk_embeddings[chunk_idx],
                    usage=[],
                    sources=[source],
                    background="",
                    confidence=0.99,
                    type="fact",
                    info=info_,
                    file_ids=file_ids,
                ),
            )
            memory_items.append(memory_item)

        # If no chunks were created, create a placeholder
        if not memory_items:
            # Create source for placeholder (no chunk index since there are no chunks)
            placeholder_source = self.create_source(
                message,
                info,
                chunk_index=None,
                chunk_total=0,
                chunk_content=content,
                file_url_flag=file_url_flag,
            )
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
                    sources=[placeholder_source],
                    background="",
                    confidence=0.99,
                    type="fact",
                    info=info_,
                    file_ids=file_ids,
                ),
            )
            memory_items.append(memory_item)

        return memory_items

    def parse_fine(
        self,
        message: File,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """
        Parse file content part in fine mode.
        Fine mode downloads and parses file content, especially for URLs.
        Then uses LLM to extract structured memories from each chunk.

        Handles various file parameter scenarios:
        - file_data: URL (http://, https://, or @http://), base64 encoded data, or plain text content
        - file_id: ID of an uploaded file
        - filename: name of the file

        Args:
            message: File content part to parse
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters including:
                - custom_tags: Optional list of custom tags for LLM extraction
                - context_items: Optional list of TextualMemoryItem for context
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

        # Extract custom_tags from kwargs (for LLM extraction)
        custom_tags = kwargs.get("custom_tags")

        # Use parser from utils
        parser = self.parser or get_parser()
        if not parser:
            logger.warning("[FileContentParser] Parser not available")
            return []

        parsed_text = ""
        temp_file_path = None
        is_markdown = False

        try:
            # Priority 1: If file_data is provided, process it
            if file_data:
                if isinstance(file_data, str):
                    url_str = file_data[1:] if file_data.startswith("@") else file_data

                    if url_str.startswith(("http://", "https://")):
                        parsed_text, temp_file_path, is_markdown = self._handle_url(
                            url_str, filename
                        )
                        if temp_file_path:
                            try:
                                # Use parser from utils
                                if parser:
                                    parsed_text = parser.parse(temp_file_path)
                                else:
                                    parsed_text = "[File parsing error: Parser not available]"
                            except Exception as e:
                                logger.error(
                                    f"[FileContentParser] Error parsing downloaded file: {e}"
                                )
                                parsed_text = f"[File parsing error: {e!s}]"

                    elif os.path.exists(file_data):
                        parsed_text = self._handle_local(file_data)

                    elif self._is_base64(file_data):
                        parsed_text = self._handle_base64(file_data)

                    else:
                        # TODO: discuss the proper place for processing
                        #  string file-data
                        return []
            # Priority 2: If file_id is provided but no file_data, try to use file_id as path
            elif file_id:
                logger.warning(f"[FileContentParser] File data not provided for file_id: {file_id}")
                parsed_text = f"[File ID: {file_id}]: File data not provided"

            # If no content could be parsed, create a placeholder
            if not parsed_text:
                if filename:
                    parsed_text = f"[File: {filename}] File data not provided"
                else:
                    parsed_text = "[File: unknown] File data not provided"

        except Exception as e:
            logger.error(f"[FileContentParser] Error in parse_fine: {e}")
            parsed_text = f"[File parsing error: {e!s}]"

        finally:
            # Clean up temporary file
            if temp_file_path and os.path.exists(temp_file_path):
                try:
                    os.unlink(temp_file_path)
                    logger.debug(f"[FileContentParser] Cleaned up temporary file: {temp_file_path}")
                except Exception as e:
                    logger.warning(
                        f"[FileContentParser] Failed to delete temp file {temp_file_path}: {e}"
                    )

        # Extract and process images from parsed_text
        if is_markdown and parsed_text and self.image_parser:
            parsed_text = self._extract_and_process_images(parsed_text, info, **kwargs)

        # Extract info fields
        if not info:
            info = {}
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")
        if file_id:
            info_["file_id"] = file_id
        file_ids = [file_id] if file_id else []
        # For file content parts, default to LongTermMemory
        memory_type = "LongTermMemory"

        # Split parsed text into chunks
        content_chunks = self._split_text(parsed_text, is_markdown)

        # Filter out empty chunks and create indexed list
        valid_chunks = [
            (idx, chunk_text) for idx, chunk_text in enumerate(content_chunks) if chunk_text.strip()
        ]
        total_chunks = len(content_chunks)

        # Helper function to create memory item (similar to SimpleStructMemReader._make_memory_item)
        def _make_memory_item(
            value: str,
            mem_type: str = memory_type,
            tags: list[str] | None = None,
            key: str | None = None,
            chunk_idx: int | None = None,
            chunk_content: str | None = None,
        ) -> TextualMemoryItem:
            """Construct memory item with common fields.

            Args:
                value: Memory content (chunk text)
                mem_type: Memory type
                tags: Tags for the memory item
                key: Key for the memory item
                chunk_idx: Index of the chunk in the document (0-based)
            """
            # Create source for this specific chunk with its index and content
            chunk_source = self.create_source(
                message,
                info,
                chunk_index=chunk_idx,
                chunk_total=total_chunks,
                chunk_content=chunk_content,
            )
            return TextualMemoryItem(
                memory=value,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type=mem_type,
                    status="activated",
                    tags=tags or [],
                    key=key if key is not None else _derive_key(value),
                    embedding=self.embedder.embed([value])[0],
                    usage=[],
                    sources=[chunk_source],
                    background="",
                    confidence=0.99,
                    type="fact",
                    info=info_,
                    file_ids=file_ids,
                ),
            )

        # Helper function to create fallback item for a chunk
        def _make_fallback(
            chunk_idx: int, chunk_text: str, reason: str = "raw"
        ) -> TextualMemoryItem:
            """Create fallback memory item with raw chunk text."""
            return _make_memory_item(
                value=chunk_text,
                tags=[
                    "mode:fine",
                    "multimodal:file",
                    f"fallback:{reason}",
                    f"chunk:{chunk_idx + 1}/{total_chunks}",
                ],
                chunk_idx=chunk_idx,
                chunk_content=chunk_text,
            )

        # Handle empty chunks case
        if not valid_chunks:
            return [
                _make_memory_item(
                    value=parsed_text or "[File: empty content]",
                    tags=["mode:fine", "multimodal:file"],
                    chunk_idx=None,
                )
            ]

        # If no LLM available, create memory items directly from chunks
        if not self.llm:
            return [_make_fallback(idx, text, "no_llm") for idx, text in valid_chunks]

        # Process single chunk with LLM extraction (worker function)
        def _process_chunk(chunk_idx: int, chunk_text: str) -> TextualMemoryItem:
            """Process chunk with LLM, fallback to raw on failure."""
            try:
                response_json = self._get_doc_llm_response(chunk_text, custom_tags)
                if response_json:
                    value = response_json.get("value", "").strip()
                    if value:
                        tags = response_json.get("tags", [])
                        tags = tags if isinstance(tags, list) else []
                        tags.extend(["mode:fine", "multimodal:file"])

                        llm_mem_type = response_json.get("memory_type", memory_type)
                        if llm_mem_type not in ["LongTermMemory", "UserMemory"]:
                            llm_mem_type = memory_type

                        return _make_memory_item(
                            value=value,
                            mem_type=llm_mem_type,
                            tags=tags,
                            key=response_json.get("key"),
                            chunk_idx=chunk_idx,
                            chunk_content=chunk_text,
                        )
            except Exception as e:
                logger.error(f"[FileContentParser] LLM error for chunk {chunk_idx}: {e}")

            # Fallback to raw chunk
            logger.warning(f"[FileContentParser] Fallback to raw for chunk {chunk_idx}")
            return _make_fallback(chunk_idx, chunk_text)

        # Process chunks concurrently with progress bar
        memory_items = []
        chunk_map = dict(valid_chunks)
        total_chunks = len(valid_chunks)

        logger.info(f"[FileContentParser] Processing {total_chunks} chunks with LLM...")

        with ContextThreadPoolExecutor(max_workers=20) as executor:
            futures = {
                executor.submit(_process_chunk, idx, text): idx for idx, text in valid_chunks
            }

            # Use tqdm for progress bar (similar to simple_struct.py _process_doc_data)
            for future in tqdm(
                concurrent.futures.as_completed(futures),
                total=total_chunks,
                desc="[FileContentParser] Processing chunks",
            ):
                chunk_idx = futures[future]
                try:
                    node = future.result()
                    if node:
                        memory_items.append(node)
                except Exception as e:
                    tqdm.write(f"[ERROR] Chunk {chunk_idx} failed: {e}")
                    logger.error(f"[FileContentParser] Future failed for chunk {chunk_idx}: {e}")
                    # Create fallback for failed future
                    if chunk_idx in chunk_map:
                        memory_items.append(
                            _make_fallback(chunk_idx, chunk_map[chunk_idx], "error")
                        )

        logger.info(
            f"[FileContentParser] Completed processing {len(memory_items)}/{total_chunks} chunks"
        )

        return memory_items or [
            _make_memory_item(
                value=parsed_text or "[File: empty content]",
                tags=["mode:fine", "multimodal:file"],
                chunk_idx=None,
            )
        ]
