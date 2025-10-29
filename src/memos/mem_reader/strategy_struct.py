import os
import re

from abc import ABC

from memos import log
from memos.configs.mem_reader import StrategyStructMemReaderConfig
from memos.configs.parser import ParserConfigFactory
from memos.mem_reader.simple_struct import (
    SimpleStructMemReader,
)
from memos.parsers.factory import ParserFactory
from memos.templates.mem_reader_prompts import (
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
PROMPT_DICT = {
    "chat": {
        "en": STRATEGY_STRUCT_MEM_READER_PROMPT,
        "zh": STRATEGY_STRUCT_MEM_READER_PROMPT_ZH,
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


class StrategyStructMemReader(SimpleStructMemReader, ABC):
    """Naive implementation of MemReader."""

    def __init__(self, config: StrategyStructMemReaderConfig):
        super().__init__(config)
        self.chat_chunker = config.chat_chunker["config"]

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
