"""Length limits for project memory, measured in 字, from a config file and the environment.

Defaults live in ``project_memory_limits.yaml`` next to this module. A deployment overrides
them with a YAML or JSON file named by ``PROJECT_MEMORY_LIMITS_FILE`` and then with one
``PROJECT_MEMORY_LIMIT_<KEY>`` environment variable per key. Requests never set them: a Topic
is shared by a whole project, so its size is the server's decision.

One 字 is one CJK character or one Latin word (letters and digits joined by ``' . _ / -``);
spaces and punctuation are free, so English text gets about the room Chinese text gets.
"""

from __future__ import annotations

import json
import os
import re

from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

import yaml


DEFAULTS_FILE = Path(__file__).with_name("project_memory_limits.yaml")
FILE_ENV = "PROJECT_MEMORY_LIMITS_FILE"
KEY_ENV = "PROJECT_MEMORY_LIMIT_{}"

_UNIT = re.compile(r"[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]|[A-Za-z0-9]+(?:['._/-][A-Za-z0-9]+)*")
_SENTENCE_END = re.compile(r"[。！？；!?;]|\.(?=\s|$)|\n")
_ELLIPSIS = "…"
# A Latin word is one 字, so text without spaces (a hash, a minified blob) is also bounded in
# characters: at most this many per allowed 字.
_MAX_CHARS_PER_UNIT = 12


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

    Returns the text and whether anything was cut. Without a sentence end inside the allowed
    prefix the cut stops after the last whole unit and is marked with an ellipsis.
    """
    text = (text or "").strip()
    ceiling = limit * _MAX_CHARS_PER_UNIT
    if count_units(text) <= limit:
        if len(text) <= ceiling:
            return text, False
        return text[: max(ceiling - 1, 0)] + _ELLIPSIS, True
    end = _prefix_end(text, limit)
    stops = [match.end() for match in _SENTENCE_END.finditer(text) if match.end() <= end + 1]
    if stops and count_units(text[: stops[-1]]) > 0:
        return text[: stops[-1]].strip(), True
    shorter = _prefix_end(text, max(limit - 1, 0))
    return text[:shorter].rstrip(" ,，、:：") + _ELLIPSIS, True


@dataclass(frozen=True)
class LengthSettings:
    """Topic, entry and model-input sizes in 字; see project_memory_limits.yaml."""

    topic_name: int = 30
    topic_summary: int = 160
    description_base: int = 800
    description_per_entry: int = 80
    description_cap: int = 3000
    decision: int = 200
    timeline: int = 200
    experience: int = 400
    episode_summary: int = 400
    quote: int = 400
    metadata_input: int = 8000

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise ValueError(f"Project memory limit {field.name} must be a positive integer")
        if self.description_cap < self.description_base:
            raise ValueError("description_cap must not be below description_base")

    def description(self, active_entries: int) -> int:
        """Room for a Topic description: a base plus some per current decision or experience."""
        grown = self.description_base + self.description_per_entry * max(active_entries, 0)
        return min(grown, self.description_cap)

    def entry(self, kind: str) -> int:
        return {"decision": self.decision, "timeline": self.timeline}.get(kind, self.experience)


def _read(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    data = json.loads(text) if path.suffix.lower() == ".json" else yaml.safe_load(text)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must hold a mapping of limit names to numbers")
    return data


def load_limits(environ: dict[str, str] | None = None) -> LengthSettings:
    """Defaults file, then the deployment file, then per-key environment variables."""
    env = os.environ if environ is None else environ
    known = {field.name for field in fields(LengthSettings)}
    values: dict[str, Any] = {}
    sources = [DEFAULTS_FILE]
    if env.get(FILE_ENV):
        sources.append(Path(env[FILE_ENV]).expanduser())
    for path in sources:
        data = _read(path)
        if unknown := sorted(set(data) - known):
            raise ValueError(f"{path} has unknown project memory limits: {unknown}")
        values.update(data)
    for name in known:
        raw = env.get(KEY_ENV.format(name.upper()))
        if raw is not None and raw.strip():
            try:
                values[name] = int(raw)
            except ValueError:
                raise ValueError(f"{KEY_ENV.format(name.upper())} must be an integer") from None
    return LengthSettings(**values)


LIMITS = load_limits()
