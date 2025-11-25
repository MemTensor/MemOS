from __future__ import annotations

from typing import TypeAlias

from .chat_completion_message_custom_tool_call_param import ChatCompletionMessageCustomToolCallParam
from .chat_completion_message_function_tool_call_param import (
    ChatCompletionMessageFunctionToolCallParam,
)


__all__ = ["ChatCompletionMessageToolCallUnionParam"]

ChatCompletionMessageToolCallUnionParam: TypeAlias = (
    ChatCompletionMessageFunctionToolCallParam | ChatCompletionMessageCustomToolCallParam
)
