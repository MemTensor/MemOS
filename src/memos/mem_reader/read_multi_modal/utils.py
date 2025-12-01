"""Utility functions for message parsing."""

import os
import re

from datetime import datetime, timezone
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
                session_date = datetime.now(timezone.utc)
                date_format = "%I:%M %p on %d %B, %Y UTC"
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
