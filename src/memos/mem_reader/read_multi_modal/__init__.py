"""Multimodal message parsers for different message types.

This package provides parsers for different message types in both fast and fine modes:
- String messages
- System messages
- User messages
- Assistant messages
- Tool messages
- Text content parts
- File content parts

Each parser supports both "fast" mode (quick processing without LLM) and
"fine" mode (with LLM for better understanding).
"""

from .assistant_parser import AssistantParser
from .base import BaseMessageParser
from .file_content_parser import FileContentParser
from .image_parser import ImageParser
from .multi_modal_parser import MultiModalParser
from .string_parser import StringParser
from .system_parser import SystemParser
from .text_content_parser import TextContentParser
from .tool_parser import ToolParser
from .user_parser import UserParser
from .utils import coerce_scene_data, detect_lang, extract_role


__all__ = [
    "AssistantParser",
    "BaseMessageParser",
    "FileContentParser",
    "ImageParser",
    "MultiModalParser",
    "StringParser",
    "SystemParser",
    "TextContentParser",
    "ToolParser",
    "UserParser",
    "coerce_scene_data",
    "detect_lang",
    "extract_role",
]
