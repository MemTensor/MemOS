# ruff: noqa: TC001

from __future__ import annotations

from typing import Literal

from typing_extensions import Required, TypedDict

from .chat_completion_content_part_param import ChatCompletionContentPartParam
from .chat_completion_message_function_tool_call_param import (
    ChatCompletionMessageFunctionToolCallParam,
)


__all__ = ["ChatCompletionToolMessageParam"]


class ChatCompletionToolMessageParam(TypedDict, total=False):
    content: Required[str | list[ChatCompletionContentPartParam] | ChatCompletionContentPartParam]
    """The contents of the tool message."""

    role: Required[Literal["tool"]]
    """The role of the messages author, in this case `tool`."""

    tool_calls: list[ChatCompletionMessageFunctionToolCallParam]
    """Input of the tool invocation whose output is stored in content."""

    tool_call_id: Required[str]
    """Tool call that this message is responding to."""

    chat_time: str | None
    """Optional timestamp for the message, format is not
    restricted, it can be any vague or precise time string."""

    message_id: str | None
    """Optional unique identifier for the message"""
