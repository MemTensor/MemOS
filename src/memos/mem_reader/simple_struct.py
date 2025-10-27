import concurrent.futures
import copy
import json
import os
import re
import traceback

from abc import ABC
from typing import Any

from tqdm import tqdm

from memos import log
from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.configs.parser import ParserConfigFactory
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.base import BaseMemReader
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.parsers.factory import ParserFactory
from memos.templates.mem_reader_prompts import (
    SIMPLE_STRUCT_DOC_READER_PROMPT,
    SIMPLE_STRUCT_DOC_READER_PROMPT_ZH,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE_ZH,
    SIMPLE_STRUCT_MEM_READER_PROMPT,
    SIMPLE_STRUCT_MEM_READER_PROMPT_ZH,
)
from memos.utils import timed


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
        chinese_pattern = r"[\u4e00-\u9fff\u3400-\u4dbf\U00020000-\U0002a6df\U0002a700-\U0002b73f\U0002b740-\U0002b81f\U0002b820-\U0002ceaf\uf900-\ufaff]"
        chinese_chars = re.findall(chinese_pattern, text)
        if len(chinese_chars) / len(re.sub(r"[\s\d\W]", "", text)) > 0.3:
            return "zh"
        return "en"
    except Exception:
        return "en"


def _build_node(idx, message, info, scene_file, llm, parse_json_result, embedder):
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

        return TextualMemoryItem(
            memory=value,
            metadata=TreeNodeTextualMemoryMetadata(
                user_id=info.get("user_id", ""),
                session_id=info.get("session_id", ""),
                memory_type="LongTermMemory",
                status="activated",
                tags=tags,
                key=key,
                embedding=embedding,
                usage=[],
                sources=[{"type": "doc", "doc_path": f"{scene_file}_{idx}"}],
                background="",
                confidence=0.99,
                type="fact",
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
            sources.append({"type": "chat", "index": idx, "role": role, "chat_time": chat_time})
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
        self, scene_data: list, type: str, info: dict[str, Any], mode: str = "fine"
    ) -> list[list[TextualMemoryItem]]:
        """
        Extract and classify memory content from scene_data.
        For dictionaries: Use LLM to summarize pairs of Q&A
        For file paths: Use chunker to split documents and LLM to summarize each chunk

        Args:
            scene_data: List of dialogue information or document paths
            type: Type of scene_data: ['doc', 'chat']
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

        list_scene_data_info = self.get_scene_data_info(scene_data, type)

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
        return memory_list

    def fine_transfer_simple_mem(
        self, input_memories: list[TextualMemoryItem], type: str
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
                executor.submit(processing_func, scene_data_info)
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

    def get_scene_data_info(self, scene_data: list, type: str) -> list[str]:
        """
        Get raw information from scene_data.
        If scene_data contains dictionaries, convert them to strings.
        If scene_data contains file paths, parse them using the parser.

        Args:
            scene_data: List of dialogue information or document paths
            type: Type of scene data: ['doc', 'chat']
        Returns:
            List of strings containing the processed scene data
        """
        results = []

        if type == "chat":
            for items in scene_data:
                result = []
                for item in items:
                    # Convert dictionary to string
                    if "chat_time" in item:
                        result.append(item)
                    else:
                        result.append(item)
                    if len(result) >= 10:
                        results.append(result)
                        context = copy.deepcopy(result[-2:])
                        result = context
                if result:
                    results.append(result)
        elif type == "doc":
            parser_config = ParserConfigFactory.model_validate(
                {
                    "backend": "markitdown",
                    "config": {},
                }
            )
            parser = ParserFactory.from_config(parser_config)
            for item in scene_data:
                try:
                    if os.path.exists(item):
                        try:
                            parsed_text = parser.parse(item)
                            results.append({"file": item, "text": parsed_text})
                        except Exception as e:
                            logger.error(f"[SceneParser] Error parsing {item}: {e}")
                            continue
                    else:
                        parsed_text = item
                        results.append({"file": "pure_text", "text": parsed_text})
                except Exception as e:
                    print(f"Error parsing file {item}: {e!s}")

        return results

    def _process_doc_data(self, scene_data_info, info, **kwargs):
        mode = kwargs.get("mode", "fine")
        if mode == "fast":
            raise NotImplementedError
        chunks = self.chunker.chunk(scene_data_info["text"])
        messages = []
        for chunk in chunks:
            lang = detect_lang(chunk.text)
            template = PROMPT_DICT["doc"][lang]
            prompt = template.replace("{chunk_text}", chunk.text)
            message = [{"role": "user", "content": prompt}]
            messages.append(message)

        doc_nodes = []
        scene_file = scene_data_info["file"]

        with ContextThreadPoolExecutor(max_workers=50) as executor:
            futures = {
                executor.submit(
                    _build_node,
                    idx,
                    msg,
                    info,
                    scene_file,
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

    def _process_transfer_doc_data(self, raw_node: TextualMemoryItem):
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

    def transform_memreader(self, data: dict) -> list[TextualMemoryItem]:
        pass
