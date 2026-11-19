import json

import httpx
import pytest

from memos.project_memory.config import build_llm, llm_config


@pytest.fixture
def model_env(monkeypatch):
    monkeypatch.setenv("PROJECT_MEMORY_LLM_BACKEND", "openai")
    monkeypatch.setenv("PROJECT_MEMORY_LLM_MODEL", "deepseek-test")
    monkeypatch.setenv("PROJECT_MEMORY_LLM_API_BASE", "https://model.invalid/v1")
    monkeypatch.setenv("PROJECT_MEMORY_LLM_API_KEY", "test-token")
    monkeypatch.delenv("PROJECT_MEMORY_LLM_THINKING_MODE", raising=False)
    monkeypatch.delenv("PROJECT_MEMORY_JUDGE_LLM_THINKING_MODE", raising=False)
    return monkeypatch


def test_project_thinking_mode_reaches_chat_completion(model_env):
    from openai import OpenAI

    model_env.setenv("PROJECT_MEMORY_LLM_THINKING_MODE", "disabled")
    recorded = []

    def respond(request):
        recorded.append((request.url.path, json.loads(request.content)))
        return httpx.Response(
            200,
            json={
                "id": "completion",
                "object": "chat.completion",
                "created": 1,
                "model": "deepseek-test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": '{"ok":true}'},
                        "finish_reason": "stop",
                    },
                ],
            },
        )

    llm = build_llm()
    transport = httpx.MockTransport(respond)
    with OpenAI(
        api_key="test-token",
        base_url="https://model.invalid/v1",
        http_client=httpx.Client(transport=transport),
    ) as client:
        llm.client = client
        assert llm.generate([{"role": "user", "content": "Return JSON"}]) == '{"ok":true}'

    [(path, payload)] = recorded
    assert path == "/v1/chat/completions"
    assert payload["model"] == "deepseek-test"
    assert payload["thinking"] == {"type": "disabled"}


def test_thinking_mode_is_opt_in_and_can_differ_for_internal_judge(model_env):
    assert llm_config()["config"].get("extra_body") is None
    model_env.setenv("PROJECT_MEMORY_LLM_THINKING_MODE", "disabled")
    assert llm_config("PROJECT_MEMORY_JUDGE_LLM")["config"].get("extra_body") is None
    model_env.setenv("PROJECT_MEMORY_JUDGE_LLM_THINKING_MODE", "enabled")
    assert llm_config("PROJECT_MEMORY_JUDGE_LLM")["config"]["extra_body"] == {
        "thinking": {"type": "enabled"}
    }


@pytest.mark.parametrize(
    ("backend", "mode"),
    [("openai", "fast"), ("ollama", "disabled"), ("openai_new", "disabled")],
)
def test_thinking_mode_rejects_invalid_configuration(model_env, backend, mode):
    model_env.setenv("PROJECT_MEMORY_LLM_BACKEND", backend)
    model_env.setenv("PROJECT_MEMORY_LLM_THINKING_MODE", mode)
    with pytest.raises(ValueError, match="PROJECT_MEMORY_LLM_THINKING_MODE"):
        llm_config()
