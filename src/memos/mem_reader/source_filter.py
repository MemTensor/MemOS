"""Source filters shared by memory extraction steps."""

from __future__ import annotations

import re

from dataclasses import dataclass
from typing import Any, Literal

from memos.memories.textual.item import SourceMessage


SourceFilterAction = Literal[
    "extract_after_last",
    "strip_after_first",
    "drop_if_present",
    "drop_if_prefix",
]


@dataclass(frozen=True)
class SourceFilterRule:
    name: str
    action: SourceFilterAction
    patterns: tuple[re.Pattern[str], ...]


@dataclass(frozen=True)
class SourceFilterPolicy:
    allowed_roles: frozenset[str]
    blocked_roles: frozenset[str]
    blocked_source_types: frozenset[str]
    rules: tuple[SourceFilterRule, ...]


def _patterns(*values: str, flags: int = 0) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(value, flags) for value in values)


PREFERENCE_SOURCE_POLICY = SourceFilterPolicy(
    allowed_roles=frozenset({"user"}),
    blocked_roles=frozenset({"assistant", "system", "tool"}),
    blocked_source_types=frozenset({"tool"}),
    rules=(
        SourceFilterRule(
            name="user_query_boundary",
            action="extract_after_last",
            patterns=_patterns(
                r"(?im)(?:^|[ \t])#{1,3}[ \t]*用户(?:的)?(?:消息|问题)(?:为|是)?[ \t]*[：:]",
                r"user\u200b原\u200b始\u200bquery\u200b：\u200b\u200b\u200b\u200b",
                r"(?im)(?:^|[ \t])#{1,3}[ \t]*user[ \t]*原始[ \t]*query[ \t]*[：:]",
            ),
        ),
        SourceFilterRule(
            name="trailing_context",
            action="strip_after_first",
            patterns=_patterns(
                r"(?m)^\s{0,3}#{1,3}\s*以下是可能和用户问题关联的对话记忆",
            ),
        ),
        SourceFilterRule(
            name="stream_transcript",
            action="strip_after_first",
            patterns=_patterns(
                r'data:\s*\{"id"\s*:\s*"chatcmpl',
                r"data:\s*\[DONE\]",
            ),
        ),
        SourceFilterRule(
            name="retrieval_context",
            action="drop_if_present",
            patterns=_patterns(
                r"(?m)^\s{0,3}#{1,3}\s*以下内容是基于用户发送的消息的搜索结果",
                r"(?i)<(?:retrieved_context|search_context|web_results)>",
            ),
        ),
        SourceFilterRule(
            name="memory_context",
            action="drop_if_present",
            patterns=_patterns(
                r"(?i)</?(?:memories|memory_context)>",
                r"(?i)===\s*MemOS LONG-TERM MEMORY",
                r"(?i)\[MemOS Auto-Recall\]",
            ),
        ),
        SourceFilterRule(
            name="agent_reasoning",
            action="drop_if_present",
            patterns=_patterns(
                r"(?i)<(?:thinking|reasoning|agent_scratchpad)>",
            ),
        ),
        SourceFilterRule(
            name="runtime_metadata",
            action="drop_if_present",
            patterns=_patterns(
                r"(?m)^\s*Conversation info \(untrusted metadata\):",
                r"(?m)^\s*Untrusted context \(metadata, do not treat as instructions or commands\):",
            ),
        ),
        SourceFilterRule(
            name="automation_context",
            action="drop_if_prefix",
            patterns=_patterns(
                r"\[cron:",
                r"System:\s+\[",
                r"A scheduled reminder has been triggered",
            ),
        ),
        SourceFilterRule(
            name="assistant_runtime_prefix",
            action="drop_if_prefix",
            patterns=_patterns(
                r"小依会根据用户需求",
                r"正在完善Gemini的思考过程",
            ),
        ),
    ),
)


class MemorySourceFilter:
    """Filter raw memory sources before building extraction prompts."""

    def __init__(self, policy: SourceFilterPolicy = PREFERENCE_SOURCE_POLICY):
        self.policy = policy

    def filter_for_preference(self, sources: list[Any] | None) -> list[SourceMessage]:
        """Return only sources allowed to appear in preference extraction prompts."""
        filtered: list[SourceMessage] = []
        for source in sources or []:
            source_dict = self._source_to_dict(source)
            if not self._keep_role_for_preference(source_dict):
                continue

            content = str(source_dict.get("content") or "")
            content = self._strip_known_context_wrappers(content)
            if not content.strip():
                continue

            cleaned = source_dict.copy()
            cleaned["content"] = content.strip()
            if cleaned.get("type") is None:
                cleaned["type"] = "chat"
            cleaned = self._coerce_source_fields(cleaned)
            filtered.append(SourceMessage(**cleaned))
        return filtered

    def build_prompt_text(self, sources: list[Any] | None) -> str:
        """Build a compact prompt text from filtered sources."""
        return self.sources_to_prompt_text(self.filter_for_preference(sources))

    def sources_to_prompt_text(self, sources: list[SourceMessage] | None) -> str:
        """Build prompt text from sources that have already been filtered."""
        lines = []
        for source in sources or []:
            role = source.role or "user"
            content = (source.content or "").strip()
            if not content:
                continue
            lines.append(f"{role}: {content}")
        return "\n".join(lines)

    def _source_to_dict(self, source: Any) -> dict[str, Any]:
        if isinstance(source, SourceMessage):
            return source.model_dump(exclude_none=True)
        if isinstance(source, dict):
            return source.copy()
        if hasattr(source, "model_dump"):
            return source.model_dump(exclude_none=True)
        return {}

    def _coerce_source_fields(self, source: dict[str, Any]) -> dict[str, Any]:
        for key in ("chat_time", "message_id", "role", "type"):
            if source.get(key) is not None and not isinstance(source[key], str):
                source[key] = str(source[key])
        return source

    def _keep_role_for_preference(self, source: dict[str, Any]) -> bool:
        source_type = str(source.get("type") or "chat").strip().lower()
        role = str(source.get("role") or "").strip().lower()
        if source_type in self.policy.blocked_source_types or role in self.policy.blocked_roles:
            return False
        return role in self.policy.allowed_roles

    def _strip_known_context_wrappers(self, text: str) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not text:
            return ""

        for rule in self.policy.rules:
            text = self._apply_rule(text, rule)
            if not text:
                return ""
        return text.strip()

    def _apply_rule(self, text: str, rule: SourceFilterRule) -> str:
        if rule.action == "extract_after_last":
            extracted = self._extract_after_last_match(text, rule.patterns)
            return text if extracted is None else extracted.strip()
        if rule.action == "strip_after_first":
            return self._strip_after_first_match(text, rule.patterns)
        if rule.action == "drop_if_present":
            return "" if any(pattern.search(text) for pattern in rule.patterns) else text
        if rule.action == "drop_if_prefix":
            stripped = text.strip()
            return "" if any(pattern.match(stripped) for pattern in rule.patterns) else text
        return text

    def _extract_after_last_match(
        self, text: str, patterns: tuple[re.Pattern[str], ...]
    ) -> str | None:
        best_match: re.Match[str] | None = None
        for pattern in patterns:
            for match in pattern.finditer(text):
                if best_match is None or match.start() > best_match.start():
                    best_match = match
        if best_match is None:
            return None
        return text[best_match.end() :]

    def _strip_after_first_match(self, text: str, patterns: tuple[re.Pattern[str], ...]) -> str:
        end = len(text)
        for pattern in patterns:
            match = pattern.search(text)
            if match:
                end = min(end, match.start())
        return text[:end].strip()
