"""Startup policy loading without production environment or external services."""

import os

from pathlib import Path

import pytest

from dotenv import dotenv_values

from memos.configs.llm import LLMConfigFactory, OpenAILLMConfig
from memos.configs.llm_rate_limit import LLMRateLimitConfig
from memos.exceptions import ConfigurationError


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for key in list(os.environ):
        if key.startswith(("MEMOS_LLM_RATE_LIMIT_", "MEMSCHEDULER_REDIS_")):
            monkeypatch.delenv(key)


def test_rules_are_the_only_model_selection(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", '{"extra": {"qps": 2, "burst": 1}}')
    config = LLMRateLimitConfig.load()
    assert config.rule_for("extra").qps == 2
    assert config.rule_for("gpt-4o-mini") is None
    assert config.rule_for("unlisted") is None
    assert "models" not in config.model_dump()


@pytest.mark.parametrize("rules", [None, '{"gpt-4o-mini":{}}'])
def test_default_rule_values(monkeypatch, rules):
    assert LLMRateLimitConfig.load().enabled is False
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    if rules is not None:
        monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", rules)
    rule = LLMRateLimitConfig.load().rule_for("gpt-4o-mini")
    assert (
        rule.qps,
        rule.burst,
        rule.max_wait_seconds,
        rule.queue_capacity,
        rule.retry_attempts,
    ) == (5, 2, 30, 16, 1)


def test_docker_full_example_is_disabled_and_matches_defaults(monkeypatch):
    example = Path(__file__).resolve().parents[2] / "docker" / ".env.example-full"
    values = dotenv_values(example, interpolate=False)
    assert values["MEMOS_LLM_RATE_LIMIT_ENABLED"] == "false"
    for name in ("MEMOS_LLM_RATE_LIMIT_ENABLED", "MEMOS_LLM_RATE_LIMIT_RULES"):
        monkeypatch.setenv(name, values[name])
    config = LLMRateLimitConfig.load()
    assert config.enabled is False
    assert set(config.rules) == {values["MOS_CHAT_MODEL"]}
    assert config.rule_for("gpt-4o-mini") is None
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    rule = LLMRateLimitConfig.load().rule_for("gpt-4o-mini")
    defaults = LLMRateLimitConfig(enabled=True).rule_for("gpt-4o-mini")
    assert rule is not None
    assert rule == defaults


def test_multiple_models_need_only_qps_and_burst(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv(
        "MEMOS_LLM_RATE_LIMIT_RULES",
        '{"gpt-4o-mini":{"qps":5,"burst":2},"other":{"qps":3,"burst":1}}',
    )
    config = LLMRateLimitConfig.load()
    assert (config.rule_for("gpt-4o-mini").qps, config.rule_for("gpt-4o-mini").burst) == (5, 2)
    assert (config.rule_for("other").qps, config.rule_for("other").burst) == (3, 1)
    assert config.rule_for("unlisted") is None
    assert "scope" not in config.model_dump()


@pytest.mark.parametrize(
    "suffix",
    ["SCOPE", "MODELS", "QPS", "BURST", "WAIT_JITTER_SECONDS", "REDIS_HOST", "CONFIG_FILE"],
)
def test_removed_environment_settings_are_rejected(monkeypatch, suffix):
    monkeypatch.setenv(f"MEMOS_LLM_RATE_LIMIT_{suffix}", "obsolete")
    with pytest.raises(ConfigurationError, match=suffix):
        LLMRateLimitConfig.load()


def test_explicit_override_wins_over_invalid_environment(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", "invalid")
    assert LLMRateLimitConfig.load({"rules": {}}).rules == {}
    with pytest.raises(ConfigurationError, match="rules"):
        LLMRateLimitConfig.load()


def test_all_supported_rule_fields_and_internal_defaults(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv(
        "MEMOS_LLM_RATE_LIMIT_RULES",
        '{"gpt-4o-mini":{"qps":3,"burst":1,"max_wait_seconds":10,'
        '"queue_capacity":8,"retry_attempts":2}}',
    )
    rule = LLMRateLimitConfig.load().rule_for("gpt-4o-mini")
    assert (
        rule.qps,
        rule.burst,
        rule.max_wait_seconds,
        rule.queue_capacity,
        rule.retry_attempts,
    ) == (3, 1, 10, 8, 2)
    assert (rule.wait_jitter_seconds, rule.retry_initial_delay, rule.retry_max_delay) == (
        0.01,
        1,
        8,
    )


@pytest.mark.parametrize(
    "field", ["wait_jitter_seconds", "retry_initial_delay", "retry_max_delay", "enabled", "scope"]
)
def test_rules_do_not_expose_internal_tuning(monkeypatch, field):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", '{"extra":{"' + field + '":1}}')
    with pytest.raises(ValueError):
        LLMRateLimitConfig.load()


def test_empty_rules_disable_all_models(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", "{}")
    assert LLMRateLimitConfig.load().rule_for("gpt-4o-mini") is None


def test_settings_are_snapshotted_not_read_for_every_request(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "true")
    config = OpenAILLMConfig(api_key="test", model_name_or_path="gpt-4o-mini")
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_ENABLED", "false")
    assert config.rate_limit.rule_for("gpt-4o-mini") is not None
    assert (
        OpenAILLMConfig(api_key="test", model_name_or_path="gpt-4o-mini").rate_limit.enabled
        is False
    )


def test_factory_accepts_nested_policy_and_keeps_it_out_of_llm_body():
    config = LLMConfigFactory.model_validate(
        {
            "backend": "openai",
            "config": {
                "api_key": "test",
                "model_name_or_path": "gpt-4o-mini",
                "rate_limit": {"enabled": True, "qps": 4, "redis_host": "test.invalid"},
            },
        }
    )
    assert config.config.rate_limit.qps == 4
    from memos.llms.openai import OpenAILLM

    llm = OpenAILLM.__new__(OpenAILLM)
    llm.config = config.config
    assert "rate_limit" not in llm._build_request_body([])


def test_bad_rules_do_not_expose_contents(monkeypatch):
    monkeypatch.setenv("MEMOS_LLM_RATE_LIMIT_RULES", "private-test-content-not-json")
    with pytest.raises(ConfigurationError) as error:
        LLMRateLimitConfig.load()
    assert "private-test-content" not in str(error.value)


def test_scheduler_redis_reuse_and_explicit_override(monkeypatch):
    monkeypatch.setenv("MEMSCHEDULER_REDIS_HOST", "fallback.invalid")
    monkeypatch.setenv("MEMSCHEDULER_REDIS_DB", "3")
    monkeypatch.setenv("MEMSCHEDULER_REDIS_SSL", "true")
    config = LLMRateLimitConfig.load()
    assert (config.redis_host, config.redis_db, config.redis_ssl) == ("fallback.invalid", 3, True)
    assert LLMRateLimitConfig.load({"redis_db": 7}).redis_db == 7
