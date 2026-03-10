"""Message classifier — categorize messages for prompt strategy selection.

Uses a rule-based pipeline (zero LLM overhead) with optional LLM fallback
for ambiguous cases.
"""

from __future__ import annotations

import logging
import re

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

# Category constants
CASUAL_CHAT = "casual_chat"
TASK_ORIENTED = "task_oriented"
KNOWLEDGE_SHARING = "knowledge_sharing"
EMOTIONAL = "emotional"
CODE_DISCUSSION = "code_discussion"
MULTI_TURN_QA = "multi_turn_qa"

ALL_CATEGORIES = [
    CASUAL_CHAT,
    TASK_ORIENTED,
    KNOWLEDGE_SHARING,
    EMOTIONAL,
    CODE_DISCUSSION,
    MULTI_TURN_QA,
]

_CODE_BLOCK_RE = re.compile(r"```[\s\S]*?```")
_TECH_KEYWORDS = re.compile(
    r"\b(import|def |class |function |const |let |var |return |async |await "
    r"|API|SDK|HTTP|JSON|SQL|docker|kubernetes|git|npm|pip)\b",
    re.IGNORECASE,
)
_TASK_KEYWORDS_EN = re.compile(
    r"\b(please|todo|deadline|schedule|remind|plan|book|order|buy|send|create"
    r"|set up|configure|install|deploy|migrate|update)\b",
    re.IGNORECASE,
)
_TASK_KEYWORDS_ZH = re.compile(
    r"(请|帮我|提醒|安排|预定|预约|计划|任务|截止|部署|配置|安装|迁移|更新|设置|发送|创建|购买)",
)
_EMOTION_KEYWORDS_EN = re.compile(
    r"\b(feel|happy|sad|angry|love|hate|miss|worry|afraid|grateful"
    r"|excited|lonely|anxious|stressed|depressed|proud)\b",
    re.IGNORECASE,
)
_EMOTION_KEYWORDS_ZH = re.compile(
    r"(开心|难过|伤心|生气|爱|恨|想念|担心|害怕|感谢|感恩|兴奋|孤独|焦虑|压力|骄傲|烦|累|郁闷|失望|幸福)",
)
_QUESTION_PATTERNS = re.compile(
    r"(\?\s*$|？\s*$|what|why|how|when|where|who|which|do you|can you|is it"
    r"|什么|为什么|怎么|何时|哪里|谁|哪个|是否|能不能|会不会)",
    re.IGNORECASE | re.MULTILINE,
)


def _extract_text(sources: list) -> str:
    """Extract raw text content from sources for rule matching."""
    parts: list[str] = []
    for src in sources:
        if isinstance(src, str):
            parts.append(src)
        elif hasattr(src, "content"):
            parts.append(str(src.content))
        elif isinstance(src, dict):
            parts.append(str(src.get("content", "")))
    return "\n".join(parts)


def _count_roles(sources: list) -> dict[str, int]:
    """Count occurrences of each role in sources."""
    counts: dict[str, int] = {}
    for src in sources:
        role = None
        if hasattr(src, "role"):
            role = src.role
        elif isinstance(src, dict):
            role = src.get("role")
        if role:
            counts[role] = counts.get(role, 0) + 1
    return counts


class MessageClassifier:
    """Rule-based message classifier with optional LLM fallback."""

    def __init__(self, llm: Any | None = None):
        self.llm = llm
        self._rules: list[tuple[str, Callable[[list, str], str | None]]] = [
            ("code_discussion", self._check_code),
            ("task_oriented", self._check_task),
            ("emotional", self._check_emotion),
            ("knowledge_sharing", self._check_knowledge),
            ("multi_turn_qa", self._check_multi_turn_qa),
            ("casual_chat", self._check_casual),
        ]

    def classify(
        self,
        sources: list,
        mem_str: str,
        default_prompt_type: str,
        info: dict[str, Any],
    ) -> str:
        """Classify messages and return a category label.

        Returns the default_prompt_type unchanged when no rule matches
        and no LLM fallback is configured.
        """
        text = _extract_text(sources) if sources else mem_str

        for _name, rule_fn in self._rules:
            result = rule_fn(sources, text)
            if result is not None:
                return result

        if self.llm is not None:
            return self._llm_classify(text, default_prompt_type)

        return default_prompt_type

    # ── Rule functions ──────────────────────────────────────────────

    @staticmethod
    def _check_code(sources: list, text: str) -> str | None:
        has_code_block = bool(_CODE_BLOCK_RE.search(text))
        tech_hits = len(_TECH_KEYWORDS.findall(text))
        if has_code_block or tech_hits >= 3:
            return CODE_DISCUSSION
        return None

    @staticmethod
    def _check_task(sources: list, text: str) -> str | None:
        en_hits = len(_TASK_KEYWORDS_EN.findall(text))
        zh_hits = len(_TASK_KEYWORDS_ZH.findall(text))
        if en_hits + zh_hits >= 2:
            return TASK_ORIENTED
        return None

    @staticmethod
    def _check_emotion(sources: list, text: str) -> str | None:
        en_hits = len(_EMOTION_KEYWORDS_EN.findall(text))
        zh_hits = len(_EMOTION_KEYWORDS_ZH.findall(text))
        if en_hits + zh_hits >= 2:
            return EMOTIONAL
        return None

    @staticmethod
    def _check_knowledge(sources: list, text: str) -> str | None:
        if len(text) > 800 and text.count("\n") >= 5:
            return KNOWLEDGE_SHARING
        return None

    @staticmethod
    def _check_multi_turn_qa(sources: list, text: str) -> str | None:
        role_counts = _count_roles(sources)
        total_turns = sum(role_counts.values())
        question_hits = len(_QUESTION_PATTERNS.findall(text))
        if total_turns >= 4 and question_hits >= 2:
            return MULTI_TURN_QA
        return None

    @staticmethod
    def _check_casual(sources: list, text: str) -> str | None:
        role_counts = _count_roles(sources)
        total_turns = sum(role_counts.values())
        if total_turns <= 2 and len(text) < 200:
            return CASUAL_CHAT
        return None

    # ── LLM fallback ────────────────────────────────────────────────

    def _llm_classify(self, text: str, default: str) -> str:
        categories_str = ", ".join(ALL_CATEGORIES)
        prompt = (
            f"Classify the following conversation into exactly one category.\n"
            f"Categories: {categories_str}\n\n"
            f"Conversation:\n{text[:2000]}\n\n"
            f"Reply with ONLY the category name, nothing else."
        )
        try:
            result = self.llm.generate([{"role": "user", "content": prompt}])
            label = result.strip().lower().replace(" ", "_")
            if label in ALL_CATEGORIES:
                return label
            logger.warning("[PromptStrategy] LLM returned unknown category: %s", label)
        except Exception:
            logger.exception("[PromptStrategy] LLM classification failed")
        return default
