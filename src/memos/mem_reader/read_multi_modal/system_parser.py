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

        # Find first tool_schema block
        tool_schema_pattern = r"<tool_schema>(.*?)</tool_schema>"
        match = re.search(tool_schema_pattern, content, flags=re.DOTALL)

        if match:
            original_text = match.group(0)  # Complete <tool_schema>...</tool_schema> block
            schema_content = match.group(1)  # Content between the tags

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

                def remove_descriptions(obj):
                    """Recursively remove all 'description' keys from a nested dict/list structure."""
                    if isinstance(obj, dict):
                        return {
                            k: remove_descriptions(v) for k, v in obj.items() if k != "description"
                        }
                    elif isinstance(obj, list):
                        return [remove_descriptions(item) for item in obj]
                    else:
                        return obj

                def keep_first_layer_params(obj):
                    """Only keep first layer parameter information, remove nested parameters."""
                    if isinstance(obj, list):
                        return [keep_first_layer_params(item) for item in obj]
                    elif isinstance(obj, dict):
                        result = {}
                        for k, v in obj.items():
                            if k == "properties" and isinstance(v, dict):
                                # For properties, only keep first layer parameter names and types
                                first_layer_props = {}
                                for param_name, param_info in v.items():
                                    if isinstance(param_info, dict):
                                        # Only keep type and basic info, remove nested properties
                                        first_layer_props[param_name] = {
                                            key: val
                                            for key, val in param_info.items()
                                            if key in ["type", "enum", "required"]
                                            and key != "properties"
                                        }
                                    else:
                                        first_layer_props[param_name] = param_info
                                result[k] = first_layer_props
                            elif k == "parameters" and isinstance(v, dict):
                                # Process parameters object but only keep first layer
                                result[k] = keep_first_layer_params(v)
                            elif isinstance(v, dict | list) and k != "properties":
                                result[k] = keep_first_layer_params(v)
                            else:
                                result[k] = v
                        return result
                    else:
                        return obj

                def format_tool_schema_readable(tool_schema):
                    """Convert tool schema to readable format: tool_name: [param1 (type1), ...](required: ...)"""
                    lines = []
                    for tool in tool_schema:
                        # Handle both new format and old-style OpenAI function format
                        if tool.get("type") == "function" and "function" in tool:
                            tool_info = tool["function"]
                        else:
                            tool_info = tool

                        tool_name = tool_info.get("name", "unknown")
                        params_obj = tool_info.get("parameters", {})
                        properties = params_obj.get("properties", {})
                        required = params_obj.get("required", [])

                        # Format parameters
                        param_strs = []
                        for param_name, param_info in properties.items():
                            if isinstance(param_info, dict):
                                param_type = param_info.get("type", "any")
                                # Handle enum
                                if "enum" in param_info:
                                    param_type = f"{param_type}[{', '.join(param_info['enum'])}]"
                                param_strs.append(f"{param_name} ({param_type})")
                            else:
                                param_strs.append(f"{param_name} (any)")

                        # Format required parameters
                        required_str = f"(required: {', '.join(required)})" if required else ""

                        # Construct the line
                        params_part = f"[{', '.join(param_strs)}]" if param_strs else "[]"
                        line = f"{tool_name}: {params_part}{required_str}"
                        lines.append(line)

                    return "\n".join(lines)

                # First keep only first layer params, then remove descriptions
                simple_tool_schema = keep_first_layer_params(tool_schema)
                simple_tool_schema = remove_descriptions(simple_tool_schema)
                # change to readable format
                readable_schema = format_tool_schema_readable(simple_tool_schema)

                processed_text = f"<tool_schema>{readable_schema}</tool_schema>"
                content = content.replace(original_text, processed_text, 1)

            parts = ["system: "]
            if message.get("chat_time"):
                parts.append(f"[{message.get('chat_time')}]: ")
            prefix = "".join(parts)
            line = f"{prefix}{content}\n"

        source = self.create_source(message, info)

        # Extract info fields
        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        # Split parsed text into chunks
        content_chunks = self._split_text(line)

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
