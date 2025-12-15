import concurrent.futures
import copy
import json
import os
import re
import traceback

from abc import ABC
from typing import Any, TypeAlias

from tqdm import tqdm

from memos import log
from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.base import BaseMemReader
from memos.mem_reader.read_multi_modal import coerce_scene_data, detect_lang
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.templates.mem_reader_prompts import (
    CUSTOM_TAGS_INSTRUCTION,
    CUSTOM_TAGS_INSTRUCTION_ZH,
    PROMPT_MAPPING,
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


class ParserFactory:
    """Placeholder required by test suite."""

    @staticmethod
    def from_config(_config):
        return None


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
    "custom_tags": {"en": CUSTOM_TAGS_INSTRUCTION, "zh": CUSTOM_TAGS_INSTRUCTION_ZH},
}


try:
    import tiktoken

    try:
        _ENC = tiktoken.encoding_for_model("gpt-4o-mini")
    except Exception:
        _ENC = tiktoken.get_encoding("cl100k_base")

    def _count_tokens_text(s: str) -> int:
        return len(_ENC.encode(s or "", disallowed_special=()))
except Exception:
    # Heuristic fallback: zh chars ~1 token, others ~1 token per ~4 chars
    def _count_tokens_text(s: str) -> int:
        if not s:
            return 0
        zh_chars = re.findall(r"[\u4e00-\u9fff]", s)
        zh = len(zh_chars)
        rest = len(s) - zh
        return zh + max(1, rest // 4)


def _build_node(idx, message, info, source_info, llm, parse_json_result, embedder):
    # generate
    try:
        raw = llm.generate(message)
        if not raw:
            logger.warning(f"[LLM] Empty generation for input: {message}")
            return None
    except Exception as e:
        logger.error(f"[LLM] Exception during generation: {e}")
        return None

    # parse_json_result
    try:
        chunk_res = parse_json_result(raw)
        if not chunk_res:
            logger.warning(f"[Parse] Failed to parse result: {raw}")
            return None
    except Exception as e:
        logger.error(f"[Parse] Exception during JSON parsing: {e}")
        return None

    try:
        value = chunk_res.get("value", "").strip()
        if not value:
            logger.warning("[BuildNode] value is empty")
            return None

        tags = chunk_res.get("tags", [])
        if not isinstance(tags, list):
            tags = []

        key = chunk_res.get("key", None)

        embedding = embedder.embed([value])[0]

        info_ = info.copy()
        user_id = info_.pop("user_id", "")
        session_id = info_.pop("session_id", "")

        return TextualMemoryItem(
            memory=value,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=user_id,
                session_id=session_id,
                memory_type="LongTermMemory",
                status="activated",
                tags=tags,
                key=key,
                embedding=embedding,
                usage=[],
                sources=source_info,
                background="",
                confidence=0.99,
                type="fact",
                info=info_,
            ),
        )
    except Exception as e:
        logger.error(f"[BuildNode] Error building node: {e}")
        return None


def _derive_key(text: str, max_len: int = 80) -> str:
    """default key when without LLM: first max_len words"""
    if not text:
        return ""
    sent = re.split(r"[。！？!?]\s*|\n", text.strip())[0]
    return (sent[:max_len]).strip()


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
        **kwargs,
    ) -> TextualMemoryItem:
        """construct memory item"""
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
                tags=tags or [],
                key=key if key is not None else _derive_key(value),
                embedding=self.embedder.embed([value])[0],
                usage=[],
                sources=sources or [],
                background=background,
                confidence=confidence,
                type=type_,
                info=info_,
                **kwargs,
            ),
        )

    def _get_llm_response(self, mem_str: str, custom_tags: list[str] | None) -> dict:
        lang = detect_lang(mem_str)
        template = PROMPT_DICT["chat"][lang]
        examples = PROMPT_DICT["chat"][f"{lang}_example"]
        prompt = template.replace("${conversation}", mem_str)

        custom_tags_prompt = (
            PROMPT_DICT["custom_tags"][lang].replace("{custom_tags}", str(custom_tags))
            if custom_tags
            else ""
        )
        prompt = prompt.replace("${custom_tags_prompt}", custom_tags_prompt)

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
        custom_tags = info.pop(
            "custom_tags", None
        )  # must pop here, avoid add to info, only used in sync fine mode

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
                resp = self._get_llm_response(w["text"], custom_tags)
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

    def _process_transfer_chat_data(
        self, raw_node: TextualMemoryItem, custom_tags: list[str] | None = None
    ):
        raw_memory = raw_node.memory
        response_json = self._get_llm_response(raw_memory, custom_tags)

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
                        **(raw_node.metadata.info or {}),
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

        required_fields = {"user_id", "session_id"}
        missing_fields = required_fields - set(info.keys())
        if missing_fields:
            raise ValueError(f"info dictionary is missing required fields: {missing_fields}")

        if not all(isinstance(info[field], str) for field in required_fields):
            raise ValueError("user_id and session_id must be strings")

        # Backward compatibility, after coercing scene_data, we only tackle
        # with standard scene_data type: MessagesType
        standard_scene_data = coerce_scene_data(scene_data, type)
        return self._read_memory(standard_scene_data, type, info, mode)

    @staticmethod
    def _parse_hallucination_filter_response(text: str) -> tuple[bool, dict[int, dict]]:
        """Parse index-keyed JSON from hallucination filter response.
        Expected shape: { "0": {"need_rewrite": bool, "rewritten_suffix": str, "reason": str}, ... }
        Returns (success, parsed_dict) with int keys.
        """
        try:
            data = json.loads(text)
        except Exception:
            return False, {}

        if not isinstance(data, dict):
            return False, {}

        result: dict[int, dict] = {}
        for k, v in data.items():
            try:
                idx = int(k)
            except Exception:
                # allow integer keys as-is
                if isinstance(k, int):
                    idx = k
                else:
                    continue
            if not isinstance(v, dict):
                continue
            need_rewrite = v.get("need_rewrite")
            rewritten_suffix = v.get("rewritten_suffix", "")
            reason = v.get("reason", "")
            if (
                isinstance(need_rewrite, bool)
                and isinstance(rewritten_suffix, str)
                and isinstance(reason, str)
            ):
                result[idx] = {
                    "need_rewrite": need_rewrite,
                    "rewritten_suffix": rewritten_suffix,
                    "reason": reason,
                }

        return (len(result) > 0), result

    def filter_hallucination_in_memories(
        self, messages: list[dict], memory_list: list[TextualMemoryItem]
    ) -> list[TextualMemoryItem]:
        # Build input objects with memory text and metadata (timestamps, sources, etc.)
        template = PROMPT_MAPPING["hallucination_filter"]
        prompt_args = {
            "messages_inline": "\n".join(
                [f"- [{message['role']}]: {message['content']}" for message in messages]
            ),
            "memories_inline": json.dumps(
                {idx: mem.memory for idx, mem in enumerate(memory_list)},
                ensure_ascii=False,
                indent=2,
            ),
        }
        prompt = template.format(**prompt_args)

        # Optionally run filter and parse the output
        try:
            raw = self.llm.generate([{"role": "user", "content": prompt}])
            success, parsed = self._parse_hallucination_filter_response(raw)
            logger.info(
                f"[filter_hallucination_in_memories] Hallucination filter parsed successfully: {success}"
            )
            if success:
                new_mem_list = []
                logger.info(f"Hallucination filter result: {parsed}")
                assert len(parsed) == len(memory_list)
                for mem_idx, content in parsed.items():
                    need_rewrite = content.get("need_rewrite", False)
                    rewritten_suffix = content.get("rewritten_suffix", "")
                    reason = content.get("reason", "")

                    # Append a new memory item instead of replacing the original
                    if (
                        need_rewrite
                        and isinstance(rewritten_suffix, str)
                        and len(rewritten_suffix.strip()) > 0
                    ):
                        original_text = memory_list[mem_idx].memory

                        logger.info(
                            f"[filter_hallucination_in_memories] index={mem_idx}, need_rewrite={need_rewrite}, rewritten_suffix='{rewritten_suffix}', reason='{reason}', original memory='{original_text}', action='append_suffix'"
                        )

                        # Append only the suffix to the original memory text
                        memory_list[mem_idx].memory = original_text + rewritten_suffix
                        new_mem_list.append(memory_list[mem_idx])
                    else:
                        new_mem_list.append(memory_list[mem_idx])
                return new_mem_list
            else:
                logger.warning("Hallucination filter parsing failed or returned empty result.")
        except Exception as e:
            logger.error(f"Hallucination filter execution error: {e}", stack_info=True)

        return memory_list

    def _read_memory(
        self, messages: list[MessagesType], type: str, info: dict[str, Any], mode: str = "fine"
    ) -> list[list[TextualMemoryItem]]:
        """
        1. raw file:
        [
            [
                {"type": "file", "file": "str"}
            ],
            [
                {"type": "file", "file": "str"}
            ],...
        ]
        2. text chat:
        scene_data = [
            [ {role: user, ...}, {role: assistant, ...}, ... ],
            [ {role: user, ...}, {role: assistant, ...}, ... ],
            [ ... ]
        ]
        """
        list_scene_data_info = self.get_scene_data_info(messages, type)

        memory_list = []
        if type == "chat":
            processing_func = self._process_chat_data
        elif type == "doc":
            processing_func = self._process_doc_data
        else:
            processing_func = self._process_doc_data

        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(processing_func, scene_data_info, info, mode=mode)
                for scene_data_info in list_scene_data_info
            ]
            for future in concurrent.futures.as_completed(futures):
                try:
                    res_memory = future.result()
                    if res_memory is not None:
                        memory_list.append(res_memory)
                except Exception as e:
                    logger.error(f"Task failed with exception: {e}")
                    logger.error(traceback.format_exc())

        if os.getenv("SIMPLE_STRUCT_ADD_FILTER", "false") == "true":
            # Build inputs
            new_memory_list = []
            for unit_messages, unit_memory_list in zip(messages, memory_list, strict=False):
                unit_memory_list = self.filter_hallucination_in_memories(
                    messages=unit_messages, memory_list=unit_memory_list
                )
                new_memory_list.append(unit_memory_list)
            memory_list = new_memory_list
        return memory_list

    def fine_transfer_simple_mem(
        self,
        input_memories: list[TextualMemoryItem],
        type: str,
        custom_tags: list[str] | None = None,
    ) -> list[list[TextualMemoryItem]]:
        if not input_memories:
            return []

        memory_list = []

        if type == "chat":
            processing_func = self._process_transfer_chat_data
        elif type == "doc":
            processing_func = self._process_transfer_doc_data
        else:
            processing_func = self._process_transfer_doc_data

        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(processing_func, scene_data_info, custom_tags)
                for scene_data_info in input_memories
            ]
            for future in concurrent.futures.as_completed(futures):
                try:
                    res_memory = future.result()
                    if res_memory is not None:
                        memory_list.append(res_memory)
                except Exception as e:
                    logger.error(f"Task failed with exception: {e}")
                    logger.error(traceback.format_exc())
        return memory_list

    def get_scene_data_info(self, scene_data: list, type: str) -> list[list[Any]]:
        """
        Convert normalized MessagesType scenes into typical MessagesType this reader can
        handle.
        SimpleStructMemReader only supports text-only chat messages with roles.
        For chat scenes we:
          - skip unsupported scene types (e.g. `str` scenes)
          - drop non-dict messages
          - keep only roles in {user, assistant, system}
          - coerce OpenAI multimodal `content` (list[parts]) into a single plain-text string
          - then apply the existing windowing logic (<=10 messages with 2-message overlap)
        For doc scenes we pass through; doc handling is done in `_process_doc_data`.
        """
        results: list[list[Any]] = []

        if type == "chat":
            allowed_roles = {"user", "assistant", "system"}
            for items in scene_data:
                if isinstance(items, str):
                    logger.warning(
                        "SimpleStruct MemReader does not support "
                        "str message data now, your messages "
                        f"contains {items}, skipping"
                    )
                    continue
                if not isinstance(items, list):
                    logger.warning(
                        "SimpleStruct MemReader expects message as "
                        f"list[dict], your messages contains"
                        f"{items}, skipping"
                    )
                    continue
                # Filter messages within this message
                result = []
                for _i, item in enumerate(items):
                    if not isinstance(item, dict):
                        logger.warning(
                            "SimpleStruct MemReader expects message as "
                            f"list[dict], your messages contains"
                            f"{item}, skipping"
                        )
                        continue
                    role = item.get("role") or ""
                    role = role if isinstance(role, str) else str(role)
                    role = role.strip().lower()
                    if role not in allowed_roles:
                        logger.warning(
                            f"SimpleStruct MemReader expects message with "
                            f"role in {allowed_roles}, your messages contains"
                            f"role {role}, skipping"
                        )
                        continue

                    content = item.get("content", "")
                    if not isinstance(content, str):
                        logger.warning(
                            f"SimpleStruct MemReader expects message content "
                            f"with str, your messages content"
                            f"is {content!s}, skipping"
                        )
                        continue
                    if not content:
                        continue

                    result.append(
                        {
                            "role": role,
                            "content": content,
                            "chat_time": item.get("chat_time", ""),
                        }
                    )
                if not result:
                    continue
                window = []
                for i, item in enumerate(result):
                    window.append(item)
                    if len(window) >= 10:
                        results.append(window)
                        context = copy.deepcopy(window[-2:]) if i + 1 < len(result) else []
                        window = context

                if window:
                    results.append(window)
        elif type == "doc":
            results = scene_data
        return results

    def _process_doc_data(self, scene_data_info, info, **kwargs):
        """
        Process doc data after being normalized to new RawMessageList format.

        scene_data_info format (length always == 1):
        [
            {"type": "file", "file": {"filename": "...", "file_data": "..."}}
        ]
        OR
        [
            {"type": "text", "text": "..."}
        ]

        Behavior:
        - Merge all text/file_data into a single "full text"
        - Chunk the text
        - Build prompts
        - Send to LLM
        - Parse results and build memory nodes
        """
        mode = kwargs.get("mode", "fine")
        if mode == "fast":
            raise NotImplementedError

        custom_tags = info.pop("custom_tags", None)

        if not scene_data_info or len(scene_data_info) != 1:
            logger.error(
                "[DocReader] scene_data_info must contain exactly 1 item after normalization"
            )
            return []

        item = scene_data_info[0]
        text_content = ""
        source_info_list = []

        # Determine content and source metadata
        if item.get("type") == "file":
            f = item["file"]
            filename = f.get("filename") or "document"
            file_data = f.get("file_data") or ""

            text_content = file_data
            source_dict = {
                "type": "doc",
                "doc_path": filename,
            }
            source_info_list = [SourceMessage(**source_dict)]

        elif item.get("type") == "text":
            text_content = item.get("text", "")
            source_info_list = [SourceMessage(type="doc", doc_path="inline-text")]

        text_content = (text_content or "").strip()
        if not text_content:
            logger.warning("[DocReader] Empty document text after normalization.")
            return []

        chunks = self.chunker.chunk(text_content)
        messages = []
        for chunk in chunks:
            lang = detect_lang(chunk.text)
            template = PROMPT_DICT["doc"][lang]
            prompt = template.replace("{chunk_text}", chunk.text)
            custom_tags_prompt = (
                PROMPT_DICT["custom_tags"][lang].replace("{custom_tags}", str(custom_tags))
                if custom_tags
                else ""
            )
            prompt = prompt.replace("{custom_tags_prompt}", custom_tags_prompt)
            message = [{"role": "user", "content": prompt}]
            messages.append(message)

        doc_nodes = []

        with ContextThreadPoolExecutor(max_workers=50) as executor:
            futures = {
                executor.submit(
                    _build_node,
                    idx,
                    msg,
                    info,
                    source_info_list,
                    self.llm,
                    self.parse_json_result,
                    self.embedder,
                ): idx
                for idx, msg in enumerate(messages)
            }
            total = len(futures)

            for future in tqdm(
                concurrent.futures.as_completed(futures), total=total, desc="Processing"
            ):
                try:
                    node = future.result()
                    if node:
                        doc_nodes.append(node)
                except Exception as e:
                    tqdm.write(f"[ERROR] {e}")
                    logger.error(f"[DocReader] Future task failed: {e}")
        return doc_nodes

    def _process_transfer_doc_data(
        self, raw_node: TextualMemoryItem, custom_tags: list[str] | None = None
    ):
        raise NotImplementedError

    def parse_json_result(self, response_text: str) -> dict:
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
                return json.loads(s)
            logger.error(
                f"[JSONParse] Failed to decode JSON: {e}\nTail: Raw {response_text} \
                json: {s}"
            )
            return {}
