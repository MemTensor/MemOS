"""
Tests for rate limit middleware Bearer token handling.

Verifies that the middleware correctly extracts API keys from
Authorization: Bearer <key> headers for per-key rate limiting.
"""

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from memos.api.middleware.rate_limit import (
    RateLimitMiddleware,
    _get_client_key,
)


def test_get_client_key_with_bearer_token():
    """Test that Bearer token is correctly extracted for rate limiting."""
    # Create a mock request with Bearer token
    app = Starlette()

    # Simulate a request with Bearer token
    with TestClient(app):
        # Create request manually with Bearer header
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/test",
            "headers": [
                (b"authorization", b"Bearer krlk_test_key_12345678"),
            ],
            "client": ("127.0.0.1", 8000),
        }
        request = Request(scope)

        key = _get_client_key(request)

        # Should extract the key and use it for rate limiting
        assert key == "ratelimit:key:krlk_test_key_123456"
        assert key.startswith("ratelimit:key:")


def test_get_client_key_with_lowercase_bearer():
    """Test that lowercase 'bearer' scheme is also recognized."""
    app = Starlette()

    with TestClient(app):
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/test",
            "headers": [
                (b"authorization", b"bearer krlk_another_key_abc"),
            ],
            "client": ("127.0.0.1", 8000),
        }
        request = Request(scope)

        key = _get_client_key(request)

        assert key == "ratelimit:key:krlk_another_key_abc"
        assert key.startswith("ratelimit:key:")


def test_get_client_key_with_direct_key():
    """Test backward compatibility with direct key (no Bearer prefix)."""
    app = Starlette()

    with TestClient(app):
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/test",
            "headers": [
                (b"authorization", b"krlk_direct_key_xyz"),
            ],
            "client": ("127.0.0.1", 8000),
        }
        request = Request(scope)

        key = _get_client_key(request)

        # Should still work for direct keys
        assert key == "ratelimit:key:krlk_direct_key_xyz"


def test_get_client_key_fallback_to_ip():
    """Test that non-keyed requests fall back to IP-based limiting."""
    app = Starlette()

    with TestClient(app):
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/test",
            "headers": [],
            "client": ("192.168.1.100", 8000),
        }
        request = Request(scope)

        key = _get_client_key(request)

        assert key == "ratelimit:ip:192.168.1.100"


def test_get_client_key_with_x_forwarded_for():
    """Test that X-Forwarded-For is used when present."""
    app = Starlette()

    with TestClient(app):
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/test",
            "headers": [
                (b"x-forwarded-for", b"203.0.113.42, 10.0.0.1"),
            ],
            "client": ("10.0.0.2", 8000),
        }
        request = Request(scope)

        key = _get_client_key(request)

        # Should use the first IP from X-Forwarded-For
        assert key == "ratelimit:ip:203.0.113.42"


def test_rate_limit_different_keys_separate_buckets():
    """
    Integration test: verify that different API keys get separate rate limit buckets.
    """

    # Create a simple test app
    async def hello(request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/test", hello)])
    app.add_middleware(RateLimitMiddleware)

    client = TestClient(app)

    # Make requests with two different keys
    response1 = client.get("/test", headers={"Authorization": "Bearer krlk_key1_xxx"})
    response2 = client.get("/test", headers={"Authorization": "Bearer krlk_key2_yyy"})

    # Both should succeed (different buckets)
    assert response1.status_code == 200
    assert response2.status_code == 200

    # Both should have rate limit headers
    assert "X-RateLimit-Limit" in response1.headers
    assert "X-RateLimit-Limit" in response2.headers


def test_rate_limit_bearer_token_not_treated_as_ip():
    """
    Regression test: verify Bearer tokens are not treated as IP addresses.

    Before the fix, 'Authorization: Bearer krlk_...' would fail the startswith check
    and fall through to IP-based limiting, causing all keyed clients behind a shared
    NAT to share one rate limit bucket.
    """
    app = Starlette()

    with TestClient(app):
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/test",
            "headers": [
                (b"authorization", b"Bearer krlk_test_key_12345678"),
            ],
            "client": ("10.0.0.1", 8000),
        }
        request = Request(scope)

        key = _get_client_key(request)

        # Should NOT be an IP-based key
        assert not key.startswith("ratelimit:ip:")
        # Should be a key-based bucket
        assert key.startswith("ratelimit:key:")
