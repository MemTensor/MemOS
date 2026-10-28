from typing import Any

from memos.configs.llm import QwenLLMConfig
from memos.llms.openai import OpenAILLM
from memos.log import get_logger


logger = get_logger(__name__)

DASHSCOPE_WAIT_TIMEOUT_HEADER = "X-DashScope-Wait-Timeout"
DASHSCOPE_WAIT_TIMEOUT_SECONDS = "30"


def _add_dashscope_wait_timeout_header(
    default_headers: dict[str, Any] | None,
) -> dict[str, Any]:
    headers = dict(default_headers or {})
    if not any(key.lower() == DASHSCOPE_WAIT_TIMEOUT_HEADER.lower() for key in headers):
        headers[DASHSCOPE_WAIT_TIMEOUT_HEADER] = DASHSCOPE_WAIT_TIMEOUT_SECONDS
    return headers


class QwenLLM(OpenAILLM):
    """Qwen (DashScope) LLM class via OpenAI-compatible API."""

    def __init__(self, config: QwenLLMConfig):
        config = config.model_copy(
            update={"default_headers": _add_dashscope_wait_timeout_header(config.default_headers)}
        )
        super().__init__(config)
