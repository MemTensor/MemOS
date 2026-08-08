"""Tests for enable_thinking parameter in OpenAILLM."""

from memos.configs.llm import OpenAILLMConfig
from memos.llms.openai import OpenAILLM


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


class TestEnableThinkingInRequest:
    def test_build_request_body_without_enable_thinking(self):
        config = _make_config()
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert "enable_thinking" not in body

    def test_build_request_body_with_enable_thinking_from_config(self):
        config = _make_config(enable_thinking=True)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["enable_thinking"] is True

    def test_build_request_body_with_enable_thinking_from_kwargs(self):
        config = _make_config(enable_thinking=True)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body(
            [{"role": "user", "content": "hi"}], enable_thinking=False
        )
        assert body["enable_thinking"] is False

    def test_build_request_body_with_enable_thinking_false(self):
        config = _make_config(enable_thinking=False)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["enable_thinking"] is False

    def test_build_request_body_preserves_other_params(self):
        config = _make_config(enable_thinking=True, temperature=0.5, max_tokens=100)
        embedder = OpenAILLM.__new__(OpenAILLM)
        embedder.config = config

        body = embedder._build_request_body([{"role": "user", "content": "hi"}])
        assert body["enable_thinking"] is True
        assert body["temperature"] == 0.5
        assert body["max_tokens"] == 100
        assert body["model"] == "gpt-4o"
