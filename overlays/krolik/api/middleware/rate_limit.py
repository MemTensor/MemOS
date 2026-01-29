"""
Redis-based Rate Limiting Middleware.

Implements sliding window rate limiting with Redis.
Falls back to in-memory limiting if Redis is unavailable.
"""

import os
import time
from collections import defaultdict
from typing import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

import memos.log

logger = memos.log.get_logger(__name__)

# Configuration from environment
RATE_LIMIT = int(os.getenv("RATE_LIMIT", "100"))  # Requests per window
RATE_WINDOW = int(os.getenv("RATE_WINDOW_SEC", "60"))  # Window in seconds
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")

# Redis client (lazy initialization)
_redis_client = None

# In-memory fallback (per process)
_memory_store: dict[str, list[float]] = defaultdict(list)


def _get_redis():
    """Get or create Redis client."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    try:
        import redis

        _redis_client = redis.from_url(REDIS_URL, decode_responses=True)
        _redis_client.ping()  # Test connection
        logger.info("Rate limiter connected to Redis")
        return _redis_client
    except Exception as e:
        logger.warning(f"Redis not available for rate limiting: {e}")
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
        return _check_rate_limit_memory(key)

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
        logger.warning(f"Redis rate limit error: {e}")
        return _check_rate_limit_memory(key)


def _check_rate_limit_memory(key: str) -> tuple[bool, int, int]:
    """
    Fallback in-memory rate limiting.

    Note: This is per-process and not distributed!
    """
    now = time.time()
    window_start = now - RATE_WINDOW

    # Clean old entries
    _memory_store[key] = [t for t in _memory_store[key] if t > window_start]

    current_count = len(_memory_store[key])

    if current_count >= RATE_LIMIT:
        reset_time = int(min(_memory_store[key]) + RATE_WINDOW) if _memory_store[key] else int(now + RATE_WINDOW)
        return False, 0, reset_time

    # Add current request
    _memory_store[key].append(now)

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
    EXEMPT_PATHS = {"/health", "/openapi.json", "/docs", "/redoc"}

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
