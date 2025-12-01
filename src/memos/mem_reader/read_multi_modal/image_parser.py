"""Parser for image_url content parts."""

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import SourceMessage, TextualMemoryItem
from memos.types.openai_chat_completion_types import ChatCompletionContentPartImageParam

from .base import BaseMessageParser


logger = get_logger(__name__)


class ImageParser(BaseMessageParser):
    """Parser for image_url content parts."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize ImageParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: ChatCompletionContentPartImageParam,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from image_url content part."""
        if isinstance(message, dict):
            image_url = message.get("image_url", {})
            if isinstance(image_url, dict):
                url = image_url.get("url", "")
                detail = image_url.get("detail", "auto")
            else:
                url = str(image_url)
                detail = "auto"
            return SourceMessage(
                type="image",
                content=f"[image_url]: {url}",
                original_part=message,
                url=url,
                detail=detail,
            )
        return SourceMessage(type="image", content=str(message))

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionContentPartImageParam:
        """Rebuild image_url content part from SourceMessage."""
        # Use original_part if available
        if hasattr(source, "original_part") and source.original_part:
            return source.original_part

        # Rebuild from source fields
        url = getattr(source, "url", "") or (source.content or "").replace("[image_url]: ", "")
        detail = getattr(source, "detail", "auto")
        return {
            "type": "image_url",
            "image_url": {
                "url": url,
                "detail": detail,
            },
        }

    def parse_fast(
        self,
        message: ChatCompletionContentPartImageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """Parse image_url in fast mode - returns empty list as images need fine mode processing."""
        # In fast mode, images are not processed (they need vision models)
        # They will be processed in fine mode via process_transfer
        return []

    def parse_fine(
        self,
        message: ChatCompletionContentPartImageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        """Parse image_url in fine mode - placeholder for future vision model integration."""
        # Fine mode processing would use vision models to extract text from images
        # For now, return empty list
        return []
