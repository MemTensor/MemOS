"""Tests for OpenAIResponsesLLM and AzureResponsesLLM generate reasoning handling."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from openai.types.responses.response_reasoning_item import ResponseReasoningItem, Summary

from memos.configs.llm import AzureLLMConfig, OpenAIResponsesLLMConfig
from memos.llms.openai_new import AzureResponsesLLM, OpenAIResponsesLLM


MESSAGES = [{"role": "user", "content": "Hello"}]


def _make_openai_llm(
    *, enable_thinking: bool = False, remove_think_prefix: bool = False
) -> OpenAIResponsesLLM:
    llm = OpenAIResponsesLLM.__new__(OpenAIResponsesLLM)
    llm.config = OpenAIResponsesLLMConfig(
        api_key="test-key",
        model_name_or_path="gpt-4o",
        enable_thinking=enable_thinking,
        remove_think_prefix=remove_think_prefix,
    )
    llm.client = MagicMock()
    return llm


def _make_azure_llm(
    *, enable_thinking: bool = False, remove_think_prefix: bool = False
) -> AzureResponsesLLM:
    llm = AzureResponsesLLM.__new__(AzureResponsesLLM)
    llm.config = AzureLLMConfig(
        api_key="test-key",
        model_name_or_path="gpt-4o",
        enable_thinking=enable_thinking,
        remove_think_prefix=remove_think_prefix,
    )
    llm.client = MagicMock()
    return llm


@pytest.mark.parametrize(
    "make_llm",
    [_make_openai_llm, _make_azure_llm],
    ids=["openai", "azure"],
)
class TestResponsesLLMGenerate:
    def test_generate_without_reasoning_item_returns_output_text(self, make_llm):
        llm = make_llm(enable_thinking=False)
        llm.client.responses.create.return_value = SimpleNamespace(
            output=[SimpleNamespace(type="message")],
            output_text="plain answer",
        )

        result = llm.generate(MESSAGES)

        assert result == "plain answer"

    def test_generate_with_empty_reasoning_summary_returns_output_text(self, make_llm):
        llm = make_llm(enable_thinking=True)
        reasoning_item = ResponseReasoningItem(id="rs_1", summary=[], type="reasoning")
        llm.client.responses.create.return_value = SimpleNamespace(
            output=[reasoning_item],
            output_text="plain answer",
        )

        result = llm.generate(MESSAGES)

        assert result == "plain answer"

    def test_generate_with_reasoning_summary_prepends_think_tag(self, make_llm):
        llm = make_llm(enable_thinking=True, remove_think_prefix=False)
        reasoning_item = ResponseReasoningItem(
            id="rs_1",
            summary=[Summary(text="step by step", type="summary_text")],
            type="reasoning",
        )
        llm.client.responses.create.return_value = SimpleNamespace(
            output=[reasoning_item],
            output_text="final answer",
        )

        result = llm.generate(MESSAGES)

        assert result == "<think>step by step</think>final answer"

    def test_generate_with_remove_think_prefix_strips_thinking(self, make_llm):
        llm = make_llm(enable_thinking=True, remove_think_prefix=True)
        reasoning_item = ResponseReasoningItem(
            id="rs_1",
            summary=[Summary(text="step by step", type="summary_text")],
            type="reasoning",
        )
        llm.client.responses.create.return_value = SimpleNamespace(
            output=[reasoning_item],
            output_text="<think>inline thought</think>final answer",
        )

        result = llm.generate(MESSAGES)

        assert result == "final answer"
