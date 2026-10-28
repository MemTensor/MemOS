"""Startup-loaded, opt-in QPS policies for OpenAI-compatible LLM calls."""

import math
import os

from typing import Any, Literal

from pydantic import ConfigDict, Field, TypeAdapter, model_validator

from memos.configs.base import BaseConfig
from memos.exceptions import ConfigurationError


_RULE_FIELDS = frozenset({"qps", "burst", "max_wait_seconds", "queue_capacity", "retry_attempts"})


class QPSLimitRule(BaseConfig):
    """A quota pool's pacing, waiting and retry policy; burst is total capacity."""

    enabled: bool = True
    qps: float = Field(default=5.0, ge=0.001, le=1_000_000, allow_inf_nan=False)
    burst: int = Field(default=2, ge=1, le=1_000_000)
    max_wait_seconds: float = Field(default=30.0, gt=0, le=3600, allow_inf_nan=False)
    queue_capacity: int = Field(default=16, ge=1, le=100_000)
    wait_jitter_seconds: float = Field(default=0.01, ge=0, le=1, allow_inf_nan=False)
    retry_attempts: int = Field(
        default=1, ge=0, le=10, description="Retries after the first attempt"
    )
    retry_initial_delay: float = Field(default=1.0, gt=0, le=300, allow_inf_nan=False)
    retry_max_delay: float = Field(default=8.0, gt=0, le=300, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_policy(self) -> "QPSLimitRule":
        if self.retry_initial_delay > self.retry_max_delay:
            raise ValueError("retry_initial_delay must not exceed retry_max_delay")
        if math.ceil(1_000_000 / self.qps) * self.burst > 1_000_000_000_000:
            raise ValueError("The burst recovery horizon must not exceed 1000000 seconds")
        return self


class LLMRateLimitConfig(QPSLimitRule):
    """Load enabled/rules from env and reuse scheduler Redis connection settings."""

    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)

    enabled: bool = False
    rules: dict[str, dict[str, Any]] = Field(
        default_factory=lambda: {"gpt-4o-mini": {}},
        description="Selected models and their QPS, burst, wait, queue and retry settings",
    )
    redis_host: str | None = Field(default=None, min_length=1)
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_db: int = Field(default=0, ge=0)
    redis_username: str | None = None
    redis_password: str | None = Field(default=None, repr=False)
    redis_ssl: bool = False
    redis_socket_timeout: float = Field(default=0.5, gt=0, le=30, allow_inf_nan=False)
    key_prefix: str = Field(default="memos:llm:gcra", min_length=1, max_length=128)
    failure_mode: Literal["closed", "open"] = "closed"

    def _base_rule(self) -> dict[str, Any]:
        return self.model_dump(include=set(QPSLimitRule.model_fields) - {"model_schema"})

    @model_validator(mode="after")
    def validate_rules(self) -> "LLMRateLimitConfig":
        for model, overrides in self.rules.items():
            if not model.strip() or model == "*":
                raise ValueError("rules must use explicit nonblank model names")
            if set(overrides) - _RULE_FIELDS:
                raise ValueError(
                    "rules only support qps, burst, max_wait_seconds, queue_capacity, retry_attempts"
                )
            QPSLimitRule.model_validate({**self._base_rule(), **overrides})
        if any(char in self.key_prefix for char in "{}") or not self.key_prefix.strip():
            raise ValueError("key_prefix must be nonblank and must not contain Redis hash tags")
        return self

    def rule_for(self, model: str) -> QPSLimitRule | None:
        """Resolve the actual wire model without applying policies to unlisted models."""
        if not self.enabled or model not in self.rules:
            return None
        return QPSLimitRule.model_validate({**self._base_rule(), **self.rules[model]})

    @classmethod
    def load(cls, overrides: dict[str, Any] | None = None) -> "LLMRateLimitConfig":
        """Read configuration at construction time; never load or modify .env here."""
        supported = {"MEMOS_LLM_RATE_LIMIT_ENABLED", "MEMOS_LLM_RATE_LIMIT_RULES"}
        unsupported = sorted(
            name
            for name in os.environ
            if name.startswith("MEMOS_LLM_RATE_LIMIT_") and name not in supported
        )
        if unsupported:
            raise ConfigurationError(
                "Only MEMOS_LLM_RATE_LIMIT_ENABLED and MEMOS_LLM_RATE_LIMIT_RULES are supported; "
                "remove: " + ", ".join(unsupported)
            )
        values: dict[str, Any] = {}
        env_values: dict[str, str] = {}
        for name in ("host", "port", "db", "username", "password", "ssl"):
            raw = os.getenv(f"MEMSCHEDULER_REDIS_{name.upper()}")
            if raw:
                env_values[f"redis_{name}"] = raw
        for name in ("enabled", "rules"):
            raw = os.getenv(f"MEMOS_LLM_RATE_LIMIT_{name.upper()}")
            if raw is not None:
                env_values[name] = raw
        explicit = overrides or {}
        for name, raw in env_values.items():
            if name in explicit:
                continue
            annotation = cls.model_fields[name].annotation
            adapter = TypeAdapter(annotation)
            try:
                values[name] = (
                    adapter.validate_json(raw, strict=False)
                    if name == "rules"
                    else adapter.validate_python(raw, strict=False)
                )
            except ValueError:
                raise ConfigurationError(
                    f"Invalid LLM rate limit environment setting: {name}"
                ) from None
        return cls.model_validate({**values, **explicit})
