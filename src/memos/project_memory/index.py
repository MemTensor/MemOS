"""Tokenization for result diversity and the retrieval projection models."""

import json
import math
import re

from collections.abc import Iterator

from pydantic import BaseModel, Field


TOKEN = re.compile(r"[\u3400-\u9fff]+|[^\W_]+(?:_[^\W_]+)*", re.UNICODE)


def terms(text: str) -> Iterator[str]:
    # PostgreSQL's simple dictionary treats an entire unspaced Chinese phrase as one word.
    for match in TOKEN.finditer(re.sub(r"([\u3400-\u9fff]+)", r" \1 ", text.casefold())):
        word = match.group()
        if "\u3400" <= word[0] <= "\u9fff" and len(word) > 1:
            yield from (word[i : i + 2] for i in range(len(word) - 1))
        else:
            yield word[:128]


class Statement(BaseModel):
    content: str
    time: str
    user_ids: list[str]
    reason: str | None = None
    source: dict | None = None
    change_source: dict | None = None


class Entry(Statement):
    id: str = Field(min_length=1)


class Experience(Entry):
    task_intent: str | None = None
    exp_status: str | None = None
    confidence: float | None = None
    lifecycle: str | None = None
    card: dict | None = None
    version: int | None = None
    sources: list[dict] = Field(default_factory=list)


class Decision(Entry):
    user_labels: dict[str, str] = Field(default_factory=dict)
    history: list[Statement] = Field(default_factory=list)
    conflicts: list[Statement] = Field(default_factory=list)


class Topic(BaseModel):
    id: str = Field(min_length=1)
    domain: str
    topic_name: str
    topic_summary: str
    topic_description: str
    create_time: str
    update_time: str
    rank_time: str | None = None  # storage ranking key (topics.extra.rank_time)
    sources: list[dict] = Field(default_factory=list)
    decisions: list[Decision] = Field(default_factory=list)
    experiences: list[Experience] = Field(default_factory=list)
    timeline: list[Entry] = Field(default_factory=list)


class Vector(BaseModel):
    model: str = Field(min_length=1)
    values: list[float] = Field(min_length=1)

    def sql_value(self) -> str:
        if not all(math.isfinite(x) for x in self.values) or not any(self.values):
            raise ValueError("Embedding must be finite with a non-zero norm")
        return json.dumps(self.values, allow_nan=False)
