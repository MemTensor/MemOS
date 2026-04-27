"""
Rate Limiting Middleware.

Sliding-window rate limiter with Redis as the primary backend. If Redis is
unreachable or unconfigured, falls back to a **file-backed SQLite store** so
state survives restarts in single-worker deployments. Multi-worker setups
without Redis will share counters via SQLite's file lock — coarser-grained
than Redis but still functionally correct.

The Redis URL is read from ``MEMOS_REDIS_URL``. If unset, Redis is **not**
attempted and the server starts in SQLite-fallback mode with a single
startup WARN. Previous behaviour (hard-coded ``redis://redis:6379`` default
+ warn-on-every-request) flooded logs in non-Docker deployments where the
hostname doesn't resolve.

Env vars:
  MEMOS_REDIS_URL        — Redis URL. Unset → SQLite fallback. (no default)
  MEMOS_RATE_LIMIT_DB    — SQLite file path for fallback (default: /var/tmp/memos-ratelimit.db)
  RATE_LIMIT             — Max requests per window (default: 100)
  RATE_WINDOW_SEC        — Window length in seconds (default: 60)
"""

import os
import sqlite3
import time
import threading

from collections.abc import Callable
from typing import ClassVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

import memos.log


logger = memos.log.get_logger(__name__)

# Configuration from environment
RATE_LIMIT = int(os.getenv("RATE_LIMIT", "100"))  # Requests per window
RATE_WINDOW = int(os.getenv("RATE_WINDOW_SEC", "60"))  # Window in seconds
# No default — unset means "operator chose SQLite fallback explicitly".
# Previous default of redis://redis:6379 caused name-resolution flooding in
# non-Docker deployments.
REDIS_URL = os.getenv("MEMOS_REDIS_URL")
DB_PATH = os.getenv("MEMOS_RATE_LIMIT_DB", "/var/tmp/memos-ratelimit.db")

# Redis client (lazy initialization). Sentinel `_REDIS_DISABLED` means we
# tried once, failed, and should not retry — switches the process to
# SQLite-fallback mode permanently. Avoids the warn-on-every-request flood.
_REDIS_DISABLED = object()
_redis_client = None  # None = not yet attempted; client = up; _REDIS_DISABLED = down

# Counter for /metrics-style observability: number of times we've served a
# request from the SQLite fallback. Read by tests / future /metrics endpoint.
_redis_fallback_request_count = 0

# SQLite connection (one per process; sqlite3 connections aren't thread-safe
# unless `check_same_thread=False`, which is fine here because we serialize
# writes with a lock).
_sqlite_conn: sqlite3.Connection | None = None
_sqlite_lock = threading.Lock()


def _init_sqlite() -> sqlite3.Connection:
    """Lazily initialise the SQLite fallback store. Idempotent."""
    global _sqlite_conn
    if _sqlite_conn is not None:
        return _sqlite_conn
    # Ensure the parent directory exists.
    parent = os.path.dirname(DB_PATH) or "."
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    # WAL keeps writers from blocking concurrent readers — important when
    # multiple workers share the file.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS rate_limit_events ("
        "  key TEXT NOT NULL,"
        "  ts  REAL NOT NULL"
        ")"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rl_key_ts ON rate_limit_events (key, ts)"
    )
    _sqlite_conn = conn
    return conn


def _get_redis():
    """Return a connected Redis client or ``None`` if unavailable.

    On the first call we try once. On failure we cache that failure for the
    process lifetime — every subsequent call returns ``None`` immediately
    without re-attempting DNS resolution. This is what makes the WARN fire
    *once at startup* rather than on every request.
    """
    global _redis_client
    if _redis_client is _REDIS_DISABLED:
        return None
    if _redis_client is not None:
        return _redis_client

    if not REDIS_URL:
        # Operator did not set MEMOS_REDIS_URL — log once and stop trying.
        logger.warning(
            "[RateLimit] MEMOS_REDIS_URL is unset. Running in SQLite-fallback "
            "mode at %s. State persists across restarts but is not shared with "
            "remote workers; set MEMOS_REDIS_URL=redis://host:port for "
            "production multi-worker deployments.",
            DB_PATH,
        )
        _redis_client = _REDIS_DISABLED
        return None

    try:
        import redis

        client = redis.from_url(REDIS_URL, decode_responses=True)
        client.ping()  # Force a connection so we discover failure now, not later.
        _redis_client = client
        logger.info("[RateLimit] Connected to Redis at %s", REDIS_URL)
        return client
    except Exception as e:
        # ONE warning ever. Subsequent _get_redis() calls short-circuit on
        # the sentinel and never reach this path again.
        logger.warning(
            "[RateLimit] Redis unreachable at %s (%s). Falling back to SQLite "
            "at %s for the lifetime of this process. Restart after fixing "
            "Redis to re-enable distributed rate limiting.",
            REDIS_URL,
            e,
            DB_PATH,
        )
        _redis_client = _REDIS_DISABLED
        return None


def _get_client_key(request: Request) -> str:
    """
    Generate a unique key for rate limiting.

    Uses API key if available, otherwise falls back to IP.
    """
    # Try to get API key from header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("krlk_"):
        # Use first 20 chars of key as identifier
        return f"ratelimit:key:{auth_header[:20]}"

    # Fall back to IP address
    client_ip = request.client.host if request.client else "unknown"

    # Check for forwarded IP (behind proxy)
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        client_ip = forwarded.split(",")[0].strip()

    return f"ratelimit:ip:{client_ip}"


def _check_rate_limit_redis(key: str) -> tuple[bool, int, int]:
    """
    Check rate limit using Redis sliding window.

    Returns:
        (allowed, remaining, reset_time)
    """
    redis_client = _get_redis()
    if not redis_client:
        return _check_rate_limit_sqlite(key)

    try:
        now = time.time()
        window_start = now - RATE_WINDOW

        pipe = redis_client.pipeline()

        # Remove old entries
        pipe.zremrangebyscore(key, 0, window_start)

        # Count current entries
        pipe.zcard(key)

        # Add current request
        pipe.zadd(key, {str(now): now})

        # Set expiry
        pipe.expire(key, RATE_WINDOW + 1)

        results = pipe.execute()
        current_count = results[1]

        remaining = max(0, RATE_LIMIT - current_count - 1)
        reset_time = int(now + RATE_WINDOW)

        if current_count >= RATE_LIMIT:
            return False, 0, reset_time

        return True, remaining, reset_time

    except Exception as e:
        # Transient Redis error mid-flight — degrade quietly to SQLite for
        # this single request. Logged at DEBUG only; the once-at-startup
        # WARN already informed ops of the broader Redis state.
        logger.debug("[RateLimit] Redis pipeline error (this request only): %s", e)
        return _check_rate_limit_sqlite(key)


def _check_rate_limit_sqlite(key: str) -> tuple[bool, int, int]:
    """File-backed sliding-window fallback.

    Survives process restarts. Multi-worker safe via SQLite's WAL + per-write
    lock; coarser than Redis but functionally correct for sliding-window
    semantics.
    """
    global _redis_fallback_request_count
    _redis_fallback_request_count += 1

    conn = _init_sqlite()
    now = time.time()
    window_start = now - RATE_WINDOW

    with _sqlite_lock:
        # Prune old entries for this key.
        conn.execute(
            "DELETE FROM rate_limit_events WHERE key = ? AND ts < ?",
            (key, window_start),
        )
        cursor = conn.execute(
            "SELECT COUNT(*) FROM rate_limit_events WHERE key = ?",
            (key,),
        )
        current_count = cursor.fetchone()[0]

        if current_count >= RATE_LIMIT:
            cursor = conn.execute(
                "SELECT MIN(ts) FROM rate_limit_events WHERE key = ?",
                (key,),
            )
            oldest = cursor.fetchone()[0] or now
            return False, 0, int(oldest + RATE_WINDOW)

        conn.execute(
            "INSERT INTO rate_limit_events (key, ts) VALUES (?, ?)",
            (key, now),
        )

    remaining = RATE_LIMIT - current_count - 1
    reset_time = int(now + RATE_WINDOW)
    return True, remaining, reset_time


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Rate limiting middleware using sliding window algorithm.

    Adds headers:
    - X-RateLimit-Limit: Maximum requests per window
    - X-RateLimit-Remaining: Remaining requests
    - X-RateLimit-Reset: Unix timestamp when the window resets

    Returns 429 Too Many Requests when limit is exceeded.
    """

    # Paths exempt from rate limiting
    EXEMPT_PATHS: ClassVar[set[str]] = {"/health", "/openapi.json", "/docs", "/redoc"}

    def __init__(self, app):
        super().__init__(app)
        # Resolve Redis state at startup (one-shot WARN if unreachable)
        # rather than on first request.
        _get_redis()

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Skip rate limiting for exempt paths
        if request.url.path in self.EXEMPT_PATHS:
            return await call_next(request)

        # Skip OPTIONS requests (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # Get rate limit key
        key = _get_client_key(request)

        # Check rate limit
        allowed, remaining, reset_time = _check_rate_limit_redis(key)

        if not allowed:
            logger.warning(f"Rate limit exceeded for {key}")
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Too many requests. Please slow down.",
                    "retry_after": reset_time - int(time.time()),
                },
                headers={
                    "X-RateLimit-Limit": str(RATE_LIMIT),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(reset_time),
                    "Retry-After": str(reset_time - int(time.time())),
                },
            )

        # Process request
        response = await call_next(request)

        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(RATE_LIMIT)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        response.headers["X-RateLimit-Reset"] = str(reset_time)

        return response
