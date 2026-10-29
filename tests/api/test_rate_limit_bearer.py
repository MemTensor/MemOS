"""Regression tests for issue #2428.

``_get_client_key`` in ``src/memos/api/middleware/rate_limit.py`` checked
whether ``request.headers['Authorization']`` started with ``krlk_`` — but
real clients send ``Authorization: Bearer krlk_<hex>`` per RFC 6750, so
the prefix check never matched and every request fell through to IP-based
limiting. Behind a shared egress IP all keyed clients shared one bucket
and the per-key rate-limit was dead code.

The fix strips the ``Bearer `` scheme before testing the key prefix, so
``Bearer krlk_<hex>`` correctly maps to ``ratelimit:key:<first 20 of the
stripped key>``.
"""

from __future__ import annotations

from types import SimpleNamespace

from memos.api.middleware.rate_limit import _get_client_key


def _fake_request(authorization: str | None, *, client_host: str = "10.0.0.1"):
    headers: dict[str, str] = {}
    if authorization is not None:
        headers["Authorization"] = authorization
    return SimpleNamespace(
        headers=headers,
        client=SimpleNamespace(host=client_host),
    )


class TestGetClientKey:
    def test_bearer_krlk_key_uses_per_key_bucket(self):
        body = "krlk_" + "a" * 64
        request = _fake_request("Bearer " + body)
        key = _get_client_key(request)
        assert key == "ratelimit:key:" + body[:20]
        assert "10.0.0.1" not in key

    def test_bearer_krlk_key_first_twenty_chars_of_actual_key(self):
        body = "krlk_" + "f" * 64
        request = _fake_request("Bearer " + body)
        key = _get_client_key(request)
        assert key == "ratelimit:key:" + body[:20]

    def test_lowercase_bearer_scheme(self):
        # RFC 7235: the scheme name is case-insensitive. We normalise to
        # lowercase before the prefix check.
        body = "krlk_" + "b" * 64
        request = _fake_request("bearer " + body)
        key = _get_client_key(request)
        assert key == "ratelimit:key:" + body[:20]

    def test_bearer_with_non_key_token_falls_back_to_ip(self):
        request = _fake_request("Bearer some-jwt-token")
        key = _get_client_key(request)
        assert key.startswith("ratelimit:ip:")
        assert "10.0.0.1" in key

    def test_missing_authorization_header_falls_back_to_ip(self):
        request = _fake_request(None)
        key = _get_client_key(request)
        assert key.startswith("ratelimit:ip:")
        assert "10.0.0.1" in key

    def test_x_forwarded_for_header_preferred_over_ip(self):
        request = _fake_request(None, client_host="203.0.113.1")
        request.headers["X-Forwarded-For"] = "198.51.100.1, 10.0.0.1"
        key = _get_client_key(request)
        assert key == "ratelimit:ip:198.51.100.1"

    def test_krlk_prefix_without_bearer_scheme_still_matches(self):
        # Backwards compatibility: clients that sent a bare krlk_ header
        # (before the Bearer scheme was added) must still match.
        body = "krlk_" + "c" * 64
        request = _fake_request(body)
        key = _get_client_key(request)
        assert key == "ratelimit:key:" + body[:20]
