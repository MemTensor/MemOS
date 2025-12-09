"""Parser for image_url content parts."""

import json
import re

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.templates.mem_reader_prompts import IMAGE_ANALYSIS_PROMPT_EN, IMAGE_ANALYSIS_PROMPT_ZH
from memos.types.openai_chat_completion_types import ChatCompletionContentPartImageParam

from .base import BaseMessageParser, _derive_key
from .utils import detect_lang


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
                content=url,
                url=url,
                detail=detail,
            )
        return SourceMessage(type="image", content=str(message))

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionContentPartImageParam:
        """Rebuild image_url content part from SourceMessage."""
        # Rebuild from source fields
        url = (
            getattr(source, "url", "")
            or getattr(source, "image_path", "")
            or (source.content or "").replace("[image_url]: ", "")
        )
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
        """
        Parse image_url in fine mode using vision models to extract information from images.

        Args:
            message: Image message to parse
            info: Dictionary containing user_id and session_id
            **kwargs: Additional parameters (e.g., context_items, custom_tags)

        Returns:
            List of TextualMemoryItem objects extracted from the image
        """
        if not self.llm:
            logger.warning("[ImageParser] LLM not available for fine mode processing")
            return []

        # Extract image information
        if not isinstance(message, dict):
            logger.warning(f"[ImageParser] Expected dict, got {type(message)}")
            return []

        image_url = message.get("image_url", {})
        if isinstance(image_url, dict):
            url = image_url.get("url", "")
            detail = image_url.get("detail", "auto")
        else:
            url = str(image_url)
            detail = "auto"

        if not url:
            logger.warning("[ImageParser] No image URL found in message")
            return []

        # Create source for this image
        source = self.create_source(message, info)

        # Get context items if available
        context_items = kwargs.get("context_items")

        # Determine language from context if available
        lang = "en"
        if context_items:
            for item in context_items:
                if hasattr(item, "memory") and item.memory:
                    lang = detect_lang(item.memory)
                    break

        # Select prompt based on language
        image_analysis_prompt = (
            IMAGE_ANALYSIS_PROMPT_ZH if lang == "zh" else IMAGE_ANALYSIS_PROMPT_EN
        )

        # Build messages with image content
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": image_analysis_prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": url,
                            "detail": detail,
                        },
                    },
                ],
            }
        ]

        # Add context if available
        if context_items:
            context_text = ""
            for item in context_items:
                if hasattr(item, "memory") and item.memory:
                    context_text += f"{item.memory}\n"
            if context_text:
                messages.insert(
                    0,
                    {
                        "role": "system",
                        "content": f"Context from previous conversation:\n{context_text}",
                    },
                )

        try:
            # Call LLM with vision model
            response_text = self.llm.generate(messages)
            if not response_text:
                logger.warning("[ImageParser] Empty response from LLM")
                return []

            # Parse JSON response
            response_json = self._parse_json_result(response_text)

            # Extract memory items from response
            memory_items = []
            memory_list = response_json.get("memory list", [])

            if not memory_list:
                logger.warning("[ImageParser] No memory items extracted from image")
                # Fallback: create a simple memory item with the summary
                summary = response_json.get(
                    "summary", "Image analyzed but no specific memories extracted."
                )
                if summary:
                    memory_items.append(
                        self._create_memory_item(
                            value=summary,
                            info=info,
                            memory_type="LongTermMemory",
                            tags=["image", "visual"],
                            key=_derive_key(summary),
                            sources=[source],
                            background=summary,
                        )
                    )
                return memory_items

            # Create memory items from parsed response
            for mem_data in memory_list:
                try:
                    # Normalize memory_type
                    memory_type = (
                        mem_data.get("memory_type", "LongTermMemory")
                        .replace("长期记忆", "LongTermMemory")
                        .replace("用户记忆", "UserMemory")
                    )
                    if memory_type not in ["LongTermMemory", "UserMemory"]:
                        memory_type = "LongTermMemory"

                    value = mem_data.get("value", "").strip()
                    if not value:
                        continue

                    tags = mem_data.get("tags", [])
                    if not isinstance(tags, list):
                        tags = []
                    # Add image-related tags
                    if "image" not in [t.lower() for t in tags]:
                        tags.append("image")
                    if "visual" not in [t.lower() for t in tags]:
                        tags.append("visual")

                    key = mem_data.get("key", "")
                    background = response_json.get("summary", "")

                    memory_item = self._create_memory_item(
                        value=value,
                        info=info,
                        memory_type=memory_type,
                        tags=tags,
                        key=key if key else _derive_key(value),
                        sources=[source],
                        background=background,
                    )
                    memory_items.append(memory_item)
                except Exception as e:
                    logger.error(f"[ImageParser] Error creating memory item: {e}")
                    continue

            return memory_items

        except Exception as e:
            logger.error(f"[ImageParser] Error processing image in fine mode: {e}")
            # Fallback: create a simple memory item
            fallback_value = f"Image analyzed: {url}"
            return [
                self._create_memory_item(
                    value=fallback_value,
                    info=info,
                    memory_type="LongTermMemory",
                    tags=["image", "visual"],
                    key=_derive_key(fallback_value),
                    sources=[source],
                    background="Image processing encountered an error.",
                )
            ]

    def _parse_json_result(self, response_text: str) -> dict:
        """
        Parse JSON result from LLM response.
        Similar to SimpleStructMemReader.parse_json_result.
        """
        s = (response_text or "").strip()

        # Try to extract JSON from code blocks
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, flags=re.I)
        s = (m.group(1) if m else s.replace("```", "")).strip()

        # Find first {
        i = s.find("{")
        if i == -1:
            return {}
        s = s[i:].strip()

        try:
            return json.loads(s)
        except json.JSONDecodeError:
            pass

        # Try to find the last } or ]
        j = max(s.rfind("}"), s.rfind("]"))
        if j != -1:
            try:
                return json.loads(s[: j + 1])
            except json.JSONDecodeError:
                pass

        # Try to close brackets
        def _cheap_close(t: str) -> str:
            t += "}" * max(0, t.count("{") - t.count("}"))
            t += "]" * max(0, t.count("[") - t.count("]"))
            return t

        t = _cheap_close(s)
        try:
            return json.loads(t)
        except json.JSONDecodeError as e:
            if "Invalid \\escape" in str(e):
                s = s.replace("\\", "\\\\")
                try:
                    return json.loads(s)
                except json.JSONDecodeError:
                    pass
            logger.error(f"[ImageParser] Failed to parse JSON: {e}\nResponse: {response_text}")
            return {}

    def _create_memory_item(
        self,
        value: str,
        info: dict[str, Any],
        memory_type: str,
        tags: list[str],
        key: str,
        sources: list[SourceMessage],
        background: str = "",
    ) -> TextualMemoryItem:
        """Create a TextualMemoryItem with the given parameters."""
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        return TextualMemoryItem(
            memory=value,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type=memory_type,
                status="activated",
                tags=tags,
                key=key,
                embedding=self.embedder.embed([value])[0],
                usage=[],
                sources=sources,
                background=background,
                confidence=0.99,
                type="fact",
                info=info_,
            ),
        )
