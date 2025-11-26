import concurrent.futures
import traceback

from abc import ABC
from typing import Any, TypeAlias

from memos import log
from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import MultiModelStructMemReaderConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.base import BaseMemReader
from memos.mem_reader.read_multi_model import coerce_scene_data
from memos.mem_reader.simple_struct import _count_tokens_text, _derive_key, detect_lang
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


class MultiModelStructMemReader(BaseMemReader, ABC):
    """Naive implementation of MemReader."""

    def __init__(self, config: MultiModelStructMemReaderConfig):
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
    def _process_multi_model_data(self, scene_data_info, info, **kwargs):
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

    @timed
    def _process_transfer_multi_model_data(self, raw_node: TextualMemoryItem):
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

        required_fields = {"user_id", "session_id"}
        missing_fields = required_fields - set(info.keys())
        if missing_fields:
            raise ValueError(f"info dictionary is missing required fields: {missing_fields}")

        if not all(isinstance(info[field], str) for field in required_fields):
            raise ValueError("user_id and session_id must be strings")
        standard_scene_data = coerce_scene_data(scene_data, type)
        return self._read_memory(standard_scene_data, info, mode)

    def get_scene_data_info(self, messages: list[MessagesType]) -> list[list[Any]]:
        # TODO: split messages
        return messages

    def _read_memory(self, messages: list[MessagesType], info: dict[str, Any], mode: str = "fine"):
        list_scene_data_info = self.get_scene_data_info(messages)

        memory_list = []
        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(self._process_multi_model_data, scene_data_info, info, mode=mode)
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
        self, input_memories: list[TextualMemoryItem], **kwargs
    ) -> list[list[TextualMemoryItem]]:
        if not input_memories:
            return []

        memory_list = []

        # Process Q&A pairs concurrently with context propagation
        with ContextThreadPoolExecutor() as executor:
            futures = [
                executor.submit(self._process_transfer_multi_model_data, scene_data_info)
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
