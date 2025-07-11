import concurrent.futures
import copy
import json
import re
from abc import ABC
from typing import Any

from memos import log
from memos.chunkers import ChunkerFactory
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.configs.parser import ParserConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.llms.factory import LLMFactory
from memos.mem_reader.base import BaseMemReader
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.parsers.factory import ParserFactory
from memos.templates.mem_reader_prompts import (
    SIMPLE_STRUCT_DOC_READER_PROMPT,
    SIMPLE_STRUCT_MEM_READER_PROMPT,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE,
)


logger = log.get_logger(__name__)


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

    def _process_chat_data(self, scene_data_info, info):
        prompt = SIMPLE_STRUCT_MEM_READER_PROMPT.replace(
            "${conversation}", "\n".join(scene_data_info)
        )
        if self.config.remove_prompt_example:
            prompt = prompt.replace(SIMPLE_STRUCT_MEM_READER_EXAMPLE, "")

        messages = [{"role": "user", "content": prompt}]

        response_text = self.llm.generate(messages)
        response_json = self.parse_json_result(response_text)

        chat_read_nodes = []
        for memory_i_raw in response_json.get("memory list", []):
            node_i = TextualMemoryItem(
                memory=memory_i_raw.get("value", ""),
                metadata=TreeNodeTextualMemoryMetadata(
                    user_id=info.get("user_id"),
                    session_id=info.get("session_id"),
                    memory_type=memory_i_raw.get("memory_type", ""),
                    status="activated",
                    tags=memory_i_raw.get("tags", ""),
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

        # Process Q&A pairs concurrently
        with concurrent.futures.ThreadPoolExecutor() as executor:
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
                        mem = item["role"] + ": " + f"[{item['chat_time']}]: " + item["content"]
                        result.append(mem)
                    else:
                        mem = item["role"] + ":" + item["content"]
                        result.append(mem)
                    if len(result) >= 10:
                        results.append(result)
                        context = copy.deepcopy(result[-2:])
                        result = context
                if result:
                    results.append(result)
        elif type == "doc":
            for item in scene_data:
                try:
                    parsed_text = parser.parse(item)
                    results.append({"file": item, "text": parsed_text})
                except Exception as e:
                    print(f"Error parsing file {item}: {e!s}")

        return results

    def _process_doc_data(self, scene_data_info, info):
        chunks = self.chunker.chunk(scene_data_info["text"])
        messages = [
            [
                {
                    "role": "user",
                    "content": SIMPLE_STRUCT_DOC_READER_PROMPT.replace("{chunk_text}", chunk.text),
                }
            ]
            for chunk in chunks
        ]

        processed_chunks = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(self.llm.generate, message) for message in messages]
            for future in concurrent.futures.as_completed(futures):
                chunk_result = future.result()
                if chunk_result:
                    processed_chunks.append(chunk_result)

        processed_chunks = [self.parse_json_result(r) for r in processed_chunks]
        doc_nodes = []
        for i, chunk_res in enumerate(processed_chunks):
            if chunk_res:
                node_i = TextualMemoryItem(
                    memory=chunk_res["summary"],
                    metadata=TreeNodeTextualMemoryMetadata(
                        user_id=info.get("user_id"),
                        session_id=info.get("session_id"),
                        memory_type="LongTermMemory",
                        status="activated",
                        tags=chunk_res["tags"],
                        key="",
                        embedding=self.embedder.embed([chunk_res["summary"]])[0],
                        usage=[],
                        sources=[f"{scene_data_info['file']}_{i}"],
                        background="",
                        confidence=0.99,
                        type="fact",
                    ),
                )
                doc_nodes.append(node_i)
        return doc_nodes

    def parse_json_result(self, response_text):
        try:
            json_start = response_text.find("{")
            response_text = response_text[json_start:]
            response_text = response_text.replace("```", "").strip()
            if response_text[-1] != "}":
                response_text += "}"
            response_json = json.loads(response_text)
            return response_json
        except json.JSONDecodeError as e:
            logger.warning(
                f"Failed to parse LLM response as JSON: {e}\nRaw response:\n{response_text}"
            )
            return {}

    def transform_memreader(self, data: dict) -> list[TextualMemoryItem]:
        pass
