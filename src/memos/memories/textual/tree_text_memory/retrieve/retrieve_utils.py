import json
import re

from pathlib import Path
from typing import Any


import numpy as np

from memos.dependency import require_python_package
from memos.log import get_logger


logger = get_logger(__name__)


def parse_structured_output(content: str) -> dict[str, str | list[str]]:
    """
    Parse structured text containing arbitrary XML-like tags in the format <tag_name>content</tag_name>.

    This function extracts all tagged content and automatically determines whether each tag's content
    should be returned as a string or a list of strings based on its format:

    - If the content consists of multiple non-empty lines, and each line starts with "- ",
      it is interpreted as a list (e.g., a bullet-point list of phrases).
    - Otherwise, the entire content is returned as a single string.

    The function is generic and supports any tag name (e.g., <can_answer>, <reason>, <missing_phrases>).

    Args:
        content (str): Raw text containing one or more <tag_name>...</tag_name> blocks.

    Returns:
        Dict[str, Union[str, List[str]]]: A dictionary where keys are tag names and values are either:
            - a string (for single-line or non-list content)
            - a list of strings (for content formatted as bullet points with "- " prefix)

    Example:
        Input:
            <can_answer>
            true
            </can_answer>
            <missing_phrases>
            - phrase 1
            - phrase 2
            </missing_phrases>

        Output:
            {
                'can_answer': 'true',
                'missing_phrases': ['phrase 1', 'phrase 2']
            }
    """
    result = {}

    # Regex pattern to match any tag with name and content (supports multi-line content via DOTALL)
    # Pattern explanation:
    # <([a-zA-Z_][a-zA-Z0-9_]*)>  : Captures valid tag name (letter/underscore + alphanumeric)
    # (.*?)                        : Non-greedy capture of content (including newlines)
    # </\1>                        : Closing tag matching the captured name
    tag_pattern = r"<([a-zA-Z_][a-zA-Z0-9_]*)>(.*?)</\1>"
    matches = re.findall(tag_pattern, content, re.DOTALL)

    for tag_name, raw_content in matches:
        content = raw_content.strip()  # Remove leading/trailing whitespace

        # If content is empty, store as empty string
        if not content:
            result[tag_name] = ""
            continue

        # Split content into lines and filter out empty ones
        lines = [line.strip() for line in content.splitlines() if line.strip()]

        # Check if content is formatted as a bullet list: all non-empty lines start with "- "
        if lines and all(line.startswith("-") for line in lines):
            # Extract the text after the "- " prefix from each line
            items = [line[1:].strip() for line in lines]
            result[tag_name] = items
        else:
            # Treat as plain string (preserve original formatting if multi-line)
            result[tag_name] = content

    return result


def find_project_root(marker=".git"):
    """Find the project root directory by marking the file"""
    current = Path(__file__).resolve()
    while current != current.parent:
        if (current / marker).exists():
            return current
        current = current.parent
    return Path(".")


class StopwordManager:
    _stopwords = None

    @classmethod
    def _load_stopwords(cls):
        """load stopwords for once"""
        if cls._stopwords is not None:
            return cls._stopwords

        stopwords = set()
        stopwords = cls._load_default_stopwords()

        cls._stopwords = stopwords
        return stopwords

    @classmethod
    def _load_default_stopwords(cls):
        """load stop words"""
        chinese_stop_words = {
            "的",
            "了",
            "在",
            "是",
            "我",
            "有",
            "和",
            "就",
            "不",
            "人",
            "都",
            "一",
            "一个",
            "上",
            "也",
            "很",
            "到",
            "说",
            "要",
            "去",
            "你",
            "会",
            "着",
            "没有",
            "看",
            "好",
            "自己",
            "这",
            "那",
            "他",
            "她",
            "它",
            "我们",
            "你们",
            "他们",
            "这个",
            "那个",
            "这些",
            "那些",
            "怎么",
            "什么",
            "为什么",
            "如何",
            "哪里",
            "谁",
            "几",
            "多少",
            "这样",
            "那样",
            "这么",
            "那么",
        }
        english_stop_words = {
            "the",
            "a",
            "an",
            "and",
            "or",
            "but",
            "in",
            "on",
            "at",
            "to",
            "for",
            "of",
            "with",
            "by",
            "as",
            "is",
            "are",
            "was",
            "were",
            "be",
            "been",
            "have",
            "has",
            "had",
            "do",
            "does",
            "did",
            "will",
            "would",
            "could",
            "should",
            "may",
            "might",
            "must",
            "this",
            "that",
            "these",
            "those",
            "i",
            "you",
            "he",
            "she",
            "it",
            "we",
            "they",
            "me",
            "him",
            "her",
            "us",
            "them",
            "my",
            "your",
            "his",
            "its",
            "our",
            "their",
            "mine",
            "yours",
            "hers",
            "ours",
            "theirs",
        }
        chinese_punctuation = {
            "，",
            "。",
            "！",
            "？",
            "；",
            "：",
            "「",
            "」",
            "『",
            "』",
            "【",
            "】",
            "（",
            "）",
            "《",
            "》",
            "—",
            "…",
            "～",
            "·",
            "、",
            "“",
            "”",
            "‘",
            "’",
            "〈",
            "〉",
            "〖",
            "〗",
            "〝",
            "〞",
            "｛",
            "｝",
            "〔",
            "〕",
            "¡",
            "¿",
        }
        english_punctuation = {
            ",",
            ".",
            "!",
            "?",
            ";",
            ":",
            '"',
            "'",
            "(",
            ")",
            "[",
            "]",
            "{",
            "}",
            "<",
            ">",
            "/",
            "\\",
            "|",
            "-",
            "_",
            "=",
            "+",
            "@",
            "#",
            "$",
            "%",
            "^",
            "&",
            "*",
            "~",
            "`",
            "¡",
            "¿",
        }
        numbers = {
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "零",
            "一",
            "二",
            "三",
            "四",
            "五",
            "六",
            "七",
            "八",
            "九",
            "十",
            "百",
            "千",
            "万",
            "亿",
        }
        whitespace = {" ", "\t", "\n", "\r", "\f", "\v"}

        return (
            chinese_stop_words
            | english_stop_words
            | chinese_punctuation
            | english_punctuation
            | numbers
            | whitespace
        )

    @classmethod
    def get_stopwords(cls):
        if cls._stopwords is None:
            cls._load_stopwords()
        return cls._stopwords

    @classmethod
    def filter_words(cls, words):
        if cls._stopwords is None:
            cls._load_stopwords()
        return [word for word in words if word not in cls._stopwords and word.strip()]

    @classmethod
    def is_stopword(cls, word):
        if cls._stopwords is None:
            cls._load_stopwords()
        return word in cls._stopwords


class FastTokenizer:
    def __init__(self, use_jieba=True, use_stopwords=True):
        self.use_jieba = use_jieba
        self.use_stopwords = use_stopwords
        if self.use_stopwords:
            self.stopword_manager = StopwordManager

    def tokenize_mixed(self, text, **kwargs):
        """fast tokenizer"""
        if self._is_chinese(text):
            return self._tokenize_chinese(text)
        else:
            return self._tokenize_english(text)

    def _is_chinese(self, text):
        """check if chinese"""
        chinese_chars = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
        return chinese_chars / max(len(text), 1) > 0.3

    @require_python_package(
        import_name="jieba",
        install_command="pip install jieba",
        install_link="https://github.com/fxsjy/jieba",
    )
    def _tokenize_chinese(self, text):
        """split zh jieba"""
        import jieba

        tokens = jieba.lcut(text) if self.use_jieba else list(text)
        tokens = [token.strip() for token in tokens if token.strip()]
        if self.use_stopwords:
            return self.stopword_manager.filter_words(tokens)

        return tokens

    def _tokenize_english(self, text):
        """split zh regex"""
        tokens = re.findall(r"\b[a-zA-Z0-9]+\b", text.lower())
        if self.use_stopwords:
            return self.stopword_manager.filter_words(tokens)
        return tokens


def parse_json_result(response_text):
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


def format_memory_item(memory_data: Any) -> dict[str, Any]:
    memory = memory_data.model_dump()
    memory_id = memory["id"]
    ref_id = f"[{memory_id.split('-')[0]}]"

    memory["ref_id"] = ref_id
    memory["metadata"]["embedding"] = []
    memory["metadata"]["sources"] = []
    memory["metadata"]["usage"] = []
    memory["metadata"]["ref_id"] = ref_id
    memory["metadata"]["id"] = memory_id
    memory["metadata"]["memory"] = memory["memory"]

    return memory


def find_best_unrelated_subgroup(sentences: list, similarity_matrix: list, bar: float = 0.8):
    assert len(sentences) == len(similarity_matrix)

    num_sentence = len(sentences)
    selected_sentences = []
    selected_indices = []
    for i in range(num_sentence):
        can_add = True
        for j in selected_indices:
            if similarity_matrix[i][j] > bar:
                can_add = False
                break
        if can_add:
            selected_sentences.append(i)
            selected_indices.append(i)
    return selected_sentences, selected_indices


def cosine_similarity_matrix(embeddings: list[list[float]]) -> list[list[float]]:
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    x_normalized = embeddings / norms
    similarity_matrix = np.dot(x_normalized, x_normalized.T)
    return similarity_matrix
