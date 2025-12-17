"""Parser for system messages."""

import ast
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
        message: ChatCompletionSystemMessageParam,
        info: dict[str, Any],
    ) -> SourceMessage:
        """Create SourceMessage from system message."""
        content = message["content"]
        if isinstance(content, dict):
            content = content["text"]

        content_wo_tool_schema = re.sub(
            r"<tool_schema>(.*?)</tool_schema>",
            r"<tool_schema>omitted</tool_schema>",
            content,
            flags=re.DOTALL,
        )
        tool_schema_match = re.search(r"<tool_schema>(.*?)</tool_schema>", content, re.DOTALL)
        tool_schema_content = tool_schema_match.group(1) if tool_schema_match else ""

        return SourceMessage(
            type="chat",
            role="system",
            chat_time=message.get("chat_time", None),
            message_id=message.get("message_id", None),
            content=content_wo_tool_schema,
            tool_schema=tool_schema_content,
        )

    def rebuild_from_source(
        self,
        source: SourceMessage,
    ) -> ChatCompletionSystemMessageParam:
        """Rebuild system message from SourceMessage."""
        # only rebuild tool schema content, content will be used in full chat content by llm
        return {
            "role": "system",
            "content": source.tool_schema or "",
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

        # Process tool_schema content
        content_wo_tool_schema = content

        # Find first tool_schema block
        tool_schema_pattern = r"<tool_schema>(.*?)</tool_schema>"
        match = re.search(tool_schema_pattern, content, flags=re.DOTALL)

        if match:
            original_text = match.group(0)  # 完整的 <tool_schema>...</tool_schema>
            schema_content = match.group(1)  # 标签之间的内容

            # Parse tool schema
            try:
                tool_schema = json.loads(schema_content)
                assert isinstance(tool_schema, list), "Tool schema must be a list[dict]"
            except json.JSONDecodeError:
                try:
                    tool_schema = ast.literal_eval(schema_content)
                    assert isinstance(tool_schema, list), "Tool schema must be a list[dict]"
                except (ValueError, SyntaxError, AssertionError):
                    logger.warning(
                        f"[SystemParser] Failed to parse tool schema with both JSON and ast.literal_eval: {schema_content[:100]}..."
                    )
                    tool_schema = None
            except AssertionError:
                logger.warning(
                    f"[SystemParser] Tool schema must be a list[dict]: {schema_content[:100]}..."
                )
                tool_schema = None

            # Process and replace
            if tool_schema is not None:
                processed_text = f"<tool_schema>{json.dumps(tool_schema)}</tool_schema>"
                content_wo_tool_schema = content_wo_tool_schema.replace(
                    original_text, processed_text, 1
                )

        source = self.create_source(message, info)

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # Split parsed text into chunks
        content_chunks = self._split_text(content_wo_tool_schema)

        memory_items = []
        for _chunk_idx, chunk_text in enumerate(content_chunks):
            if not chunk_text.strip():
                continue

            memory_item = TextualMemoryItem(
                memory=chunk_text,
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type="LongTermMemory",  # only choce long term memory for system messages as a placeholder
                    status="activated",
                    tags=["mode:fast"],
                    sources=[source],
                    info=info_,
                ),
            )
            memory_items.append(memory_item)
        return memory_items

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
            assert isinstance(tool_schema, list), "Tool schema must be a list[dict]"
        except json.JSONDecodeError:
            try:
                tool_schema = ast.literal_eval(content)
                assert isinstance(tool_schema, list), "Tool schema must be a list[dict]"
            except (ValueError, SyntaxError, AssertionError):
                logger.warning(
                    f"[SystemParser] Failed to parse tool schema with both JSON and ast.literal_eval: {content}"
                )
                return []
        except AssertionError:
            logger.warning(f"[SystemParser] Tool schema must be a list[dict]: {content}")
            return []

        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        return [
            TextualMemoryItem(
                id=str(uuid.uuid4()),
                memory=json.dumps(schema),
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=user_id,
                    session_id=session_id,
                    memory_type="ToolSchemaMemory",
                    status="activated",
                    embedding=self.embedder.embed([json.dumps(schema)])[0],
                    info=info_,
                ),
            )
            for schema in tool_schema
        ]
