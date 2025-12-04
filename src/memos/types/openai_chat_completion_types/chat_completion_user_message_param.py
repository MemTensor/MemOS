# ruff: noqa: TC001, TC003

from __future__ import annotations

from typing import Literal

from typing_extensions import Required, TypedDict

from .chat_completion_content_part_param import ChatCompletionContentPartParam


__all__ = ["ChatCompletionUserMessageParam"]


class ChatCompletionUserMessageParam(TypedDict, total=False):
    content: Required[str | list[ChatCompletionContentPartParam] | ChatCompletionContentPartParam]
    """The contents of the user message."""

    role: Required[Literal["user"]]
    """The role of the messages author, in this case `user`."""

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
