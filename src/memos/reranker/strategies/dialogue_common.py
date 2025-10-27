from __future__ import annotations

import re

from typing import Any, Literal

from pydantic import BaseModel

from memos.memories.textual.item import SourceMessage, TextualMemoryItem


# Strip a leading "[...]" tag (e.g., "[2025-09-01] ..." or "[meta] ...")
# before sending text to the reranker. This keeps inputs clean and
# avoids misleading the model with bracketed prefixes.
_TAG1 = re.compile(r"^\s*\[[^\]]*\]\s*")


def strip_memory_tags(item: TextualMemoryItem) -> str:
    """Strip leading tags from memory text."""
    memory = _TAG1.sub("", m) if isinstance((m := getattr(item, "memory", None)), str) else m
    return memory


def extract_content(msg: dict[str, Any] | str) -> str:
    """Extract content from message, handling both string and dict formats."""
    if isinstance(msg, dict):
        return msg.get("content", str(msg))
    if isinstance(msg, SourceMessage):
        return msg.content
    return str(msg)


class DialoguePair(BaseModel):
    """Represents a single dialogue pair extracted from sources."""

    pair_id: str  # Unique identifier for this dialogue pair
    memory_id: str  # ID of the source TextualMemoryItem
    memory: str
    pair_index: int  # Index of this pair within the source memory's dialogue
    user_msg: str | dict[str, Any] | SourceMessage  # User message content
    assistant_msg: str | dict[str, Any] | SourceMessage  # Assistant message content
    combined_text: str  # The concatenated text used for ranking
    chat_time: str | None = None

    @property
    def user_content(self) -> str:
        """Get user message content as string."""
        return extract_content(self.user_msg)

    @property
    def assistant_content(self) -> str:
        """Get assistant message content as string."""
        return extract_content(self.assistant_msg)


class DialogueRankingTracker:
    """Tracks dialogue pairs and their rankings for memory reconstruction."""

    def __init__(self):
        self.dialogue_pairs: list[DialoguePair] = []

    def add_dialogue_pair(
        self,
        memory_id: str,
        pair_index: int,
        user_msg: str | dict[str, Any],
        assistant_msg: str | dict[str, Any],
        memory: str,
        chat_time: str | None = None,
        concat_format: Literal["user_assistant", "user_only"] = "user_assistant",
    ) -> str:
        """Add a dialogue pair and return its unique ID."""
        user_content = extract_content(user_msg)
        assistant_content = extract_content(assistant_msg)
        if concat_format == "user_assistant":
            combined_text = f"[{chat_time}]: \nuser: {user_content}\nassistant: {assistant_content}"
        elif concat_format == "user_only":
            combined_text = f"[{chat_time}]: \nuser: {user_content}"
        else:
            raise ValueError(f"Invalid concat format: {concat_format}")

        pair_id = f"{memory_id}_{pair_index}"

        dialogue_pair = DialoguePair(
            pair_id=pair_id,
            memory_id=memory_id,
            pair_index=pair_index,
            user_msg=user_msg,
            assistant_msg=assistant_msg,
            combined_text=combined_text,
            memory=memory,
            chat_time=chat_time,
        )

        self.dialogue_pairs.append(dialogue_pair)
        return pair_id

    def get_documents_for_ranking(self, concat_memory: bool = True) -> list[str]:
        """Get the combined text documents for ranking."""
        if concat_memory:
            return [(pair.memory + "\n\n" + pair.combined_text) for pair in self.dialogue_pairs]
        else:
            return [pair.combined_text for pair in self.dialogue_pairs]

    def get_dialogue_pair_by_index(self, index: int) -> DialoguePair | None:
        """Get dialogue pair by its index in the ranking results."""
        if 0 <= index < len(self.dialogue_pairs):
            return self.dialogue_pairs[index]
        return None
