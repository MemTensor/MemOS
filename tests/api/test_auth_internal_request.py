"""Tests for `memos.api.middleware.auth.is_internal_request` fail-open regression.

Regression test suite for GHSA-9pw6-vmgx-qgwx / issue #2259.

The bug: when `INTERNAL_SERVICE_SECRET` is unset (its default across every shipped
Dockerfile / compose / Helm config) and an external client does not send the
`X-Internal-Service` header, `is_internal_request()` compared
``request.headers.get("X-Internal-Service")`` to ``os.getenv("INTERNAL_SERVICE_SECRET")``
directly, so ``None == None`` returned True and the request was granted the
`internal` principal with ``scopes: ["all"]``.

These tests lock in the fixed behaviour: unset secret OR missing header → not internal;
matching non-empty secret + header → internal (constant-time compare).
"""

from __future__ import annotations

from typing import Any

import pytest

from fastapi import HTTPException
from starlette.requests import Request

from memos.api.middleware import auth as auth_module
from memos.api.middleware.auth import is_internal_request, verify_api_key


def _make_request(
    *,
    client: tuple[str, int] | None = ("203.0.113.9", 53124),
    headers: dict[str, str] | None = None,
) -> Request:
    """Build a bare-bones Starlette Request for the dependency under test."""
    scope: dict[str, Any] = {
        "type": "http",
        "method": "GET",
        "path": "/admin/keys",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    if client is not None:
        scope["client"] = client
    return Request(scope)


class TestIsInternalRequest:
    def test_returns_false_when_secret_unset_and_header_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: None == None must not authenticate."""
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", None)
        request = _make_request(headers={})

        assert is_internal_request(request) is False

    def test_returns_false_when_secret_unset_and_header_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Header path is disabled when secret is not configured."""
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", None)
        request = _make_request(headers={"X-Internal-Service": "guessed-value"})

        assert is_internal_request(request) is False

    def test_returns_false_when_secret_empty_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Empty string secret is treated as unset (defence in depth)."""
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "")
        request = _make_request(headers={"X-Internal-Service": ""})

        assert is_internal_request(request) is False

    def test_returns_false_when_secret_set_but_header_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "super-secret-value")
        request = _make_request(headers={})

        assert is_internal_request(request) is False

    def test_returns_false_when_secret_set_but_header_wrong(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "super-secret-value")
        request = _make_request(headers={"X-Internal-Service": "wrong-value"})

        assert is_internal_request(request) is False

    def test_returns_true_when_secret_matches_header(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "super-secret-value")
        request = _make_request(headers={"X-Internal-Service": "super-secret-value"})

        assert is_internal_request(request) is True

    def test_returns_true_when_client_ip_is_internal(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The internal-IP branch remains untouched by the fix."""
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", None)
        request = _make_request(client=("127.0.0.1", 12345), headers={})

        assert is_internal_request(request) is True

    def test_uses_constant_time_compare(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The fix must call `hmac.compare_digest` (not plain ==) to avoid timing leaks."""
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "super-secret-value")
        calls: list[tuple[str, str]] = []

        real_compare = auth_module.hmac.compare_digest

        def spy(a: str, b: str) -> bool:
            calls.append((a, b))
            return real_compare(a, b)

        monkeypatch.setattr(auth_module.hmac, "compare_digest", spy)
        request = _make_request(headers={"X-Internal-Service": "super-secret-value"})

        assert is_internal_request(request) is True
        assert calls, "expected hmac.compare_digest to be invoked for header comparison"

    def test_no_client_and_no_header_and_no_secret(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Missing request.client + no header + no secret must NOT authenticate."""
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", None)
        request = _make_request(client=None, headers={})

        assert is_internal_request(request) is False


class TestVerifyApiKeyEndToEnd:
    """End-to-end reproduction of the advisory PoC against `verify_api_key`."""

    @pytest.mark.asyncio
    async def test_external_request_no_key_is_rejected_when_secret_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The exact PoC from GHSA-9pw6-vmgx-qgwx must now be rejected with 401."""
        monkeypatch.setattr(auth_module, "AUTH_ENABLED", True)
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", None)
        request = _make_request(headers={})

        with pytest.raises(HTTPException) as exc_info:
            await verify_api_key(request, api_key=None)

        assert exc_info.value.status_code == 401
        assert "Missing API key" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_external_request_with_wrong_header_still_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(auth_module, "AUTH_ENABLED", True)
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", None)
        request = _make_request(headers={"X-Internal-Service": "guess"})

        with pytest.raises(HTTPException) as exc_info:
            await verify_api_key(request, api_key=None)

        assert exc_info.value.status_code == 401

    @pytest.mark.asyncio
    async def test_internal_request_with_matching_secret_is_authorised(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(auth_module, "AUTH_ENABLED", True)
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "shared-secret")
        request = _make_request(
            headers={"X-Internal-Service": "shared-secret"},
            client=("10.0.0.42", 40000),
        )

        result = await verify_api_key(request, api_key=None)
        assert result == {
            "user_name": "internal",
            "scopes": ["all"],
            "is_master_key": False,
            "is_internal": True,
        }

    @pytest.mark.asyncio
    async def test_internal_request_via_header_with_no_client_does_not_crash(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression for finding #1: ``request.client`` may be None on the header path.

        `verify_api_key` must not raise ``AttributeError`` when a request without a
        ``client`` tuple is granted the internal principal via a matching
        ``X-Internal-Service`` header.
        """
        monkeypatch.setattr(auth_module, "AUTH_ENABLED", True)
        monkeypatch.setattr(auth_module, "INTERNAL_SERVICE_SECRET", "shared-secret")
        request = _make_request(
            client=None,
            headers={"X-Internal-Service": "shared-secret"},
        )

        result = await verify_api_key(request, api_key=None)
        assert result["is_internal"] is True
        assert result["user_name"] == "internal"
