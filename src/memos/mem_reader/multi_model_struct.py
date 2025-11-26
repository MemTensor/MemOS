import concurrent.futures
import os
import re

from abc import ABC
from typing import Any, TypeAlias
from urllib.parse import urlparse

from memos import log
from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.base import BaseMemReader
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.templates.mem_reader_prompts import (
    SIMPLE_STRUCT_DOC_READER_PROMPT,
    SIMPLE_STRUCT_DOC_READER_PROMPT_ZH,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE_ZH,
    SIMPLE_STRUCT_MEM_READER_PROMPT,
    SIMPLE_STRUCT_MEM_READER_PROMPT_ZH,
)
from memos.types import MessagesType
from memos.types.openai_chat_completion_types import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionContentPartTextParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam,
    File,
)
from memos.utils import timed


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
PROMPT_DICT = {
    "chat": {
        "en": SIMPLE_STRUCT_MEM_READER_PROMPT,
        "zh": SIMPLE_STRUCT_MEM_READER_PROMPT_ZH,
        "en_example": SIMPLE_STRUCT_MEM_READER_EXAMPLE,
        "zh_example": SIMPLE_STRUCT_MEM_READER_EXAMPLE_ZH,
    },
    "doc": {"en": SIMPLE_STRUCT_DOC_READER_PROMPT, "zh": SIMPLE_STRUCT_DOC_READER_PROMPT_ZH},
}
FILE_EXT_RE = re.compile(
    r"\.(pdf|docx?|pptx?|xlsx?|txt|md|html?|json|csv|png|jpe?g|webp|wav|mp3|m4a)$",
    re.I,
)

try:
    import tiktoken

    try:
        _ENC = tiktoken.encoding_for_model("gpt-4o-mini")
    except Exception:
        _ENC = tiktoken.get_encoding("cl100k_base")

    def _count_tokens_text(s: str) -> int:
        return len(_ENC.encode(s or ""))
except Exception:
    # Heuristic fallback: zh chars ~1 token, others ~1 token per ~4 chars
    def _count_tokens_text(s: str) -> int:
        if not s:
            return 0
        zh_chars = re.findall(r"[\u4e00-\u9fff]", s)
        zh = len(zh_chars)
        rest = len(s) - zh
        return zh + max(1, rest // 4)


def detect_lang(text):
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


def _derive_key(text: str, max_len: int = 80) -> str:
    """default key when without LLM: first max_len words"""
    if not text:
        return ""
    sent = re.split(r"[。！？!?]\s*|\n", text.strip())[0]
    return (sent[:max_len]).strip()


def _coerce_scene_data(scene_data, type: str) -> list[MessagesType]:
    """
    Normalize ANY allowed SceneDataInput into: list[MessagesType].
    """
    if not scene_data:
        return []
    head = scene_data[0]
    if isinstance(head, str | list) and not (type == "doc" and isinstance(head, str)):
        # For type="doc" AND head is str, this is legacy doc list[str], handle below instead.
        return scene_data

    # doc: list[str] -> RawMessageList
    if type == "doc" and isinstance(head, str):
        raw_items = []
        for s in scene_data:
            s = (s or "").strip()
            parsed = urlparse(s)
            looks_like_url = parsed.scheme in {"http", "https", "oss", "s3", "gs", "cos"}
            # treat as file if it looks like a path, a URL, or a known extension.
            looks_like_path = ("/" in s) or ("\\" in s)
            looks_like_file = bool(FILE_EXT_RE.search(s)) or looks_like_url or looks_like_path

            if looks_like_file:
                if looks_like_url:
                    filename = os.path.basename(parsed.path)
                else:
                    # Handle Windows paths (e.g., "C:\Users\Documents\file.txt")
                    # On Unix, os.path.basename doesn't recognize backslashes as separators
                    if "\\" in s and re.match(r"^[A-Za-z]:", s):
                        # Windows absolute path: extract filename after last backslash
                        # Split on backslashes and take the last non-empty part
                        parts = [p for p in s.split("\\") if p]
                        filename = parts[-1] if parts else os.path.basename(s)
                    else:
                        filename = os.path.basename(s)
                raw_items.append(
                    {"type": "file", "file": {"path": s, "filename": filename or "document"}}
                )
            else:
                raw_items.append({"type": "text", "text": s})
        return [raw_items]
    # Keep a tiny fallback for robustness.
    return [str(scene_data)]


def _get_simple_scene_data(scene_data: list[MessagesType]) -> list[MessagesType]:
    """Only get Simple File and Simple Chat"""


class SimpleStructMemReader(BaseMemReader, ABC):
    """Naive implementation of MemReader."""

    def __init__(self, config: SimpleStructMemReaderConfig):
        """
        Initialize the NaiveMemReader with configuration.

        Args:
            config: Configuration object for the reader
        """
        self.config = config
        self.llm = LLMFactory.from_config(config.llm)
        self.embedder = EmbedderFactory.from_config(config.embedder)
        self.chunker = ChunkerFactory.from_config(config.chunker)
        self.memory_max_length = 8000
        # Use token-based windowing; default to ~5000 tokens if not configured
        self.chat_window_max_tokens = getattr(self.config, "chat_window_max_tokens", 1024)
        self._count_tokens = _count_tokens_text

    def _make_memory_item(
        self,
        value: str,
        info: dict,
        memory_type: str,
        tags: list[str] | None = None,
        key: str | None = None,
        sources: list | None = None,
        background: str = "",
        type_: str = "fact",
        confidence: float = 0.99,
    ) -> TextualMemoryItem:
        """construct memory item"""
        return TextualMemoryItem(
            memory=value,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=info.get("user_id", ""),
                session_id=info.get("session_id", ""),
                memory_type=memory_type,
                status="activated",
                tags=tags or [],
                key=key if key is not None else _derive_key(value),
                embedding=self.embedder.embed([value])[0],
                usage=[],
                sources=sources or [],
                background=background,
                confidence=confidence,
                type=type_,
            ),
        )

    def _get_llm_response(self, mem_str: str) -> dict:
        lang = detect_lang(mem_str)
        template = PROMPT_DICT["chat"][lang]
        examples = PROMPT_DICT["chat"][f"{lang}_example"]
        prompt = template.replace("${conversation}", mem_str)
        if self.config.remove_prompt_example:
            prompt = prompt.replace(examples, "")
        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages)
            response_json = self.parse_json_result(response_text)
        except Exception as e:
            logger.error(f"[LLM] Exception during chat generation: {e}")
            response_json = {
                "memory list": [
                    {
                        "key": mem_str[:10],
                        "memory_type": "UserMemory",
                        "value": mem_str,
                        "tags": [],
                    }
                ],
                "summary": mem_str,
            }
        return response_json

    def _iter_chat_windows(self, scene_data_info, max_tokens=None, overlap=200):
        """
        use token counter to get a slide window generator
        """
        max_tokens = max_tokens or self.chat_window_max_tokens
        buf, sources, start_idx = [], [], 0
        cur_text = ""
        for idx, item in enumerate(scene_data_info):
            role = item.get("role", "")
            content = item.get("content", "")
            chat_time = item.get("chat_time", None)
            parts = []
            if role and str(role).lower() != "mix":
                parts.append(f"{role}: ")
            if chat_time:
                parts.append(f"[{chat_time}]: ")
            prefix = "".join(parts)
            line = f"{prefix}{content}\n"

            if self._count_tokens(cur_text + line) > max_tokens and cur_text:
                text = "".join(buf)
                yield {"text": text, "sources": sources.copy(), "start_idx": start_idx}
                while buf and self._count_tokens("".join(buf)) > overlap:
                    buf.pop(0)
                    sources.pop(0)
                start_idx = idx
                cur_text = "".join(buf)

            buf.append(line)
            sources.append(
                {
                    "type": "chat",
                    "index": idx,
                    "role": role,
                    "chat_time": chat_time,
                    "content": content,
                }
            )
            cur_text = "".join(buf)

        if buf:
            yield {"text": "".join(buf), "sources": sources.copy(), "start_idx": start_idx}

    @timed
    def _process_chat_data(self, scene_data_info, info, **kwargs):
        mode = kwargs.get("mode", "fine")
        windows = list(self._iter_chat_windows(scene_data_info))

        if mode == "fast":
            logger.debug("Using unified Fast Mode")

            def _build_fast_node(w):
                text = w["text"]
                roles = {s.get("role", "") for s in w["sources"] if s.get("role")}
                mem_type = "UserMemory" if roles == {"user"} else "LongTermMemory"
                tags = ["mode:fast"]
                return self._make_memory_item(
                    value=text, info=info, memory_type=mem_type, tags=tags, sources=w["sources"]
                )

            with ContextThreadPoolExecutor(max_workers=8) as ex:
                futures = {ex.submit(_build_fast_node, w): i for i, w in enumerate(windows)}
                results = [None] * len(futures)
                for fut in concurrent.futures.as_completed(futures):
                    i = futures[fut]
                    try:
                        node = fut.result()
                        if node:
                            results[i] = node
                    except Exception as e:
                        logger.error(f"[ChatFast] error: {e}")
                chat_nodes = [r for r in results if r]
            return chat_nodes
        else:
            logger.debug("Using unified Fine Mode")
            chat_read_nodes = []
            for w in windows:
                resp = self._get_llm_response(w["text"])
                for m in resp.get("memory list", []):
                    try:
                        memory_type = (
                            m.get("memory_type", "LongTermMemory")
                            .replace("长期记忆", "LongTermMemory")
                            .replace("用户记忆", "UserMemory")
                        )
                        node = self._make_memory_item(
                            value=m.get("value", ""),
                            info=info,
                            memory_type=memory_type,
                            tags=m.get("tags", []),
                            key=m.get("key", ""),
                            sources=w["sources"],
                            background=resp.get("summary", ""),
                        )
                        chat_read_nodes.append(node)
                    except Exception as e:
                        logger.error(f"[ChatFine] parse error: {e}")
            return chat_read_nodes

    def _process_transfer_chat_data(self, raw_node: TextualMemoryItem):
        raw_memory = raw_node.memory
        response_json = self._get_llm_response(raw_memory)
        chat_read_nodes = []
        for memory_i_raw in response_json.get("memory list", []):
            try:
                memory_type = (
                    memory_i_raw.get("memory_type", "LongTermMemory")
                    .replace("长期记忆", "LongTermMemory")
                    .replace("用户记忆", "UserMemory")
                )
                if memory_type not in ["LongTermMemory", "UserMemory"]:
                    memory_type = "LongTermMemory"
                node_i = self._make_memory_item(
                    value=memory_i_raw.get("value", ""),
                    info={
                        "user_id": raw_node.metadata.user_id,
                        "session_id": raw_node.metadata.session_id,
                    },
                    memory_type=memory_type,
                    tags=memory_i_raw.get("tags", [])
                    if isinstance(memory_i_raw.get("tags", []), list)
                    else [],
                    key=memory_i_raw.get("key", ""),
                    sources=raw_node.metadata.sources,
                    background=response_json.get("summary", ""),
                    type_="fact",
                    confidence=0.99,
                )
                chat_read_nodes.append(node_i)
            except Exception as e:
                logger.error(f"[ChatReader] Error parsing memory item: {e}")

        return chat_read_nodes

    def get_memory(
        self, scene_data: SceneDataInput, type: str, info: dict[str, Any], mode: str = "fine"
    ) -> list[list[TextualMemoryItem]]:
        """
        Extract and classify memory content from scene_data.
        For dictionaries: Use LLM to summarize pairs of Q&A
        For file paths: Use chunker to split documents and LLM to summarize each chunk

        Args:
            scene_data: List of dialogue information or document paths
            type: (Deprecated) not supported in the future. Type of scene_data: ['doc', 'chat']
            info: Dictionary containing user_id and session_id.
                Must be in format: {"user_id": "1111", "session_id": "2222"}
                Optional parameters:
                - topic_chunk_size: Size for large topic chunks (default: 1024)
                - topic_chunk_overlap: Overlap for large topic chunks (default: 100)
                - chunk_size: Size for small chunks (default: 256)
                - chunk_overlap: Overlap for small chunks (default: 50)
            mode: mem-reader mode, fast for quick process while fine for
            better understanding via calling llm
        Returns:
            list[list[TextualMemoryItem]] containing memory content with summaries as keys and original text as values
        Raises:
            ValueError: If scene_data is empty or if info dictionary is missing required fields
        """
        if not scene_data:
            raise ValueError("scene_data is empty")

        # Validate info dictionary format
        if not isinstance(info, dict):
            raise ValueError("info must be a dictionary")

        # TODO: ensure why session_id is required?
        required_fields = {"user_id", "session_id"}
        missing_fields = required_fields - set(info.keys())
        if missing_fields:
            raise ValueError(f"info dictionary is missing required fields: {missing_fields}")

        if not all(isinstance(info[field], str) for field in required_fields):
            raise ValueError("user_id and session_id must be strings")
        standard_scene_data = _coerce_scene_data(scene_data, type)
        return standard_scene_data

    def fine_transfer_simple_mem(
        self, input_memories: list[TextualMemoryItem], type: str
    ) -> list[list[TextualMemoryItem]]:
        if not input_memories:
            return []
        return []
