import os
import threading

from collections import Counter
from concurrent.futures import Future
from typing import Any

from cachetools import LRUCache, TTLCache

from memos.context.context import get_current_trace_id
from memos.embedders.base import BaseEmbedder
from memos.exceptions import EmbedderError
from memos.log import get_logger


logger = get_logger(__name__)


_OPTIMIZATION_ENABLED_ENV = "MEMOS_EMBEDDING_OPTIMIZATION_ENABLED"
_CACHE_TTL_ENV = "MEMOS_EMBEDDING_CACHE_TTL_SECONDS"
_CACHE_MAX_SIZE_ENV = "MEMOS_EMBEDDING_CACHE_MAX_SIZE"
_REQUEST_CACHE_TTL_ENV = "MEMOS_EMBEDDING_REQUEST_CACHE_TTL_SECONDS"
_REQUEST_CACHE_MAX_REQUESTS_ENV = "MEMOS_EMBEDDING_REQUEST_CACHE_MAX_REQUESTS"

_DEFAULT_CACHE_TTL_SECONDS = 30.0
_DEFAULT_CACHE_MAX_SIZE = 4096
_DEFAULT_REQUEST_CACHE_TTL_SECONDS = 60.0
_DEFAULT_REQUEST_CACHE_MAX_REQUESTS = 1024

_INVALID_REQUEST_IDS = {None, "", "trace-id"}

CachedVector = tuple[float, ...]


def _env_enabled(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def embedding_optimization_enabled() -> bool:
    return _env_enabled(_OPTIMIZATION_ENABLED_ENV)


def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(minimum, float(raw))
    except ValueError:
        logger.warning("Invalid %s=%r; using default %s", name, raw, default)
        return default


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        logger.warning("Invalid %s=%r; using default %s", name, raw, default)
        return default


class CachingEmbedder(BaseEmbedder):
    """Add exact caches and singleflight coordination to an embedder."""

    def __init__(self, backend: BaseEmbedder):
        self._backend = backend
        self.config = backend.config
        self._lock = threading.RLock()
        self._inflight: dict[str, Future[CachedVector]] = {}
        self._stats: Counter[str] = Counter()

        cache_ttl = _env_float(_CACHE_TTL_ENV, _DEFAULT_CACHE_TTL_SECONDS)
        cache_max_size = _env_int(_CACHE_MAX_SIZE_ENV, _DEFAULT_CACHE_MAX_SIZE)
        self._cache: TTLCache[str, CachedVector] | None = (
            TTLCache(maxsize=cache_max_size, ttl=cache_ttl) if cache_ttl > 0 else None
        )

        request_cache_ttl = _env_float(_REQUEST_CACHE_TTL_ENV, _DEFAULT_REQUEST_CACHE_TTL_SECONDS)
        request_cache_max_requests = _env_int(
            _REQUEST_CACHE_MAX_REQUESTS_ENV, _DEFAULT_REQUEST_CACHE_MAX_REQUESTS
        )
        self._request_cache_text_limit = cache_max_size
        self._request_caches: TTLCache[str, LRUCache[str, CachedVector]] | None = (
            TTLCache(maxsize=request_cache_max_requests, ttl=request_cache_ttl)
            if request_cache_ttl > 0
            else None
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._backend, name)

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not embedding_optimization_enabled():
            return self._backend.embed(texts)
        if isinstance(texts, str):
            texts = [texts]
        if not texts:
            return []

        unique_texts = list(dict.fromkeys(texts))
        request_id = get_current_trace_id()
        resolved: dict[str, CachedVector] = {}
        owned: dict[str, Future[CachedVector]] = {}
        waiting: dict[str, Future[CachedVector]] = {}
        local_stats = Counter(
            {
                "batch_dedup_hits": len(texts) - len(unique_texts),
                "request_hits": 0,
                "ttl_hits": 0,
                "singleflight_joins": 0,
                "misses": 0,
            }
        )

        with self._lock:
            request_cache = self._get_request_cache(request_id)
            for text in unique_texts:
                if request_cache is not None and text in request_cache:
                    resolved[text] = request_cache[text]
                    local_stats["request_hits"] += 1
                elif self._cache is not None and text in self._cache:
                    resolved[text] = self._cache[text]
                    if request_cache is not None:
                        request_cache[text] = resolved[text]
                    local_stats["ttl_hits"] += 1
                elif text in self._inflight:
                    waiting[text] = self._inflight[text]
                    local_stats["singleflight_joins"] += 1
                else:
                    future: Future[CachedVector] = Future()
                    self._inflight[text] = future
                    owned[text] = future
                    local_stats["misses"] += 1

            self._stats.update(local_stats)

        if owned:
            owned_texts = list(owned)
            with self._lock:
                self._stats["backend_calls"] += 1
                self._stats["backend_texts"] += len(owned_texts)
            try:
                computed = self._backend.embed(owned_texts)
                if len(computed) != len(owned_texts):
                    raise EmbedderError(
                        "Embedding backend returned a different number of vectors than texts"
                    )
                computed_vectors = [tuple(vector) for vector in computed]
            except Exception as exc:
                with self._lock:
                    self._stats["backend_errors"] += 1
                    for text, future in owned.items():
                        self._inflight.pop(text, None)
                        future.set_exception(exc)
                raise

            with self._lock:
                for text, vector in zip(owned_texts, computed_vectors, strict=True):
                    resolved[text] = vector
                    if self._cache is not None:
                        self._cache[text] = vector
                    if request_cache is not None:
                        request_cache[text] = vector
                    self._inflight.pop(text, None)
                    owned[text].set_result(vector)

        for text, future in waiting.items():
            vector = future.result()
            resolved[text] = vector
            if request_cache is not None:
                with self._lock:
                    request_cache[text] = vector

        logger.info(
            "embedding cache summary batch_size=%d unique_texts=%d "
            "request_hits=%d ttl_hits=%d batch_dedup_hits=%d "
            "singleflight_joins=%d misses=%d",
            len(texts),
            len(unique_texts),
            local_stats["request_hits"],
            local_stats["ttl_hits"],
            local_stats["batch_dedup_hits"],
            local_stats["singleflight_joins"],
            local_stats["misses"],
        )
        return [list(resolved[text]) for text in texts]

    def _get_request_cache(self, request_id: str | None) -> LRUCache[str, CachedVector] | None:
        if request_id in _INVALID_REQUEST_IDS or self._request_caches is None:
            return None
        request_cache = self._request_caches.get(request_id)
        if request_cache is None:
            request_cache = LRUCache(maxsize=self._request_cache_text_limit)
            self._request_caches[request_id] = request_cache
        return request_cache

    def cache_info(self) -> dict[str, int]:
        with self._lock:
            info = dict(self._stats)
            for key in (
                "batch_dedup_hits",
                "request_hits",
                "ttl_hits",
                "singleflight_joins",
                "misses",
                "backend_calls",
                "backend_texts",
                "backend_errors",
            ):
                info.setdefault(key, 0)
            info["ttl_cache_size"] = len(self._cache) if self._cache is not None else 0
            info["request_cache_count"] = (
                len(self._request_caches) if self._request_caches is not None else 0
            )
            info["inflight"] = len(self._inflight)
            return info

    def clear_cache(self) -> None:
        with self._lock:
            if self._cache is not None:
                self._cache.clear()
            if self._request_caches is not None:
                self._request_caches.clear()
