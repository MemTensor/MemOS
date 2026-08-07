"""Security regression tests for API authentication."""

import importlib

import pytest

from fastapi import HTTPException
from starlette.requests import Request

from memos.api.middleware import auth


def _request(
    *,
    internal_secret: str | None = None,
    client_host: str = "198.51.100.10",
    claimed_user: str | None = None,
) -> Request:
    headers = []
    if internal_secret is not None:
        headers.append((b"x-internal-service", internal_secret.encode()))
    if claimed_user is not None:
        headers.append((b"x-user-name", claimed_user.encode()))

    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/product/search",
            "raw_path": b"/product/search",
            "query_string": b"",
            "headers": headers,
            "client": (client_host, 12345),
            "server": ("testserver", 80),
            "scheme": "http",
        }
    )


def test_authentication_is_enabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("AUTH_ENABLED", raising=False)

    try:
        assert importlib.reload(auth).AUTH_ENABLED is True
    finally:
        importlib.reload(auth)


def test_internal_request_requires_configured_secret(monkeypatch) -> None:
    monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)

    assert auth.is_internal_request(_request()) is False
    assert auth.is_internal_request(_request(client_host="127.0.0.1")) is False


def test_internal_request_requires_matching_secret(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "expected-secret")

    assert auth.is_internal_request(_request(internal_secret="wrong-secret")) is False
    assert auth.is_internal_request(_request(internal_secret="expected-secret")) is True


@pytest.mark.asyncio
async def test_disabled_auth_cannot_be_told_which_user_it_acts_as(monkeypatch) -> None:
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    monkeypatch.setenv("MOS_USER_ID", "local-user")

    principal = await auth.verify_api_key(
        _request(claimed_user="attacker-controlled"),
        api_key=None,
    )

    assert principal["user_name"] == "local-user"
    with pytest.raises(HTTPException) as exc_info:
        auth.resolve_authorized_user_id(principal, "victim")

    assert exc_info.value.status_code == 403


def test_regular_principal_cannot_select_another_user() -> None:
    principal = {"user_name": "alice", "scopes": ["read"]}

    assert auth.resolve_authorized_user_id(principal, None) == "alice"
    assert auth.resolve_authorized_user_id(principal, "alice") == "alice"
    with pytest.raises(HTTPException) as exc_info:
        auth.resolve_authorized_user_id(principal, "bob")

    assert exc_info.value.status_code == 403


def test_privileged_principal_can_operate_for_another_user() -> None:
    assert auth.resolve_authorized_user_id({"user_name": "op", "scopes": ["admin"]}, "bob") == "bob"
    assert auth.resolve_authorized_user_id({"is_master_key": True, "scopes": ["all"]}, "bob") == (
        "bob"
    )
