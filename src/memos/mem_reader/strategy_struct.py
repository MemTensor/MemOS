import os

from abc import ABC

from memos import log
from memos.configs.mem_reader import StrategyStructMemReaderConfig
from memos.configs.parser import ParserConfigFactory
from memos.mem_reader.read_multi_modal import detect_lang
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.parsers.factory import ParserFactory
from memos.templates.mem_reader_prompts import (
    CUSTOM_TAGS_INSTRUCTION,
    CUSTOM_TAGS_INSTRUCTION_ZH,
    SIMPLE_STRUCT_DOC_READER_PROMPT,
    SIMPLE_STRUCT_DOC_READER_PROMPT_ZH,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE,
    SIMPLE_STRUCT_MEM_READER_EXAMPLE_ZH,
)
from memos.templates.mem_reader_strategy_prompts import (
    STRATEGY_STRUCT_MEM_READER_PROMPT,
    STRATEGY_STRUCT_MEM_READER_PROMPT_ZH,
)


logger = log.get_logger(__name__)
STRATEGY_PROMPT_DICT = {
    "chat": {
        "en": STRATEGY_STRUCT_MEM_READER_PROMPT,
        "zh": STRATEGY_STRUCT_MEM_READER_PROMPT_ZH,
        "en_example": SIMPLE_STRUCT_MEM_READER_EXAMPLE,
        "zh_example": SIMPLE_STRUCT_MEM_READER_EXAMPLE_ZH,
    },
    "doc": {"en": SIMPLE_STRUCT_DOC_READER_PROMPT, "zh": SIMPLE_STRUCT_DOC_READER_PROMPT_ZH},
    "custom_tags": {"en": CUSTOM_TAGS_INSTRUCTION, "zh": CUSTOM_TAGS_INSTRUCTION_ZH},
}


class StrategyStructMemReader(SimpleStructMemReader, ABC):
    """Naive implementation of MemReader."""

    def __init__(self, config: StrategyStructMemReaderConfig):
        super().__init__(config)
        self.chat_chunker = config.chat_chunker["config"]

    def _get_llm_response(self, mem_str: str, custom_tags: list[str] | None) -> dict:
        lang = detect_lang(mem_str)
        template = STRATEGY_PROMPT_DICT["chat"][lang]
        examples = STRATEGY_PROMPT_DICT["chat"][f"{lang}_example"]
        prompt = template.replace("${conversation}", mem_str)

        custom_tags_prompt = (
            STRATEGY_PROMPT_DICT["custom_tags"][lang].replace("{custom_tags}", str(custom_tags))
            if custom_tags
            else ""
        )
        prompt = prompt.replace("${custom_tags_prompt}", custom_tags_prompt)

        if self.config.remove_prompt_example:  # TODO unused
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
            if self.chat_chunker["chunk_type"] == "content_length":
                content_len_thredshold = self.chat_chunker["chunk_length"]
                for items in scene_data:
                    if not items:
                        continue

                    results.append([])
                    current_length = 0

                    for _i, item in enumerate(items):
                        content_length = (
                            len(item.get("content", ""))
                            if isinstance(item, dict)
                            else len(str(item))
                        )
                        if not results[-1]:
                            results[-1].append(item)
                            current_length = content_length
                            continue

                        if current_length + content_length <= content_len_thredshold:
                            results[-1].append(item)
                            current_length += content_length
                        else:
                            overlap_item = results[-1][-1]
                            overlap_length = (
                                len(overlap_item.get("content", ""))
                                if isinstance(overlap_item, dict)
                                else len(str(overlap_item))
                            )

                            results.append([overlap_item, item])
                            current_length = overlap_length + content_length
            else:
                cut_size, cut_overlap = (
                    self.chat_chunker["chunk_session"],
                    self.chat_chunker["chunk_overlap"],
                )
                for items in scene_data:
                    step = cut_size - cut_overlap
                    end = len(items) - cut_overlap
                    if end <= 0:
                        results.extend([items[:]])
                    else:
                        results.extend([items[i : i + cut_size] for i in range(0, end, step)])

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
