"""Regression tests for issue #2424.

``EnvConfigMixin.from_env`` previously raised ``ValueError()`` with an
empty message whenever a field declared as ``field: int | None = None``
had no environment variable set — so any config with a plain optional
field could not be built from the environment at all. This is on the
scheduler init path (``memos/configs/mem_scheduler.py`` calls
``RabbitMQConfig.from_env()``).

The secondary bug: ``_parse_env_value`` only parses when the annotation
is exactly ``bool``/``int``/``float``, so an ``Optional[int]`` field with
an env var keeps the raw string instead of being cast.

These tests pin the new contract:

- absent optional fields fall back to the model default
- ``Optional[int]`` env vars parse as ``int``
- genuinely required fields still raise the named error
"""

from __future__ import annotations

import pytest

from pydantic import BaseModel

from memos.mem_scheduler.general_modules.misc import EnvConfigMixin


class RabbitLikeConfig(BaseModel, EnvConfigMixin):
    """Stand-in for the scheduler's RabbitMQConfig."""

    host: str = "localhost"
    port: int | None = None
    tls: bool = False


class RequiredFieldConfig(BaseModel, EnvConfigMixin):
    name: str


class TestFromEnvAbsentOptional:
    def test_absent_optional_int_field_falls_back_to_none(self, monkeypatch):
        # No MEMOSCHEDULER_RABBITLIKE_PORT set.
        monkeypatch.delenv("MEMSCHEDULER_RABBITLIKE_PORT", raising=False)
        cfg = RabbitLikeConfig.from_env()
        assert cfg.port is None  # was: bare ValueError()

    def test_absent_optional_str_field_falls_back_to_default(self, monkeypatch):
        monkeypatch.delenv("MEMSCHEDULER_RABBITLIKE_HOST", raising=False)
        cfg = RabbitLikeConfig.from_env()
        assert cfg.host == "localhost"


class TestFromEnvOptionalIntParses:
    def test_optional_int_env_var_parses_as_int(self, monkeypatch):
        monkeypatch.setenv("MEMSCHEDULER_RABBITLIKE_PORT", "5672")
        cfg = RabbitLikeConfig.from_env()
        assert cfg.port == 5672
        assert isinstance(cfg.port, int)


class TestFromEnvBoolStillParses:
    def test_bool_env_var_parses_as_bool(self, monkeypatch):
        monkeypatch.setenv("MEMSCHEDULER_RABBITLIKE_TLS", "yes")
        cfg = RabbitLikeConfig.from_env()
        assert cfg.tls is True


class TestFromEnvRequiredStillRaises:
    def test_missing_required_field_raises_named_value_error(self, monkeypatch):
        monkeypatch.delenv("MEMSCHEDULER_REQUIREDFIELD_NAME", raising=False)
        with pytest.raises(ValueError) as exc_info:
            RequiredFieldConfig.from_env()
        # Must carry a meaningful message — the empty ``ValueError()`` of
        # the unpatched code is what this PR fixes.
        assert "MEMSCHEDULER_REQUIREDFIELD_NAME" in str(exc_info.value)
        assert "missing" in str(exc_info.value).lower()
