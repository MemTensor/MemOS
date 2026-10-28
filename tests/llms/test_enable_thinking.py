"""Tests for enable_thinking parameter in OpenAI-compatible LLMs."""

import json

import httpx
import openai

from memos.configs.llm import AzureLLMConfig, OpenAILLMConfig
from memos.llms.openai import AzureLLM, OpenAILLM


def _make_config(**overrides):
    defaults = {
        "api_key": "test-key",
        "model_name_or_path": "gpt-4o",
    }
    defaults.update(overrides)
    return OpenAILLMConfig(**defaults)


class TestEnableThinkingConfig:
    def test_enable_thinking_defaults_to_none(self):
        config = _make_config()
        assert config.enable_thinking is None

    def test_enable_thinking_can_be_set(self):
        config = _make_config(enable_thinking=True)
        assert config.enable_thinking is True

    def test_enable_thinking_false(self):
        config = _make_config(enable_thinking=False)
        assert config.enable_thinking is False

    def test_azure_enable_thinking_can_be_set(self):
        config = AzureLLMConfig(
            api_key="test-key",
            model_name_or_path="test-model",
            enable_thinking=True,
        )
        assert config.enable_thinking is True


class TestEnableThinkingInRequest:
    def test_build_request_body_without_enable_thinking(self):
        config = _make_config()
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["extra_body"] is None

    def test_build_request_body_with_enable_thinking_from_config(self):
        config = _make_config(enable_thinking=True)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["extra_body"]["enable_thinking"] is True

    def test_build_request_body_with_enable_thinking_from_kwargs(self):
        config = _make_config(enable_thinking=True)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body(
            [{"role": "user", "content": "hi"}], enable_thinking=False
        )
        assert body["extra_body"]["enable_thinking"] is False

    def test_build_request_body_with_enable_thinking_false(self):
        config = _make_config(enable_thinking=False)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["extra_body"]["enable_thinking"] is False

    def test_build_request_body_preserves_other_params(self):
        config = _make_config(enable_thinking=True, temperature=0.5, max_tokens=100)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["extra_body"]["enable_thinking"] is True
        assert body["temperature"] == 0.5
        assert body["max_tokens"] == 100
        assert body["model"] == "gpt-4o"

    def test_build_request_body_preserves_existing_extra_body(self):
        config = _make_config(
            enable_thinking=False,
            extra_body={"chat_template_kwargs": {"foo": "bar"}},
        )
        llm = OpenAILLM.__new__(OpenAILLM)
        llm.config = config

        body = llm._build_request_body([{"role": "user", "content": "hi"}])

        assert body["extra_body"] == {
            "chat_template_kwargs": {"foo": "bar"},
            "enable_thinking": False,
        }


class TestEnableThinkingWithRealSDK:
    @staticmethod
    def _make_llm(handler, *, enable_thinking):
        config = _make_config(
            api_base="http://test.local/v1",
            enable_thinking=enable_thinking,
        )
        llm = OpenAILLM(config)
        llm.client = openai.Client(
            api_key="test-key",
            base_url="http://test.local/v1",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        return llm

    def test_generate_serializes_enable_thinking_in_http_body(self):
        captured_body = {}

        def handler(request):
            captured_body.update(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "id": "chatcmpl-test",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "test-model",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "ok"},
                        }
                    ],
                },
            )

        llm = self._make_llm(handler, enable_thinking=True)

        assert llm.generate([{"role": "user", "content": "hi"}]) == "ok"
        assert captured_body["enable_thinking"] is True

    def test_generate_stream_serializes_override_in_http_body(self):
        captured_body = {}

        def handler(request):
            captured_body.update(json.loads(request.content))
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=b"data: [DONE]\n\n",
            )

        llm = self._make_llm(handler, enable_thinking=True)

        assert (
            list(llm.generate_stream([{"role": "user", "content": "hi"}], enable_thinking=False))
            == []
        )
        assert captured_body["enable_thinking"] is False

    def test_azure_generate_serializes_enable_thinking_in_http_body(self):
        captured_body = {}

        def handler(request):
            captured_body.update(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "id": "chatcmpl-test",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "test-model",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "ok"},
                        }
                    ],
                },
            )

        llm = AzureLLM.__new__(AzureLLM)
        llm.config = AzureLLMConfig(
            api_key="test-key",
            model_name_or_path="test-model",
            enable_thinking=False,
        )
        llm.client = openai.Client(
            api_key="test-key",
            base_url="http://test.local/v1",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

        assert llm.generate([{"role": "user", "content": "hi"}]) == "ok"
        assert captured_body["enable_thinking"] is False

    def test_azure_generate_stream_serializes_override_in_http_body(self):
        captured_body = {}

        def handler(request):
            captured_body.update(json.loads(request.content))
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=b"data: [DONE]\n\n",
            )

        llm = AzureLLM.__new__(AzureLLM)
        llm.config = AzureLLMConfig(
            api_key="test-key",
            model_name_or_path="test-model",
            enable_thinking=True,
        )
        llm.client = openai.Client(
            api_key="test-key",
            base_url="http://test.local/v1",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

        assert (
            list(
                llm.generate_stream(
                    [{"role": "user", "content": "hi"}],
                    enable_thinking=False,
                    extra_body={"vendor_option": "keep"},
                )
            )
            == []
        )
        assert captured_body["enable_thinking"] is False
        assert captured_body["vendor_option"] == "keep"
