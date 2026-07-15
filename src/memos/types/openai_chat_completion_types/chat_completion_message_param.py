from __future__ import annotations

from typing import TypeAlias

from .chat_completion_assistant_message_param import ChatCompletionAssistantMessageParam
from .chat_completion_system_message_param import ChatCompletionSystemMessageParam
from .chat_completion_tool_message_param import ChatCompletionToolMessageParam
from .chat_completion_user_message_param import ChatCompletionUserMessageParam


__all__ = ["ChatCompletionMessageParam"]

ChatCompletionMessageParam: TypeAlias = (
    ChatCompletionSystemMessageParam
    | ChatCompletionUserMessageParam
    | ChatCompletionAssistantMessageParam
    | ChatCompletionToolMessageParam
)
