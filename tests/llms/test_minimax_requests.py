"""Exercise MiniMax configuration through the SDK's serialized HTTP requests."""

import json

import httpx
import pytest

from memos.api.config import APIConfig
from memos.configs.llm import MinimaxLLMConfig
from memos.llms.minimax import MinimaxLLM


@pytest.mark.parametrize("model", [None, "MiniMax-M3", "MiniMax-M2.7", "custom-model"])
@pytest.mark.parametrize(
    "api_base",
    ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1", "https://gateway.test/v1"],
)
@pytest.mark.parametrize("stream", [False, True])
def test_minimax_default_and_saved_requests(monkeypatch, model, api_base, stream):
    monkeypatch.delenv("MOS_CHAT_MODEL", raising=False)
    if model is not None:
        monkeypatch.setenv("MOS_CHAT_MODEL", model)
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    monkeypatch.setenv("MINIMAX_API_BASE", api_base)
    config = MinimaxLLMConfig.model_validate(APIConfig.minimax_config())
    expected_model = model or "MiniMax-M3.1-Flash"
    messages = [{"role": "user", "content": "Hello"}]
    requests = []

    def respond(request):
        requests.append(request)
        if stream:
            chunk = {
                "id": "test-completion",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": expected_model,
                "choices": [{"index": 0, "delta": {"content": "Hello"}}],
            }
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n",
            )
        return httpx.Response(
            200,
            json={
                "id": "test-completion",
                "object": "chat.completion",
                "created": 0,
                "model": expected_model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hello"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    llm = MinimaxLLM(config)
    llm.client.close()
    with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
        llm.client = llm.client.with_options(http_client=transport)
        output = "".join(llm.generate_stream(messages)) if stream else llm.generate(messages)
    assert output == "Hello"
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == f"{api_base}/chat/completions"
    body = json.loads(request.content)
    assert body["model"] == expected_model
    assert body["messages"] == messages
    if stream:
        assert body["stream"] is True
    else:
        assert "stream" not in body
    assert "thinking" not in body
    assert "enable_thinking" not in body
    assert "reasoning_effort" not in body
    assert "reasoning_split" not in body
    assert "service_tier" not in body


@pytest.mark.parametrize(
    ("model", "extra_body"),
    [
        ("MiniMax-M3.1-Flash", {"thinking": {"type": "adaptive"}, "reasoning_effort": "high"}),
        ("MiniMax-M3", {"thinking": {"type": "disabled"}}),
        ("MiniMax-M2.7", {"custom_option": True}),
    ],
)
def test_minimax_explicit_request_preserves_options_and_history(model, extra_body):
    config = MinimaxLLMConfig.model_validate(
        {"model_name_or_path": "saved-model", "api_key": "test-key", "extra_body": extra_body}
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "https://example.test/image.png"}}
            ],
        },
        {
            "role": "assistant",
            "content": None,
            "reasoning_content": "Remember the image.",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "Found"},
    ]
    tools = [
        {
            "type": "function",
            "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}},
        }
    ]
    bodies = []

    def respond(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "test-completion",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Done"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    llm = MinimaxLLM(config)
    llm.client.close()
    with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
        llm.client = llm.client.with_options(http_client=transport)
        assert llm.generate(messages, model_name_or_path=model, tools=tools) == "Done"
    assert len(bodies) == 1
    body = bodies[0]
    assert body["model"] == model
    assert body["messages"] == messages
    assert body["tools"] == tools
    for key, value in extra_body.items():
        assert body[key] == value
    assert config.model_name_or_path == "saved-model"
