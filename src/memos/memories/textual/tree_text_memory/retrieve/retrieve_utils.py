import json
import re

from pathlib import Path

import jieba

from memos.log import get_logger


logger = get_logger(__name__)


def find_project_root(marker=".git"):
    """Find the project root directory by marking the file"""
    current = Path(__file__).resolve()
    while current != current.parent:
        if (current / marker).exists():
            return current
        current = current.parent
    logger.warn(f"The project root directory tag file was not found: {marker}")


PROJECT_ROOT = find_project_root()
DEFAULT_STOPWORD_FILE = (
    PROJECT_ROOT / "examples" / "data" / "config" / "stopwords.txt"
)  # cause time delay


class StopwordManager:
    _stopwords = None

    @classmethod
    def _load_stopwords(cls):
        """load stopwords for once"""
        if cls._stopwords is not None:
            return cls._stopwords

        stopwords = set()
        try:
            with open(DEFAULT_STOPWORD_FILE, encoding="utf-8") as f:
                stopwords = {line.strip() for line in f if line.strip()}
            logger.info("Stopwords loaded successfully.")
        except Exception as e:
            logger.warning(f"Error loading stopwords: {e}")
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

    @classmethod
    def reload_stopwords(cls, file_path=None):
        cls._stopwords = None
        if file_path:
            global DEFAULT_STOPWORD_FILE
            DEFAULT_STOPWORD_FILE = file_path
        cls._load_stopwords()


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

    def _tokenize_chinese(self, text):
        """split zh jieba"""
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
