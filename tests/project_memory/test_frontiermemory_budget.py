import json

import httpx
import pytest

from evaluation.frontiermemory_topic.budget import (
    BudgetStopError,
    budget_scope,
    build_budgeted_llm,
)


MODEL = "deepseek-v4.1-flash-1017"
MESSAGES = [{"role": "user", "content": "pilot fixture text"}]


@pytest.fixture
def profile(tmp_path):
    path = tmp_path / "deepseek.env"
    path.write_text(
        f"MODEL={MODEL}\nOPENAI_API_BASE=https://gateway.invalid/v1\nOPENAI_API_KEY=fixture-token\n"
    )
    return path


def completion(*, model="deepseek-v4-1-flash-261017", usage=None):
    result = {
        "id": "test-completion",
        "object": "chat.completion",
        "created": 1,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": '{"ok":true}'},
                "finish_reason": "stop",
            },
        ],
    }
    if usage is not None:
        result["usage"] = usage
    return httpx.Response(200, json=result)


def make_llm(profile, handler, *, cap=1.0):
    return build_budgeted_llm(
        profile,
        profile.with_name("usage.jsonl"),
        cap_usd=cap,
        transport=httpx.MockTransport(handler),
    )


def test_only_accounts_for_pinned_model_thinking_disabled_and_stage(profile):
    def respond(request):
        assert str(request.url) == "https://gateway.invalid/v1/chat/completions"
        payload = json.loads(request.content)
        assert payload["model"] == MODEL
        assert payload["max_tokens"] == 4096
        assert payload["thinking"] == {"type": "disabled"}
        assert payload["temperature"] == 0
        return completion(
            usage={"prompt_tokens": 96, "completion_tokens": 12, "prompt_cache_hit_tokens": 20}
        )

    llm = make_llm(profile, respond)
    with budget_scope("episode.extract"):
        assert llm.generate(MESSAGES) == '{"ok":true}'

    summary = llm.ledger.summary()
    assert summary["requests"] == 1
    assert summary["recorded_usage"] == 1
    assert summary["input_tokens"] == 96
    assert summary["cached_input_tokens"] == 20
    assert summary["output_tokens"] == 12
    assert summary["estimated_usd"] == pytest.approx((96 * 0.30 + 12 * 1.20) / 1_000_000)
    assert summary["by_scope"]["episode.extract"]["requests"] == 1
    ledger = profile.with_name("usage.jsonl").read_text()
    assert "fixture-token" not in ledger
    assert "pilot fixture text" not in ledger


def test_reservation_blocks_before_request_and_survives_restart_without_usage(profile):
    requests = []

    def handler(request):
        requests.append(request)
        return completion()

    first = make_llm(profile, handler, cap=0.006)
    first.generate(MESSAGES)
    assert first.ledger.summary()["requests_without_usage"] == 1

    restarted = make_llm(profile, handler, cap=0.006)
    with pytest.raises(BudgetStopError, match="budget"):
        restarted.generate(MESSAGES)
    assert len(requests) == 1
    assert restarted.ledger.summary()["estimated_usd"] > 0
    with pytest.raises(BudgetStopError):
        restarted.ledger.ensure_open()


def test_stops_on_model_mismatch_before_followup_and_persists(profile):
    calls = []

    def mismatch(request):
        calls.append(request)
        return completion(model="other-provider-model")

    with pytest.raises(BudgetStopError, match="model"):
        make_llm(profile, mismatch).generate(MESSAGES)
    other = make_llm(profile, mismatch)
    with pytest.raises(BudgetStopError, match="model"):
        other.generate(MESSAGES)
    assert len(calls) == 1
    assert other.ledger.summary()["requests_without_usage"] == 1


def test_network_failure_is_not_automatically_retried_and_is_charged(profile):
    calls = []

    def fail(request):
        calls.append(request)
        raise httpx.ReadTimeout("raw gateway detail with fixture-token")

    llm = make_llm(profile, fail)
    with pytest.raises(Exception, match="gateway") as failure:
        llm.generate(MESSAGES)
    assert "fixture-token" not in str(failure.value)
    assert len(calls) == 1
    assert llm.ledger.summary()["requests_without_usage"] == 1


def test_rejects_wrong_config_and_unsupported_wire_options_without_cost(profile):
    def unexpected(_):
        pytest.fail("Unexpected billable request")

    llm = make_llm(profile, unexpected)
    with pytest.raises(BudgetStopError, match="request"):
        llm.generate(MESSAGES, model_name_or_path="not-deepseek")
    assert llm.ledger.summary()["requests"] == 0

    profile.write_text(profile.read_text().replace(MODEL, "not-deepseek"))
    with pytest.raises(ValueError, match="model"):
        make_llm(profile, unexpected)
