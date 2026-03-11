"""Message classifier — rule-chain architecture with extensible rules.

Currently only one rule is registered (identity/relation naming detection).
To add a new rule, write a static method that returns a category string on
match or ``None`` on miss, then append it to ``self._rules`` in ``__init__``.
"""

from __future__ import annotations

import logging
import re

from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

# ── Category constants ──────────────────────────────────────────────
IDENTITY_RELATION = "identity_relation"

# ── Regex patterns for identity / relation detection ────────────────
_SELF_NAME_RE = re.compile(
    r"我(?:的名字)?(?:是|叫)\s*(?P<name>\S+)",
)

_RELATION_WORDS = (
    "儿子|女儿|孩子|小孩"
    "|老婆|妻子|老公|丈夫|爱人|伴侣|对象"
    "|爸爸|妈妈|父亲|母亲|爸|妈"
    "|哥哥|姐姐|弟弟|妹妹|哥|姐|弟|妹"
    "|爷爷|奶奶|外公|外婆|姥姥|姥爷"
    "|叔叔|阿姨|舅舅|舅妈|姑姑|姑父"
    "|朋友|同事|同学|室友|闺蜜|兄弟"
    "|男朋友|女朋友|前任"
    "|宠物|狗|猫"
)
_RELATION_NAME_RE = re.compile(
    rf"我(?:的)?(?:{_RELATION_WORDS})(?:的名字)?(?:是|叫)\s*(?P<name>\S+)",
)

_MY_NAME_IS_EN = re.compile(
    r"(?:my name is|i'?m|call me)\s+(?P<name>[A-Z]\w+)",
    re.IGNORECASE,
)
_MY_RELATION_IS_EN = re.compile(
    r"my\s+(?:son|daughter|wife|husband|father|mother|brother|sister|friend)"
    r"(?:'s name)?\s+is\s+(?P<name>[A-Z]\w+)",
    re.IGNORECASE,
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


class MessageClassifier:
    """Rule-chain classifier.

    Rules are evaluated in registration order; the first match wins.
    If no rule matches, ``classify()`` returns ``None`` so the caller
    keeps the default prompt unchanged.

    To add a new rule:
        1. Define a static/class method ``_check_xxx(sources, text) -> str | None``
        2. Append ``("category_name", self._check_xxx)`` to ``self._rules``
    """

    def __init__(self) -> None:
        self._rules: list[tuple[str, Callable[[list, str], str | None]]] = [
            ("identity_relation", self._check_identity_relation),
        ]

    def classify(
        self,
        sources: list,
        mem_str: str,
        default_prompt_type: str,
        info: dict[str, Any],
    ) -> str | None:
        """Walk the rule chain; return the first matching category or ``None``."""
        text = _extract_text(sources) if sources else mem_str
        if not text:
            return None

        for _name, rule_fn in self._rules:
            result = rule_fn(sources, text)
            if result is not None:
                return result

        return None

    # ── Rules ───────────────────────────────────────────────────────

    @staticmethod
    def _check_identity_relation(sources: list, text: str) -> str | None:
        self_names = [m.group("name") for m in _SELF_NAME_RE.finditer(text)]
        self_names += [m.group("name") for m in _MY_NAME_IS_EN.finditer(text)]
        relation_names = [m.group("name") for m in _RELATION_NAME_RE.finditer(text)]
        relation_names += [m.group("name") for m in _MY_RELATION_IS_EN.finditer(text)]

        if self_names or relation_names:
            logger.info(
                "[PromptStrategy] Identity/relation pattern detected — "
                "self_names=%s, relation_names=%s",
                self_names,
                relation_names,
            )
            return IDENTITY_RELATION

        return None
