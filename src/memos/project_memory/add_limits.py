"""Server-side length policy for what Add writes into a Topic.

Lengths are counted in 字: one CJK character or one Latin word (letters, digits and the
joiners ``. - _ / '`` inside it) counts as one; spaces and punctuation are free. English text
therefore gets about the same room as Chinese text with the same information.

None of these limits come from a request. A Topic is shared by every member of a project, so
its size is the server's decision; deployments tune it with ``PROJECT_MEMORY_*`` variables.
The description budget grows with the Topic: a work with many current decisions and
experiences gets more room, up to a cap.
"""

from __future__ import annotations

import os
import re

from dataclasses import dataclass


_UNIT = re.compile(
    r"[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]"
    r"|[A-Za-z0-9]+(?:['._/-][A-Za-z0-9]+)*"
)
_SENTENCE_END = re.compile(r"[。！？；!?;]|\.(?=\s|$)|\n")
_ELLIPSIS = "…"


def count_units(text: str) -> int:
    """Length in 字: CJK characters and Latin words, punctuation and spaces excluded."""
    return sum(1 for _ in _UNIT.finditer(text or ""))


def _prefix_end(text: str, limit: int) -> int:
    """Index just past the `limit`-th unit (the whole text when it is short enough)."""
    if limit <= 0:
        return 0
    for index, match in enumerate(_UNIT.finditer(text), 1):
        if index == limit:
            return match.end()
    return len(text)


def cut_at_sentence(text: str, limit: int) -> tuple[str, bool]:
    """Fit `text` into `limit` 字, ending at a sentence boundary when one exists.

    Returns the text and whether anything was cut. A cut that finds no sentence end inside
    the allowed prefix stops after the last whole unit and marks the cut with an ellipsis.
    """
    text = (text or "").strip()
    if count_units(text) <= limit:
        return text, False
    end = _prefix_end(text, limit)
    stops = [match.end() for match in _SENTENCE_END.finditer(text) if match.end() <= end + 1]
    if stops and count_units(text[: stops[-1]]) > 0:
        return text[: stops[-1]].strip(), True
    shorter = _prefix_end(text, max(limit - 1, 0))
    return text[:shorter].rstrip(" ,，、:：") + _ELLIPSIS, True


@dataclass(frozen=True)
class LengthSettings:
    """Topic and entry sizes in 字. Defaults follow the reviewed tables except the description."""

    topic_name: int = 20
    topic_summary: int = 80
    description_base: int = 600
    description_per_entry: int = 60
    description_cap: int = 2000
    decision: int = 100
    timeline: int = 100
    experience: int = 200
    metadata_input: int = 6000

    def __post_init__(self) -> None:
        if min(vars(self).values()) <= 0:
            raise ValueError("Project memory length limits must be positive")
        if self.description_cap < self.description_base:
            raise ValueError("The description cap must not be below its base")

    @classmethod
    def from_env(cls) -> LengthSettings:
        defaults = cls()
        return cls(
            **{
                name: int(os.getenv(f"PROJECT_MEMORY_{name.upper()}_LIMIT", str(default)))
                if name not in {"description_base", "description_per_entry", "description_cap"}
                else int(os.getenv(f"PROJECT_MEMORY_{name.upper()}", str(default)))
                for name, default in vars(defaults).items()
            }
        )

    def description(self, active_entries: int) -> int:
        """Room for a Topic description: a base plus some per current decision or experience."""
        grown = self.description_base + self.description_per_entry * max(active_entries, 0)
        return min(grown, self.description_cap)

    def entry(self, kind: str) -> int:
        return {"decision": self.decision, "timeline": self.timeline}.get(kind, self.experience)


LIMITS = LengthSettings.from_env()
