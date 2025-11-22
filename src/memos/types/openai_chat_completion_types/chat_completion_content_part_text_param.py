from __future__ import annotations

from typing import Literal

from typing_extensions import Required, TypedDict


__all__ = ["ChatCompletionContentPartTextParam"]


class ChatCompletionContentPartTextParam(TypedDict, total=False):
    text: Required[str]
    """The text content."""

    type: Required[Literal["text"]]
    """The type of the content part."""
