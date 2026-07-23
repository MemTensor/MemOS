import threading
import time

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from memos.configs.embedder import EmbedderConfigFactory
from memos.context.context import RequestContext, set_request_context
from memos.embedders.cache import CachingEmbedder
from memos.embedders.factory import EmbedderFactory


@pytest.fixture(autouse=True)
def clear_request_context():
    set_request_context(None)
    yield
    set_request_context(None)


def _backend(side_effect=None):
    backend = MagicMock()
    backend.config = SimpleNamespace(model_name_or_path="embedding-model")
    backend.embed.side_effect = side_effect or (
        lambda texts: [[float(len(text)), float(index)] for index, text in enumerate(texts)]
    )
    return backend


def _enable_optimization(monkeypatch, ttl_seconds="0"):
    monkeypatch.setenv("MEMOS_EMBEDDING_OPTIMIZATION_ENABLED", "true")
    monkeypatch.setenv("MEMOS_EMBEDDING_CACHE_TTL_SECONDS", ttl_seconds)
    monkeypatch.setenv("MEMOS_EMBEDDING_CACHE_MAX_SIZE", "32")
    monkeypatch.setenv("MEMOS_EMBEDDING_REQUEST_CACHE_TTL_SECONDS", "60")
    monkeypatch.setenv("MEMOS_EMBEDDING_REQUEST_CACHE_MAX_REQUESTS", "8")


def test_disabled_cache_preserves_backend_batch(monkeypatch):
    monkeypatch.setenv("MEMOS_EMBEDDING_OPTIMIZATION_ENABLED", "false")
    backend = _backend()
    embedder = CachingEmbedder(backend)

    first = embedder.embed(["same", "same"])
    second = embedder.embed(["same", "same"])

    assert first == second
    assert backend.embed.call_count == 2
    backend.embed.assert_called_with(["same", "same"])


def test_enabled_cache_treats_string_as_one_text(monkeypatch):
    _enable_optimization(monkeypatch)
    backend = _backend()
    embedder = CachingEmbedder(backend)

    result = embedder.embed("whole query")

    assert result == [[11.0, 0.0]]
    backend.embed.assert_called_once_with(["whole query"])


def test_reuses_duplicate_texts_within_request(monkeypatch):
    _enable_optimization(monkeypatch)
    backend = _backend()
    embedder = CachingEmbedder(backend)
    set_request_context(RequestContext(trace_id="request-a"))

    first = embedder.embed(["same", "same", "other"])
    first[0][0] = 999.0
    second = embedder.embed(["same"])

    backend.embed.assert_called_once_with(["same", "other"])
    assert first[1] == [4.0, 0.0]
    assert second == [[4.0, 0.0]]
    assert embedder.cache_info()["request_hits"] == 1


def test_short_ttl_cache_reuses_text_across_requests(monkeypatch):
    _enable_optimization(monkeypatch, ttl_seconds="60")
    backend = _backend()
    embedder = CachingEmbedder(backend)

    set_request_context(RequestContext(trace_id="request-a"))
    first = embedder.embed(["same"])
    set_request_context(RequestContext(trace_id="request-b"))
    second = embedder.embed(["same"])

    assert first == second
    backend.embed.assert_called_once_with(["same"])
    assert embedder.cache_info()["ttl_hits"] == 1


def test_partial_cache_hit_preserves_input_order(monkeypatch):
    _enable_optimization(monkeypatch, ttl_seconds="60")
    backend = _backend()
    embedder = CachingEmbedder(backend)

    assert embedder.embed(["cached"]) == [[6.0, 0.0]]
    result = embedder.embed(["new-a", "cached", "new-b", "new-a"])

    assert result == [
        [5.0, 0.0],
        [6.0, 0.0],
        [5.0, 1.0],
        [5.0, 0.0],
    ]
    assert backend.embed.call_args_list[-1].args[0] == ["new-a", "new-b"]


def test_request_cache_does_not_leak_when_ttl_disabled(monkeypatch):
    _enable_optimization(monkeypatch)
    backend = _backend()
    embedder = CachingEmbedder(backend)

    set_request_context(RequestContext(trace_id="request-a"))
    embedder.embed(["same"])
    set_request_context(RequestContext(trace_id="request-b"))
    embedder.embed(["same"])

    assert backend.embed.call_count == 2


def test_concurrent_same_text_uses_single_backend_call(monkeypatch):
    _enable_optimization(monkeypatch, ttl_seconds="60")
    backend_started = threading.Event()
    release_backend = threading.Event()

    def blocking_embed(texts):
        backend_started.set()
        assert release_backend.wait(timeout=2)
        return [[1.0, 2.0] for _ in texts]

    backend = _backend(blocking_embed)
    embedder = CachingEmbedder(backend)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(embedder.embed, ["same"])
        assert backend_started.wait(timeout=2)
        second = executor.submit(embedder.embed, ["same"])

        deadline = time.monotonic() + 2
        while embedder.cache_info()["singleflight_joins"] != 1:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        release_backend.set()

        assert first.result(timeout=2) == [[1.0, 2.0]]
        assert second.result(timeout=2) == [[1.0, 2.0]]

    backend.embed.assert_called_once_with(["same"])


def test_backend_failure_is_not_cached(monkeypatch):
    _enable_optimization(monkeypatch, ttl_seconds="60")
    backend = _backend()
    backend.embed.side_effect = [ValueError("temporary"), [[1.0, 2.0]]]
    embedder = CachingEmbedder(backend)

    with pytest.raises(ValueError, match="temporary"):
        embedder.embed(["same"])

    assert embedder.embed(["same"]) == [[1.0, 2.0]]
    assert backend.embed.call_count == 2


def test_factory_wraps_remote_embedder_when_enabled(monkeypatch):
    _enable_optimization(monkeypatch)
    backend = _backend()
    monkeypatch.setitem(EmbedderFactory.backend_to_class, "ollama", lambda _config: backend)
    config = EmbedderConfigFactory.model_validate(
        {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "cache-test-model",
                "api_base": "http://cache-test.invalid",
            },
        }
    )

    embedder = EmbedderFactory.from_config(config)

    assert isinstance(embedder, CachingEmbedder)
    assert embedder.config is backend.config
