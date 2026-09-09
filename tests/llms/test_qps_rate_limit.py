"""QPS limiter configuration, local queue and SDK integration tests."""

import json
import socket
import threading
import time

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import openai
import pytest

from pydantic import ValidationError

from memos.configs.llm import OpenAILLMConfig
from memos.configs.llm_rate_limit import LLMRateLimitConfig, QPSLimitRule
from memos.exceptions import LLMRateLimitError, LLMRateLimitQueueFullError, LLMRateLimitTimeoutError
from memos.llms import rate_limit
from memos.llms.openai import OpenAILLM


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    import os

    for key in list(os.environ):
        if key.startswith(("MEMOS_LLM_RATE_LIMIT_", "MEMSCHEDULER_REDIS_")):
            monkeypatch.delenv(key)
    monkeypatch.setattr(rate_limit, "_registry", {})

    def reject_network(*args, **kwargs):
        pytest.fail("Unit tests must mock external connections")

    monkeypatch.setattr(socket.socket, "connect", reject_network)
    monkeypatch.setattr(socket.socket, "connect_ex", reject_network)


def settings(**kwargs):
    return LLMRateLimitConfig(enabled=True, redis_host="test.invalid", **kwargs)


def test_env_and_explicit_precedence(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", '{"gpt-4o-mini":{"qps":8}}')
    monkeypatch.setenv("MEMSCHEDULER_REDIS_HOST", "scheduler.invalid")
    monkeypatch.setenv("MEMSCHEDULER_REDIS_DB", "3")
    config = OpenAILLMConfig(
        api_key="test", model_name_or_path="gpt-4o-mini", rate_limit={"redis_db": 4}
    ).rate_limit
    rule = config.rule_for("gpt-4o-mini")
    assert (config.enabled, rule.qps, rule.burst) == (True, 8, 2)
    assert (config.redis_host, config.redis_db) == ("scheduler.invalid", 4)
    disabled = LLMRateLimitConfig.load({"enabled": False})
    assert disabled.rule_for("gpt-4o-mini") is None


def test_model_rules_inherit_defaults_and_omit_unselected_models():
    config = settings(qps=8, rules={"special": {"burst": 3}})
    assert config.rule_for("special").qps == 8
    assert config.rule_for("special").burst == 3
    assert config.rule_for("gpt-4o-mini") is None


@pytest.mark.parametrize(
    "bad",
    [
        {"qps": 0},
        {"qps": float("nan")},
        {"qps": float("inf")},
        {"burst": 0},
        {"queue_capacity": 0},
        {"max_wait_seconds": -1},
        {"retry_attempts": -1},
        {"retry_initial_delay": 3, "retry_max_delay": 1},
        {"burst": 1.5},
        {"rules": {"special": {"qps": -1}}},
        {"rules": {"special": {"typo": 1}}},
        {"scope": "shared"},
    ],
)
def test_invalid_parameters_fail_validation(bad):
    with pytest.raises(ValidationError):
        settings(**bad)


def make_limiter(monkeypatch, script, **kwargs):
    config = settings(**kwargs)
    fake = MagicMock()
    fake.register_script.return_value = script
    monkeypatch.setattr(rate_limit, "_create_redis_client", lambda _: fake)
    return rate_limit.get_limiter(config, config.rule_for("gpt-4o-mini"), "gpt-4o-mini")


def test_wait_uses_returned_delay_and_passes_one_key(monkeypatch):
    script = MagicMock(side_effect=[[0, 1000], [1, 0]])
    limiter = make_limiter(monkeypatch, script, wait_jitter_seconds=0)
    limiter.acquire(timeout_seconds=1)
    assert script.call_count == 2
    assert len(script.call_args.kwargs["keys"]) == 1
    assert script.call_args.kwargs["args"] == [200000, 2]


def test_wait_timeout_leaves_queue_usable(monkeypatch):
    script = MagicMock(return_value=[0, 1000000])
    limiter = make_limiter(monkeypatch, script)
    with pytest.raises(LLMRateLimitTimeoutError):
        limiter.acquire(timeout_seconds=0.02)
    script.return_value = [1, 0]
    limiter.acquire(timeout_seconds=1)


def test_only_queue_head_checks_redis_and_queue_is_bounded(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def script(**_):
        entered.set()
        assert release.wait(2)
        return [1, 0]

    mocked = MagicMock(side_effect=script)
    limiter = make_limiter(monkeypatch, mocked, queue_capacity=2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(limiter.acquire, 1)
        assert entered.wait(1)
        second = pool.submit(limiter.acquire, 1)
        deadline = time.monotonic() + 1
        while limiter.pending_count != 2 and time.monotonic() < deadline:
            time.sleep(0.001)
        try:
            assert limiter.pending_count == 2
            assert mocked.call_count == 1
            with pytest.raises(LLMRateLimitQueueFullError):
                limiter.acquire(1)
        finally:
            release.set()
        first.result()
        second.result()
    assert limiter.pending_count == 0


@pytest.mark.parametrize("mode,raises", [("closed", True), ("open", False)])
def test_redis_outage_policy_and_cleanup(monkeypatch, mode, raises):
    redis = pytest.importorskip("redis")
    script = MagicMock(side_effect=redis.ConnectionError("unavailable"))
    limiter = make_limiter(monkeypatch, script, failure_mode=mode)
    if raises:
        with pytest.raises(LLMRateLimitError):
            limiter.acquire(1)
    else:
        limiter.acquire(1)
    assert limiter.pending_count == 0


def test_registry_rejects_conflicting_policy(monkeypatch):
    from memos.exceptions import ConfigurationError

    make_limiter(monkeypatch, MagicMock(return_value=[1, 0]))
    with pytest.raises(ConfigurationError):
        make_limiter(monkeypatch, MagicMock(return_value=[1, 0]), qps=8)


def response_body():
    return {
        "id": "test",
        "object": "chat.completion",
        "created": 0,
        "model": "gpt-4o-mini",
        "choices": [
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}
        ],
    }


def make_llm(monkeypatch, handler, **overrides):
    config = OpenAILLMConfig(
        api_key="test",
        model_name_or_path="gpt-4o-mini",
        api_base="https://api.test/v1",
        rate_limit=settings(retry_initial_delay=0.001, retry_max_delay=0.01),
        **overrides,
    )
    llm = OpenAILLM(config)
    llm.client.close()
    llm.client = openai.Client(
        api_key="test",
        base_url="https://api.test/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    limiter = MagicMock()
    monkeypatch.setattr(rate_limit, "get_limiter", MagicMock(return_value=limiter))
    return llm, limiter


def test_every_wire_retry_acquires_and_sdk_retries_do_not_bypass(monkeypatch):
    wire_calls = []

    def handler(_):
        wire_calls.append(1)
        return httpx.Response(429, json={"error": {"message": "limited", "type": "rate_limit"}})

    llm, limiter = make_llm(monkeypatch, handler)
    with pytest.raises(openai.RateLimitError):
        llm.generate([{"role": "user", "content": "test"}])
    assert len(wire_calls) == limiter.acquire.call_count == 2
    llm.client.close()


def test_disabled_keeps_original_client_path(monkeypatch):
    llm, _ = make_llm(monkeypatch, lambda _: httpx.Response(200, json=response_body()))
    llm.config.rate_limit.enabled = False
    assert llm.generate([]) == "ok"
    rate_limit.get_limiter.assert_not_called()
    llm.client.close()


def test_actual_model_override_selects_policy(monkeypatch):
    llm, limiter = make_llm(monkeypatch, lambda _: httpx.Response(200, json=response_body()))
    llm.config.rate_limit.rules["override"] = {"qps": 3}
    assert llm.generate([], model_name_or_path="override") == "ok"
    assert rate_limit.get_limiter.call_args.args[-1] == "override"
    limiter.acquire.assert_called_once()
    llm.client.close()


def test_local_timeout_does_not_trigger_backup(monkeypatch):
    llm, limiter = make_llm(monkeypatch, lambda _: httpx.Response(200, json=response_body()))
    llm.use_backup_client = True
    llm.backup_client = MagicMock()
    limiter.acquire.side_effect = LLMRateLimitTimeoutError("deadline")
    with pytest.raises(LLMRateLimitTimeoutError):
        llm.generate([])
    llm.backup_client.chat.completions.create.assert_not_called()
    llm.client.close()


def test_stream_creation_is_limited_and_midstream_errors_are_not_replayed(monkeypatch):
    class BrokenStream(httpx.SyncByteStream):
        def __iter__(self):
            chunk = {
                "id": "test",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "gpt-4o-mini",
                "choices": [{"index": 0, "delta": {"content": "hello"}}],
            }
            yield ("data: " + json.dumps(chunk) + "\n\n").encode()
            raise httpx.ReadError("stream interrupted")

    llm, limiter = make_llm(
        monkeypatch,
        lambda _: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=BrokenStream()
        ),
    )
    stream = llm.generate_stream([])
    assert next(stream) == "hello"
    with pytest.raises(httpx.ReadError):
        next(stream)
    limiter.acquire.assert_called_once()
    llm.client.close()


def test_closing_generator_closes_provider_stream(monkeypatch):
    from types import SimpleNamespace

    llm, _ = make_llm(monkeypatch, lambda _: httpx.Response(200, json=response_body()))
    provider = MagicMock()
    provider.__iter__.return_value = iter(
        [SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="hello"))])]
    )
    monkeypatch.setattr(rate_limit, "create_completion", lambda *_: provider)
    stream = llm.generate_stream([])
    assert next(stream) == "hello"
    stream.close()
    provider.close.assert_called_once()
    llm.client.close()


def test_backup_attempt_is_also_limited(monkeypatch):
    llm, limiter = make_llm(
        monkeypatch,
        lambda _: httpx.Response(429, json={"error": {"message": "limited", "type": "rate_limit"}}),
    )
    llm.config.rate_limit.retry_attempts = 0
    llm.config.rate_limit.rules["backup"] = {"qps": 3, "burst": 1}
    llm.config.backup_model_name_or_path = "backup"
    llm.use_backup_client = True
    llm.backup_client = openai.Client(
        api_key="test-backup",
        base_url="https://backup.test/v1",
        http_client=httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response_body()))
        ),
    )
    assert llm.generate([]) == "ok"
    assert limiter.acquire.call_count == 2
    assert [call.args[-1] for call in rate_limit.get_limiter.call_args_list] == [
        "gpt-4o-mini",
        "backup",
    ]
    llm.client.close()
    llm.backup_client.close()


def test_nonretryable_status_and_retry_after_budget(monkeypatch):
    for status, headers in [(400, {}), (401, {}), (429, {"retry-after": "60"})]:
        llm, limiter = make_llm(
            monkeypatch,
            lambda _, status=status, headers=headers: httpx.Response(
                status, headers=headers, json={"error": {"message": "test", "type": "test"}}
            ),
        )
        with pytest.raises(openai.APIStatusError):
            llm.generate([])
        limiter.acquire.assert_called_once()
        llm.client.close()


def test_retry_after_is_honored():
    error = openai.RateLimitError(
        "test",
        response=httpx.Response(
            429,
            headers={"retry-after-ms": "1500"},
            request=httpx.Request("POST", "https://api.test"),
        ),
        body=None,
    )
    assert rate_limit._retry_delay(error, QPSLimitRule(), 0) == 1.5


def test_permit_budget_is_shared_between_retries(monkeypatch):
    now = 100.0

    def advance(seconds):
        nonlocal now
        now += seconds

    # Keep the clock local to the limiter so SDK/logging clocks are unaffected.
    backoff = MagicMock(side_effect=advance)
    monkeypatch.setattr(rate_limit, "time", SimpleNamespace(monotonic=lambda: now, sleep=backoff))
    replies = [
        httpx.Response(429, json={"error": {"message": "test"}}),
        httpx.Response(200, json=response_body()),
    ]

    def respond(_):
        advance(10.0)
        return replies.pop(0)

    llm, limiter = make_llm(monkeypatch, respond)
    limiter.acquire.side_effect = lambda **_: advance(0.25)
    try:
        assert llm.generate([]) == "ok"
        budgets = [call.kwargs["timeout_seconds"] for call in limiter.acquire.call_args_list]
        initial_budget = llm.config.rate_limit.rule_for("gpt-4o-mini").max_wait_seconds
        # Deduct permit waiting only, excluding model I/O and retry backoff.
        assert budgets == pytest.approx([initial_budget, initial_budget - 0.25])
        backoff.assert_called_once()
    finally:
        llm.client.close()


def test_expired_waiter_does_not_send_when_redis_returns_late(monkeypatch):
    def late(**_):
        time.sleep(0.02)
        return [1, 0]

    limiter = make_limiter(monkeypatch, late)
    with pytest.raises(LLMRateLimitTimeoutError):
        limiter.acquire(0.005)
    assert limiter.pending_count == 0


def test_interruption_removes_queue_head(monkeypatch):
    script = MagicMock(side_effect=[KeyboardInterrupt(), [1, 0]])
    limiter = make_limiter(monkeypatch, script)
    with pytest.raises(KeyboardInterrupt):
        limiter.acquire(1)
    limiter.acquire(1)
    assert limiter.pending_count == 0


@pytest.mark.parametrize("prefix_override", [{}, {"key_prefix": "test:custom:gcra"}])
def test_model_keys_share_instances_but_isolate_models(monkeypatch, prefix_override):
    monkeypatch.setattr(rate_limit, "_create_redis_client", lambda _: MagicMock())
    config = settings(
        redis_password="test-password",
        rules={"gpt-4o-mini": {}, "other": {"qps": 3, "burst": 1}},
        **prefix_override,
    )
    rule = config.rule_for("gpt-4o-mini")
    first = rate_limit.get_limiter(config, rule, "gpt-4o-mini")
    second = rate_limit.get_limiter(config.model_copy(deep=True), rule, "gpt-4o-mini")
    other = rate_limit.get_limiter(config, config.rule_for("other"), "other")
    assert first is second
    assert first is not other
    assert first.redis_key == f"{config.key_prefix}:gpt-4o-mini"
    assert other.redis_key == f"{config.key_prefix}:other"
    assert (first.rule.qps, first.rule.burst) == (5, 2)
    assert (other.rule.qps, other.rule.burst) == (3, 1)
    first._queue.append(object())
    assert other.pending_count == 0
    assert "test-password" not in first.redis_key
    assert "test-password" not in repr(config)


def test_fork_reset_drops_local_queue_registry():
    rate_limit._registry["test"] = object()
    old_lock = rate_limit._registry_lock
    rate_limit._after_fork()
    assert rate_limit._registry == {}
    assert old_lock is not rate_limit._registry_lock


@pytest.mark.parametrize("reply", [None, [0, 0], [0, "invalid"], [2, 0], [1, 0, 0]])
def test_malformed_redis_reply_never_fails_open(monkeypatch, reply):
    limiter = make_limiter(monkeypatch, MagicMock(return_value=reply), failure_mode="open")
    with pytest.raises(LLMRateLimitError):
        limiter.acquire(1)
    assert limiter.pending_count == 0


def test_qwen_wait_header_survives_managed_sdk_copy(monkeypatch):
    from memos.configs.llm import QwenLLMConfig
    from memos.llms.qwen import QwenLLM

    captured = []

    def handler(request):
        captured.append(request.headers.get("X-DashScope-Wait-Timeout"))
        return httpx.Response(200, json=response_body())

    llm = QwenLLM(
        QwenLLMConfig(
            api_key="test",
            api_base="https://api.test/v1",
            model_name_or_path="qwen-flash",
            rate_limit=settings(rules={"qwen-flash": {}}),
        )
    )
    headers = llm.config.default_headers
    llm.client.close()
    llm.client = openai.Client(
        api_key="test",
        base_url="https://api.test/v1",
        default_headers=headers,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(rate_limit, "get_limiter", MagicMock(return_value=MagicMock()))
    assert llm.generate([]) == "ok"
    assert captured == [headers["X-DashScope-Wait-Timeout"]]
    llm.client.close()
