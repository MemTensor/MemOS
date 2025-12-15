"""Type definitions and custom types for the MemOS library.

This module defines commonly used type aliases, protocols, and custom types
used throughout the MemOS project to improve type safety and code clarity.
"""

import os

from datetime import datetime
from enum import Enum
from typing import Literal, NewType, TypeAlias

from pydantic import BaseModel
from typing_extensions import TypedDict

from memos.memories.activation.item import ActivationMemoryItem
from memos.memories.parametric.item import ParametricMemoryItem
from memos.memories.textual.item import TextualMemoryItem

from .openai_chat_completion_types import (
    ChatCompletionContentPartTextParam,
    ChatCompletionMessageParam,
    File,
)


__all__ = [
    "FINE_STRATEGY",
    "ChatHistory",
    "FineStrategy",
    "MOSSearchResult",
    "MemCubeID",
    "MessageDict",
    "MessageList",
    "MessageRole",
    "MessagesType",
    "Permission",
    "PermissionDict",
    "SearchMode",
    "UserContext",
    "UserID",
]

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


RawMessageDict: TypeAlias = ChatCompletionContentPartTextParam | File


# Message collections
MessageList: TypeAlias = list[ChatCompletionMessageParam]
RawMessageList: TypeAlias = list[RawMessageDict]


# Messages Type
MessagesType: TypeAlias = str | MessageList | RawMessageList


# Chat history structure
class ChatHistory(BaseModel):
    """Model to represent chat history for export."""

    user_id: str
    session_id: str
    created_at: datetime
    total_messages: int
    chat_history: MessageList


# ─── Search ────────────────────────────────────────────────────────────────────
# new types
UserID = NewType("UserID", str)
MemCubeID = NewType("CubeID", str)


class SearchMode(str, Enum):
    """Enumeration for search modes."""

    FAST = "fast"
    FINE = "fine"
    MIXTURE = "mixture"


class FineStrategy(str, Enum):
    """Enumeration for fine strategies."""

    REWRITE = "rewrite"
    RECREATE = "recreate"
    DEEP_SEARCH = "deep_search"
    AGENTIC_SEARCH = "agentic_search"


# algorithm strategies
DEFAULT_FINE_STRATEGY = FineStrategy.RECREATE
FINE_STRATEGY = DEFAULT_FINE_STRATEGY

# Read fine strategy from environment variable `FINE_STRATEGY`.
# If provided and valid, use it; otherwise fall back to default.
_env_fine_strategy = os.getenv("FINE_STRATEGY")
if _env_fine_strategy:
    try:
        FINE_STRATEGY = FineStrategy(_env_fine_strategy)
    except ValueError:
        FINE_STRATEGY = DEFAULT_FINE_STRATEGY


# ─── MemOS ────────────────────────────────────────────────────────────────────


class MOSSearchResult(TypedDict):
    """Model to represent memory search result."""

    text_mem: list[dict[str, str | list[TextualMemoryItem]]]
    act_mem: list[dict[str, str | list[ActivationMemoryItem]]]
    para_mem: list[dict[str, str | list[ParametricMemoryItem]]]


# ─── API Types ────────────────────────────────────────────────────────────────────
# for API Permission
Permission: TypeAlias = Literal["read", "write", "delete", "execute"]


# Message structure
class PermissionDict(TypedDict, total=False):
    """Typed dictionary for chat message dictionaries."""

    permissions: list[Permission]
    mem_cube_id: str


class UserContext(BaseModel):
    """Model to represent user context."""

    user_id: str | None = None
    mem_cube_id: str | None = None
    session_id: str | None = None
    operation: list[PermissionDict] | None = None
