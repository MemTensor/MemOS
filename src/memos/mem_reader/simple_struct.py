import concurrent.futures
import copy
import json
import os
import re

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

    @timed
    def _process_chat_data(self, scene_data_info, info):
        mem_list = []
        for item in scene_data_info:
            if "chat_time" in item:
                mem = item["role"] + ": " + f"[{item['chat_time']}]: " + item["content"]
                mem_list.append(mem)
            else:
                mem = item["role"] + ":" + item["content"]
                mem_list.append(mem)
        lang = detect_lang("\n".join(mem_list))
        template = PROMPT_DICT["chat"][lang]
        examples = PROMPT_DICT["chat"][f"{lang}_example"]

        prompt = template.replace("${conversation}", "\n".join(mem_list))
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
                        "key": "\n".join(mem_list)[:10],
                        "memory_type": "UserMemory",
                        "value": "\n".join(mem_list),
                        "tags": [],
                    }
                ],
                "summary": "\n".join(mem_list),
            }

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

                node_i = TextualMemoryItem(
                    memory=memory_i_raw.get("value", ""),
                    metadata=TreeNodeTextualMemoryMetadata(
                        user_id=info.get("user_id"),
                        session_id=info.get("session_id"),
                        memory_type=memory_type,
                        status="activated",
                        tags=memory_i_raw.get("tags", [])
                        if type(memory_i_raw.get("tags", [])) is list
                        else [],
                        key=memory_i_raw.get("key", ""),
                        embedding=self.embedder.embed([memory_i_raw.get("value", "")])[0],
                        usage=[],
                        sources=scene_data_info,
                        background=response_json.get("summary", ""),
                        confidence=0.99,
                        type="fact",
                    ),
                )
                chat_read_nodes.append(node_i)
            except Exception as e:
                logger.error(f"[ChatReader] Error parsing memory item: {e}")

        return chat_read_nodes

    def get_memory(
        self, scene_data: list, type: str, info: dict[str, Any]
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
                executor.submit(processing_func, scene_data_info, info)
                for scene_data_info in list_scene_data_info
            ]
            for future in concurrent.futures.as_completed(futures):
                res_memory = future.result()
                memory_list.append(res_memory)

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
        parser_config = ParserConfigFactory.model_validate(
            {
                "backend": "markitdown",
                "config": {},
            }
        )
        parser = ParserFactory.from_config(parser_config)

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

    def parse_json_result(self, response_text):
        try:
            json_start = response_text.find("{")
            response_text = response_text[json_start:]
            response_text = response_text.replace("```", "").strip()
            if not response_text.endswith("}"):
                response_text += "}"
            return json.loads(response_text)
        except json.JSONDecodeError as e:
            logger.error(f"[JSONParse] Failed to decode JSON: {e}\nRaw:\n{response_text}")
            return {}
        except Exception as e:
            logger.error(f"[JSONParse] Unexpected error: {e}")
            return {}

    def transform_memreader(self, data: dict) -> list[TextualMemoryItem]:
        pass
