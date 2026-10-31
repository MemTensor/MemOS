"""Regression tests for issue #2553.

``is_internal_request()`` previously used plain ``==`` to compare the
``X-Internal-Service`` header against ``os.getenv("INTERNAL_SERVICE_SECRET")``.
When the environment variable was unset, ``os.getenv`` returned ``None`` — and
if the client omitted the header, ``request.headers.get(...)`` also returned
``None``. The comparison therefore evaluated to ``None == None`` → ``True`` and
every unauthenticated request was promoted to ``user_name="internal"`` with
``scopes=["all"]``.

These tests pin the new contract on both the raw helper and the
``verify_api_key`` dependency:

- unset / empty secret: ALWAYS fail closed, regardless of what the header says;
- set secret: only the exact header value authenticates; otherwise fail closed;
- loopback IPs still short-circuit as "internal" (behaviour deliberately
  preserved — see the issue note about ``INTERNAL_SERVICE_IPS``);
- the comparison uses ``secrets.compare_digest`` (timing-safe) rather than
  ``==``.
"""

from __future__ import annotations

import asyncio

from types import SimpleNamespace
from unittest import mock

import pytest

import memos.api.middleware.auth as auth_module

from memos.api.middleware.auth import is_internal_request, verify_api_key


def _make_request(
    *,
    client_host: str | None = "203.0.113.9",
    headers: dict[str, str] | None = None,
):
    """Build a FastAPI-ish request stand-in with the pieces our code touches."""
    headers = headers or {}
    client = SimpleNamespace(host=client_host) if client_host is not None else None
    return SimpleNamespace(client=client, headers=headers)


class TestIsInternalRequestFailsClosed:
    """Secret missing or empty must behave as 'no trusted header configured'."""

    @pytest.mark.parametrize("secret_env", [None, ""])
    def test_unset_secret_rejects_missing_header(self, monkeypatch, secret_env):
        if secret_env is None:
            monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
        else:
            monkeypatch.setenv("INTERNAL_SERVICE_SECRET", secret_env)
        req = _make_request(headers={})

        assert is_internal_request(req) is False

    @pytest.mark.parametrize("secret_env", [None, ""])
    def test_unset_secret_rejects_any_header_value(self, monkeypatch, secret_env):
        if secret_env is None:
            monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
        else:
            monkeypatch.setenv("INTERNAL_SERVICE_SECRET", secret_env)
        # Even sending the literal word "None" or an empty string must not pass.
        for header_value in ("", "None", "guess", "null", "undefined"):
            req = _make_request(headers={"X-Internal-Service": header_value})
            assert is_internal_request(req) is False, header_value


class TestIsInternalRequestSecretMatch:
    """A configured secret authenticates only on exact header match."""

    def test_exact_match_authenticates(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "s3cret-token")
        req = _make_request(headers={"X-Internal-Service": "s3cret-token"})
        assert is_internal_request(req) is True

    def test_wrong_header_rejected(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "s3cret-token")
        req = _make_request(headers={"X-Internal-Service": "nope"})
        assert is_internal_request(req) is False

    def test_missing_header_rejected(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "s3cret-token")
        req = _make_request(headers={})
        assert is_internal_request(req) is False

    def test_comparison_is_timing_safe(self, monkeypatch):
        """The fix must route through secrets.compare_digest."""
        monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "s3cret-token")
        req = _make_request(headers={"X-Internal-Service": "s3cret-token"})

        with mock.patch(
            "memos.api.middleware.auth.secrets.compare_digest",
            wraps=auth_module.secrets.compare_digest,
        ) as spy:
            assert is_internal_request(req) is True
            assert spy.call_count == 1


class TestLoopbackPreserved:
    """INTERNAL_SERVICE_IPS short-circuit stays. The issue flags this as a
    separate discussion, not something to change here."""

    def test_loopback_v4_still_internal(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
        req = _make_request(client_host="127.0.0.1", headers={})
        assert is_internal_request(req) is True

    def test_loopback_v6_still_internal(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
        req = _make_request(client_host="::1", headers={})
        assert is_internal_request(req) is True

    def test_known_container_hostname_still_internal(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
        req = _make_request(client_host="memos-mcp", headers={})
        assert is_internal_request(req) is True


class TestVerifyApiKeyUnsetSecret:
    """End-to-end: an unauthenticated external request must get 401, not
    silently become ``user_name='internal'``."""

    def test_external_no_credentials_rejected(self, monkeypatch):
        monkeypatch.setattr(auth_module, "AUTH_ENABLED", True)
        monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
        req = _make_request(client_host="203.0.113.9", headers={})

        with pytest.raises(Exception) as exc_info:
            asyncio.get_event_loop().run_until_complete(verify_api_key(req, api_key=None))
        # Must be an HTTPException(401), not an auth bypass.
        assert getattr(exc_info.value, "status_code", None) == 401
