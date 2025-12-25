"""Utility functions for message parsing."""

import json
import os
import re

from datetime import datetime
from typing import Any, TypeAlias
from urllib.parse import urlparse

from memos import log
from memos.configs.parser import ParserConfigFactory
from memos.parsers.factory import ParserFactory
from memos.types import MessagesType
from memos.types.openai_chat_completion_types import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionContentPartTextParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam,
    File,
)


ChatMessageClasses = (
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionAssistantMessageParam,
    ChatCompletionToolMessageParam,
)

RawContentClasses = (ChatCompletionContentPartTextParam, File)
MessageDict: TypeAlias = dict[str, Any]  # (Deprecated) not supported in the future
SceneDataInput: TypeAlias = (
    list[list[MessageDict]]  # (Deprecated) legacy chat example: scenes -> messages
    | list[str]  # (Deprecated) legacy doc example: list of paths / pure text
    | list[MessagesType]  # new: list of scenes (each scene is MessagesType)
)


logger = log.get_logger(__name__)
FILE_EXT_RE = re.compile(
    r"\.(pdf|docx?|pptx?|xlsx?|txt|md|html?|json|csv|png|jpe?g|webp|wav|mp3|m4a)$",
    re.I,
)


def parse_json_result(response_text: str) -> dict:
    """
    Parse JSON result from LLM response.

    Handles various formats including:
    - JSON wrapped in markdown code blocks
    - Raw JSON
    - Incomplete JSON (attempts to fix)

    Args:
        response_text: Raw response text from LLM

    Returns:
        Parsed dictionary or empty dict if parsing fails
    """
    s = (response_text or "").strip()

    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, flags=re.I)
    s = (m.group(1) if m else s.replace("```", "")).strip()

    i = s.find("{")
    if i == -1:
        return {}
    s = s[i:].strip()

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    j = max(s.rfind("}"), s.rfind("]"))
    if j != -1:
        try:
            return json.loads(s[: j + 1])
        except json.JSONDecodeError:
            pass

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
        logger.error(f"[JSONParse] Failed to decode JSON: {e}\nRaw: {response_text}")
        return {}


# Default configuration for parser and text splitter
DEFAULT_PARSER_CONFIG = {
    "backend": "markitdown",
    "config": {},
}

DEFAULT_CHUNK_SIZE = int(os.getenv("FILE_PARSER_CHUNK_SIZE", "1000"))
DEFAULT_CHUNK_OVERLAP = int(os.getenv("FILE_PARSER_CHUNK_OVERLAP", "200"))


# Initialize parser instance
file_parser = None
try:
    parser_config = ParserConfigFactory.model_validate(DEFAULT_PARSER_CONFIG)
    file_parser = ParserFactory.from_config(parser_config)
    logger.debug("[FileContentParser] Initialized parser instance")
except Exception as e:
    logger.error(f"[FileContentParser] Failed to create parser: {e}")
    file_parser = None

markdown_text_splitter = None

try:
    from memos.chunkers.charactertext_chunker import CharacterTextChunker
    from memos.chunkers.markdown_chunker import MarkdownChunker

    markdown_text_splitter = MarkdownChunker(
        chunk_size=DEFAULT_CHUNK_SIZE, chunk_overlap=DEFAULT_CHUNK_OVERLAP, recursive=True
    )
    text_splitter = CharacterTextChunker(
        chunk_size=DEFAULT_CHUNK_SIZE, chunk_overlap=DEFAULT_CHUNK_OVERLAP
    )
    logger.info("[FileContentParser] Initialized text splitter instances by lancga")
except Exception as e:
    logger.warning(
        f"[FileContentParser] Failed to create text splitter: {e} will use simple splitter fallback"
    )
    from memos.chunkers.simple_chunker import SimpleTextSplitter

    markdown_text_splitter = None
    text_splitter = None


def get_parser() -> Any:
    """
    Get parser instance.

    Returns:
        Parser instance (from ParserFactory) or None if not available
    """
    return file_parser


def get_text_splitter(
    chunk_size: int | None = None, chunk_overlap: int | None = None, is_markdown: bool = False
) -> Any:
    """
    Get text splitter instance or a callable that uses simple splitter.

    Args:
        chunk_size: Maximum size of chunks when splitting text (used for simple splitter fallback)
        chunk_overlap: Overlap between chunks when splitting text (used for simple splitter fallback)

    Returns:
        Text splitter instance (RecursiveCharacterTextSplitter) or a callable wrapper for simple splitter
    """
    if is_markdown and markdown_text_splitter is not None:
        return markdown_text_splitter
    elif text_splitter is not None:
        return text_splitter
    else:
        actual_chunk_size = chunk_size or DEFAULT_CHUNK_SIZE
        actual_chunk_overlap = chunk_overlap or DEFAULT_CHUNK_OVERLAP
        return SimpleTextSplitter(actual_chunk_size, actual_chunk_overlap)


def extract_role(message: dict[str, Any]) -> str:
    """Extract role from message."""
    return message.get("role", "")


def _is_message_list(obj):
    """
    Detect whether `obj` is a MessageList (OpenAI ChatCompletionMessageParam list).
    Criteria:
    - Must be a list
    - Each element must be a dict with keys: role, content
    """
    if not isinstance(obj, list):
        return False

    for item in obj:
        if not isinstance(item, dict):
            return False
        if "role" not in item or "content" not in item:
            return False
    return True


def coerce_scene_data(scene_data: SceneDataInput, scene_type: str) -> list[MessagesType]:
    """
    Normalize ANY allowed SceneDataInput into: list[MessagesType].
    Supports:
    - Already normalized scene_data → passthrough
    - doc: legacy list[str] → automatically detect:
        * local file path  → read & parse into text
        * remote URL/path  → keep as file part
        * pure text        → text part
    - chat:
        * Passthrough normalization
        * Auto-inject chat_time into each message group
    - fallback: wrap unknown → [str(scene_data)]
    """
    if not scene_data:
        return []
    head = scene_data[0]

    if scene_type != "doc":
        normalized = scene_data if isinstance(head, str | list) else [str(scene_data)]

        complete_scene_data = []
        for items in normalized:
            if not items:
                continue

            # Keep string as-is (MessagesType supports str)
            if isinstance(items, str):
                complete_scene_data.append(items)
                continue

            # ONLY add chat_time if it's a MessageList
            if not _is_message_list(items):
                complete_scene_data.append(items)
                continue

            # Detect existing chat_time
            chat_time_value = None
            for item in items:
                if isinstance(item, dict) and "chat_time" in item:
                    chat_time_value = item["chat_time"]
                    break

            # Default timestamp
            if chat_time_value is None:
                session_date = datetime.now()
                date_format = "%I:%M %p on %d %B, %Y"
                chat_time_value = session_date.strftime(date_format)

            # Inject chat_time
            for m in items:
                if isinstance(m, dict) and "chat_time" not in m:
                    m["chat_time"] = chat_time_value

            complete_scene_data.append(items)

        return complete_scene_data

    # doc: list[str] -> RawMessageList
    if scene_type == "doc" and isinstance(head, str):
        raw_items = []

        # prepare parser
        parser_config = ParserConfigFactory.model_validate(
            {
                "backend": "markitdown",
                "config": {},
            }
        )
        parser = ParserFactory.from_config(parser_config)

        for s in scene_data:
            s = (s or "").strip()
            if not s:
                continue

            parsed = urlparse(s)
            looks_like_url = parsed.scheme in {"http", "https", "oss", "s3", "gs", "cos"}
            looks_like_path = ("/" in s) or ("\\" in s)
            looks_like_file = bool(FILE_EXT_RE.search(s)) or looks_like_url or looks_like_path

            # Case A: Local filesystem path
            if os.path.exists(s):
                filename = os.path.basename(s) or "document"
                try:
                    # parse local file into text
                    parsed_text = parser.parse(s)
                    raw_items.append(
                        [
                            {
                                "type": "file",
                                "file": {
                                    "filename": filename or "document",
                                    "file_data": parsed_text,
                                },
                            }
                        ]
                    )
                except Exception as e:
                    logger.error(f"[SceneParser] Error parsing {s}: {e}")
                continue

            # Case B: URL or non-local file path
            if looks_like_file:
                if looks_like_url:
                    filename = os.path.basename(parsed.path)
                else:
                    # Windows absolute path detection
                    if "\\" in s and re.match(r"^[A-Za-z]:", s):
                        parts = [p for p in s.split("\\") if p]
                        filename = parts[-1] if parts else os.path.basename(s)
                    else:
                        filename = os.path.basename(s)
                raw_items.append(
                    [{"type": "file", "file": {"filename": filename or "document", "file_data": s}}]
                )
                continue

            # Case C: Pure text
            raw_items.append([{"type": "text", "text": s}])

        return raw_items

    # fallback
    return [str(scene_data)]


def detect_lang(text):
    """
    Detect the language of the given text (Chinese or English).

    Args:
        text: Text to analyze

    Returns:
        "zh" for Chinese, "en" for English (default)
    """
    try:
        if not text or not isinstance(text, str):
            return "en"
        cleaned_text = text
        # remove role and timestamp
        cleaned_text = re.sub(
            r"\b(user|assistant|query|answer)\s*:", "", cleaned_text, flags=re.IGNORECASE
        )
        cleaned_text = re.sub(r"\[[\d\-:\s]+\]", "", cleaned_text)

        # extract chinese characters
        chinese_pattern = r"[\u4e00-\u9fff\u3400-\u4dbf\U00020000-\U0002a6df\U0002a700-\U0002b73f\U0002b740-\U0002b81f\U0002b820-\U0002ceaf\uf900-\ufaff]"
        chinese_chars = re.findall(chinese_pattern, cleaned_text)
        text_without_special = re.sub(r"[\s\d\W]", "", cleaned_text)
        if text_without_special and len(chinese_chars) / len(text_without_special) > 0.3:
            return "zh"
        return "en"
    except Exception:
        return "en"
