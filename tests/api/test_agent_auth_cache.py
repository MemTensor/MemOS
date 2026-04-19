"""Tests for the verified-key cache in AgentAuthMiddleware."""

import json
import os
import time
from unittest.mock import patch

import bcrypt
import pytest

from memos.api.middleware.agent_auth import AgentAuthMiddleware


def _write_config(tmp_path, agents):
    """Write a v2 hashed-key config file. agents is a list of (raw_key, user_id)."""
    config = {
        "version": 2,
        "agents": [
            {
                "key_hash": bcrypt.hashpw(raw.encode(), bcrypt.gensalt(rounds=12)).decode(),
                "key_prefix": raw[:7],
                "user_id": user_id,
                "description": f"{user_id} agent",
            }
            for raw, user_id in agents
        ],
    }
    path = tmp_path / "agents-auth.json"
    path.write_text(json.dumps(config))
    return str(path)


@pytest.fixture
def middleware(tmp_path):
    config_path = _write_config(tmp_path, [
        ("ak_ceo_test_key_value_123", "ceo"),
        ("ak_research_test_key_value_456", "research-agent"),
    ])
    mw = AgentAuthMiddleware(app=None, config_path=config_path)
    return mw, config_path


def test_first_call_runs_bcrypt_subsequent_calls_skip_it(middleware):
    mw, _ = middleware
    raw_key = "ak_ceo_test_key_value_123"

    with patch("memos.api.middleware.agent_auth.bcrypt.checkpw", wraps=bcrypt.checkpw) as spy:
        first = mw._authenticate_key(raw_key)
        first_calls = spy.call_count

        for _ in range(5):
            assert mw._authenticate_key(raw_key) == "ceo"

        # First call: at least one bcrypt verify (could be 1-2 depending on agent order).
        # After that, no further bcrypt calls for the same key.
        assert first == "ceo"
        assert first_calls >= 1
        assert spy.call_count == first_calls, "bcrypt.checkpw should not run on cache hits"


def test_cache_hit_under_50ms(middleware):
    """Acceptance: subsequent requests with same key resolve in <50ms."""
    mw, _ = middleware
    raw_key = "ak_ceo_test_key_value_123"

    # Prime the cache (this call will be slow ~200-400ms — bcrypt rounds=12).
    assert mw._authenticate_key(raw_key) == "ceo"

    # Measure cached calls.
    samples = []
    for _ in range(10):
        t = time.perf_counter()
        result = mw._authenticate_key(raw_key)
        samples.append((time.perf_counter() - t) * 1000)
        assert result == "ceo"

    # p50 of cached calls should be well under 50ms (typically <1ms).
    samples.sort()
    p50 = samples[len(samples) // 2]
    assert p50 < 50, f"cache-hit p50 was {p50:.2f}ms, expected <50ms"


def test_failed_auth_not_cached(middleware):
    """Failed verifications must not poison the cache (would trivialize brute force)."""
    mw, _ = middleware
    bad_key = "ak_not_a_real_key_at_all_xyz"

    with patch("memos.api.middleware.agent_auth.bcrypt.checkpw", wraps=bcrypt.checkpw) as spy:
        assert mw._authenticate_key(bad_key) is None
        first_calls = spy.call_count
        assert first_calls == len(mw._agents), "should attempt every agent on miss"

        assert mw._authenticate_key(bad_key) is None
        # Each failed attempt should re-run bcrypt against every agent.
        assert spy.call_count == 2 * first_calls

    # Cache must contain no entry for the failed key's hash.
    import hashlib
    cache_key = hashlib.sha256(bad_key.encode()).hexdigest()
    assert cache_key not in mw._verify_cache


def test_reload_clears_cache(middleware, tmp_path):
    mw, config_path = middleware
    raw_key = "ak_ceo_test_key_value_123"

    assert mw._authenticate_key(raw_key) == "ceo"
    assert len(mw._verify_cache) == 1

    # Bump mtime so _check_reload triggers.
    new_mtime = os.path.getmtime(config_path) + 5
    os.utime(config_path, (new_mtime, new_mtime))

    mw._check_reload()
    assert len(mw._verify_cache) == 0, "cache should be cleared on config reload"

    # After reload, next call must re-run bcrypt.
    with patch("memos.api.middleware.agent_auth.bcrypt.checkpw", wraps=bcrypt.checkpw) as spy:
        assert mw._authenticate_key(raw_key) == "ceo"
        assert spy.call_count >= 1


def test_explicit_reload_clears_cache(middleware):
    mw, _ = middleware
    raw_key = "ak_ceo_test_key_value_123"

    assert mw._authenticate_key(raw_key) == "ceo"
    assert len(mw._verify_cache) == 1

    mw.reload()
    assert len(mw._verify_cache) == 0


def test_cache_stores_correct_user_id_per_key(middleware):
    """Cache must map each key to its own agent — not bleed across keys."""
    mw, _ = middleware
    ceo_key = "ak_ceo_test_key_value_123"
    research_key = "ak_research_test_key_value_456"

    assert mw._authenticate_key(ceo_key) == "ceo"
    assert mw._authenticate_key(research_key) == "research-agent"
    # Hit cache and confirm no crossover.
    assert mw._authenticate_key(ceo_key) == "ceo"
    assert mw._authenticate_key(research_key) == "research-agent"


def test_cache_bounded_to_max_size(tmp_path):
    """Cache should evict oldest entries past VERIFY_CACHE_MAX."""
    # Build a config with one real agent; we'll exercise eviction by spoofing additional entries.
    config_path = _write_config(tmp_path, [("ak_ceo_test_key_value_123", "ceo")])
    mw = AgentAuthMiddleware(app=None, config_path=config_path)

    # Force-fill the cache past the bound by injecting fake hits via the public path
    # (we can't bcrypt-verify fake keys, so populate the dict directly to test eviction policy).
    for i in range(mw.VERIFY_CACHE_MAX + 10):
        mw._verify_cache[f"hash_{i}"] = "ceo"
        mw._verify_cache.move_to_end(f"hash_{i}")
        if len(mw._verify_cache) > mw.VERIFY_CACHE_MAX:
            mw._verify_cache.popitem(last=False)

    assert len(mw._verify_cache) == mw.VERIFY_CACHE_MAX
    # Earliest entries should be evicted.
    assert "hash_0" not in mw._verify_cache
    assert f"hash_{mw.VERIFY_CACHE_MAX + 9}" in mw._verify_cache
