"""Type definitions and custom types for the MemOS library.

This module defines commonly used type aliases, protocols, and custom types
used throughout the MemOS project to improve type safety and code clarity.
"""

from datetime import datetime
from typing import Literal, TypeAlias

from pydantic import BaseModel
from typing_extensions import TypedDict

from memos.memories.activation.item import ActivationMemoryItem
from memos.memories.parametric.item import ParametricMemoryItem
from memos.memories.textual.item import TextualMemoryItem


# ─── Message Types ──────────────────────────────────────────────────────────────

# Chat message roles
MessageRole: TypeAlias = Literal["user", "assistant", "system"]


# Message structure
class MessageDict(TypedDict, total=False):
    """Typed dictionary for chat message dictionaries."""

    role: MessageRole
    content: str
    chat_time: str | None  # Optional timestamp for the message, format is not
    # restricted, it can be any vague or precise time string.
    message_id: str | None  # Optional unique identifier for the message


# Message collections
MessageList: TypeAlias = list[MessageDict]


# Chat history structure
class ChatHistory(BaseModel):
    """Model to represent chat history for export."""

    user_id: str
    session_id: str
    created_at: datetime
    total_messages: int
    chat_history: MessageList


# ─── MemOS ────────────────────────────────────────────────────────────────────


class MOSSearchResult(TypedDict):
    """Model to represent memory search result."""

    text_mem: list[dict[str, str | list[TextualMemoryItem]]]
    act_mem: list[dict[str, str | list[ActivationMemoryItem]]]
    para_mem: list[dict[str, str | list[ParametricMemoryItem]]]
