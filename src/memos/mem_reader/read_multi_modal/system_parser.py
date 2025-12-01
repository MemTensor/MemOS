"""Parser for system messages."""

import json
import re
import uuid

from typing import Any

from memos.embedders.base import BaseEmbedder
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.types.openai_chat_completion_types import ChatCompletionSystemMessageParam

from .base import BaseMessageParser


logger = get_logger(__name__)


class SystemParser(BaseMessageParser):
    """Parser for system messages."""

    def __init__(self, embedder: BaseEmbedder, llm: BaseLLM | None = None):
        """
        Initialize SystemParser.

        Args:
            embedder: Embedder for generating embeddings
            llm: Optional LLM for fine mode processing
        """
        super().__init__(embedder, llm)

    def create_source(
        self,
        message: str,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from system message."""
        tool_schema_match = re.search(r"<tool_schema>(.*?)</tool_schema>", message, re.DOTALL)
        tool_schema_content = tool_schema_match.group(1) if tool_schema_match else ""

        return SourceMessage(
            type="chat",
            role="system",
            chat_time=message.get("chat_time", None),
            message_id=message.get("message_id", None),
            content=tool_schema_content,
        )

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionSystemMessageParam:
        """Rebuild system message from SourceMessage."""
        return {
            "role": "system",
            "content": source.content or "",
            "chat_time": source.chat_time,
            "message_id": source.message_id,
        }

    def parse_fast(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        content = message["content"]
        if isinstance(content, dict):
            content = content["text"]

        # Extract tool_schema content and remaining content
        content_wo_tool_schema = re.sub(
            r"<tool_schema>(.*?)</tool_schema>",
            r"<tool_schema>omitted</tool_schema>",
            content,
            flags=re.DOTALL,
        )

        source = self.create_source(content, info)
        return [
            TextualMemoryItem(
                memory=content_wo_tool_schema,
                metadata=TreeNodeTextualMemoryMetadata(
                    memory_type="LongTermMemory",
                    status="activated",
                    tags=["mode:fast"],
                    sources=[source],
                ),
            )
        ]

    def parse_fine(
        self,
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
        **kwargs,
    ) -> list[TextualMemoryItem]:
        content = message["content"]
        if isinstance(content, dict):
            content = content["text"]
        try:
            tool_schema = json.loads(content)
            assert isinstance(tool_schema, list), "Tool schema must be a list"
        except json.JSONDecodeError:
            return []

        return [
            TextualMemoryItem(
                id=str(uuid.uuid4()),
                memory=json.dumps(tool_schema),
                metadata=TreeNodeTextualMemoryMetadata(
                    memory_type="tool_schema",
                ),
            )
        ]
