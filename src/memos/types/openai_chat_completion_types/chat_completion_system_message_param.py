# ruff: noqa: TC001, TC003

from __future__ import annotations

from typing import Literal

from typing_extensions import Required, TypedDict

from .chat_completion_content_part_text_param import ChatCompletionContentPartTextParam


__all__ = ["ChatCompletionSystemMessageParam"]


class ChatCompletionSystemMessageParam(TypedDict, total=False):
    content: Required[
        str | list[ChatCompletionContentPartTextParam] | ChatCompletionContentPartTextParam
    ]
    """The contents of the system message."""

    role: Required[Literal["system"]]
    """The role of the messages author, in this case `system`."""

    name: str
    """An optional name for the participant.

    Provides the model information to differentiate between participants of the same
    role.
    """

    chat_time: str | None
    """Optional timestamp for the message, format is not
    restricted, it can be any vague or precise time string."""

    message_id: str | None
    """Optional unique identifier for the message"""
