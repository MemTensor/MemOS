"""Opt-in Redis GCRA admission for OpenAI-compatible chat completions."""

import math
import os
import random
import threading
import time

from collections import deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import openai

from memos.configs.llm_rate_limit import LLMRateLimitConfig, QPSLimitRule
from memos.exceptions import (
    ConfigurationError,
    LLMRateLimitQueueFullError,
    LLMRateLimitTimeoutError,
    LLMRateLimitUnavailableError,
)
from memos.log import get_logger


logger = get_logger(__name__)

GCRA_LUA = """
local interval = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000000 + tonumber(clock[2])
local raw = redis.call('GET', KEYS[1])
local tat = tonumber(raw)
if raw and not tat then
    return redis.error_reply('Invalid GCRA state')
end
tat = tat or now
local wait = tat - (burst - 1) * interval - now
if wait > 0 then
    return {0, math.ceil(wait)}
end
local next_tat = math.max(tat, now) + interval
redis.call('SET', KEYS[1], string.format('%.0f', next_tat),
           'PX', math.max(1, math.ceil((next_tat - now) / 1000)))
return {1, 0}
"""


def _create_redis_client(config: LLMRateLimitConfig) -> Any:
    if not config.redis_host:
        raise ConfigurationError("LLM QPS limiting requires a Redis host")
    try:
        import redis

        from redis.backoff import NoBackoff
        from redis.retry import Retry
    except ImportError as exc:
        raise ConfigurationError(
            "Install the mem-scheduler extras to enable LLM QPS limiting"
        ) from exc
    return redis.Redis(
        host=config.redis_host,
        port=config.redis_port,
        db=config.redis_db,
        username=config.redis_username,
        password=config.redis_password,
        ssl=config.redis_ssl,
        socket_timeout=config.redis_socket_timeout,
        socket_connect_timeout=config.redis_socket_timeout,
        max_connections=2,
        decode_responses=True,
        retry=Retry(NoBackoff(), 0),
    )


class RedisGCRALimiter:
    """One bounded queue per process/quota; only its head accesses Redis."""

    def __init__(self, config: LLMRateLimitConfig, rule: QPSLimitRule, key: str) -> None:
        self.config = config.model_copy(deep=True)
        self.rule = rule.model_copy(deep=True)
        self.redis_key = key
        self._client = _create_redis_client(config)
        self._script = self._client.register_script(GCRA_LUA)
        self._condition = threading.Condition()
        self._queue: deque[object] = deque()

    @property
    def pending_count(self) -> int:
        """Number of local waiters including the active queue head."""
        with self._condition:
            return len(self._queue)

    def acquire(self, timeout_seconds: float | None = None) -> None:
        """Wait for admission, bounded by a cumulative monotonic deadline."""
        from redis.exceptions import RedisError

        started = time.monotonic()
        timeout = self.rule.max_wait_seconds if timeout_seconds is None else timeout_seconds
        deadline = started + timeout
        waiter = object()
        with self._condition:
            if len(self._queue) >= self.rule.queue_capacity:
                logger.warning("[LLM_RATE_LIMIT] queue_full key=%s", self.redis_key)
                raise LLMRateLimitQueueFullError("LLM permit queue is full")
            self._queue.append(waiter)
        checks = 0
        next_check = started
        try:
            while True:
                with self._condition:
                    now = time.monotonic()
                    if now >= deadline:
                        raise LLMRateLimitTimeoutError("LLM permit waiting deadline exceeded")
                    head = self._queue[0] is waiter
                    if not head or now < next_check:
                        delay = min(deadline - now, next_check - now) if head else deadline - now
                        self._condition.wait(delay)
                        continue
                try:
                    checks += 1
                    reply = self._script(
                        keys=[self.redis_key],
                        args=[math.ceil(1_000_000 / self.rule.qps), self.rule.burst],
                    )
                except RedisError:
                    logger.warning(
                        "[LLM_RATE_LIMIT] redis_unavailable key=%s failure_mode=%s",
                        self.redis_key,
                        self.config.failure_mode,
                    )
                    if self.config.failure_mode == "open" and time.monotonic() < deadline:
                        return
                    raise LLMRateLimitUnavailableError("Redis LLM limiter is unavailable") from None
                if time.monotonic() >= deadline:
                    # A late successful reply consumes a permit; never refund uncertain sends.
                    raise LLMRateLimitTimeoutError("LLM permit waiting deadline exceeded")
                if not isinstance(reply, list | tuple) or len(reply) != 2 or reply[0] not in (0, 1):
                    raise LLMRateLimitUnavailableError("Invalid Redis LLM limiter response")
                if reply[0]:
                    logger.debug(
                        "[LLM_RATE_LIMIT] granted key=%s wait_ms=%.2f checks=%d",
                        self.redis_key,
                        (time.monotonic() - started) * 1000,
                        checks,
                    )
                    return
                wait_us = reply[1]
                if (
                    not isinstance(wait_us, int | float)
                    or not math.isfinite(wait_us)
                    or wait_us <= 0
                ):
                    raise LLMRateLimitUnavailableError("Invalid Redis LLM limiter wait time")
                next_check = (
                    time.monotonic()
                    + wait_us / 1_000_000
                    + random.uniform(0, self.rule.wait_jitter_seconds)
                )
        except LLMRateLimitTimeoutError:
            logger.warning("[LLM_RATE_LIMIT] wait_timeout key=%s checks=%d", self.redis_key, checks)
            raise
        finally:
            with self._condition:
                self._queue.remove(waiter)
                self._condition.notify_all()


_registry: dict[tuple, RedisGCRALimiter] = {}
_registry_lock = threading.Lock()


def _after_fork() -> None:
    global _registry, _registry_lock
    _registry = {}
    _registry_lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


def get_limiter(config: LLMRateLimitConfig, rule: QPSLimitRule, model: str) -> RedisGCRALimiter:
    """Share admission for the same actual model, independently of its endpoint."""
    key = f"{config.key_prefix}:{model}"
    identity = (
        config.redis_host,
        config.redis_port,
        config.redis_db,
        config.redis_username,
        config.redis_password,
        config.redis_ssl,
        key,
    )
    with _registry_lock:
        current = _registry.get(identity)
        if current is not None:
            if (
                current.rule.qps != rule.qps
                or current.rule.burst != rule.burst
                or current.rule.queue_capacity != rule.queue_capacity
                or current.rule.wait_jitter_seconds != rule.wait_jitter_seconds
                or current.config.failure_mode != config.failure_mode
                or current.config.redis_socket_timeout != config.redis_socket_timeout
            ):
                raise ConfigurationError("Conflicting LLM limiter settings for the same quota pool")
            return current
        limiter = RedisGCRALimiter(config, rule, key)
        _registry[identity] = limiter
        return limiter


def _retry_delay(error: openai.APIError, rule: QPSLimitRule, attempt: int) -> float | None:
    if isinstance(error, openai.APIStatusError):
        if error.status_code not in (408, 409, 429) and error.status_code < 500:
            return None
        headers = error.response.headers
        requested_delay = None
        try:
            if "retry-after-ms" in headers:
                requested_delay = float(headers["retry-after-ms"]) / 1000
            elif "retry-after" in headers:
                try:
                    requested_delay = float(headers["retry-after"])
                except ValueError:
                    date = parsedate_to_datetime(headers["retry-after"])
                    if date.tzinfo is None:
                        date = date.replace(tzinfo=timezone.utc)
                    requested_delay = (date - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            requested_delay = None
        if requested_delay is not None and math.isfinite(requested_delay) and requested_delay >= 0:
            return requested_delay if requested_delay <= rule.retry_max_delay else None
    elif not isinstance(error, openai.APIConnectionError):
        return None
    cap = min(rule.retry_max_delay, rule.retry_initial_delay * 2**attempt)
    return random.uniform(cap / 2, cap)


def create_completion(client: Any, body: dict, config: LLMRateLimitConfig) -> Any:
    """Gate each SDK wire attempt; leave legacy behavior unchanged when unselected."""
    model = body["model"]
    rule = config.rule_for(model)
    if rule is None:
        return client.chat.completions.create(**body)
    limiter = get_limiter(config, rule, model)
    managed_client = client.with_options(max_retries=0)
    remaining_wait = rule.max_wait_seconds
    for attempt in range(rule.retry_attempts + 1):
        started = time.monotonic()
        limiter.acquire(timeout_seconds=remaining_wait)
        remaining_wait -= time.monotonic() - started
        logger.info(
            "[LLM_RATE_LIMIT] sending model=%s attempt=%d permit_wait_ms=%.2f",
            model,
            attempt + 1,
            (time.monotonic() - started) * 1000,
        )
        try:
            return managed_client.chat.completions.create(**body)
        except openai.APIError as error:
            if attempt == rule.retry_attempts:
                raise
            delay = _retry_delay(error, rule, attempt)
            if delay is None:
                raise
            logger.warning(
                "[LLM_RATE_LIMIT] retry model=%s attempt=%d error_type=%s delay_s=%.3f",
                model,
                attempt + 1,
                type(error).__name__,
                delay,
            )
            time.sleep(delay)
