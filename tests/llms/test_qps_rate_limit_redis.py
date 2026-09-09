"""Opt-in integration tests against an isolated local Redis, never .env Redis."""

import multiprocessing
import os
import shutil
import subprocess
import tempfile
import time

import pytest

from memos.configs.llm_rate_limit import LLMRateLimitConfig
from memos.exceptions import LLMRateLimitTimeoutError
from memos.llms import rate_limit


redis = pytest.importorskip("redis")
pytestmark = pytest.mark.skipif(
    os.getenv("MEMOS_TEST_LOCAL_REDIS") != "1",
    reason="Set MEMOS_TEST_LOCAL_REDIS=1 to start an isolated local Redis",
)


@pytest.fixture(scope="module")
def local_redis(tmp_path_factory):
    executable = shutil.which("redis-server")
    if not executable:
        pytest.skip("Local redis-server is not installed")
    root = tmp_path_factory.mktemp("redis-gcra")
    # Unix socket paths must remain short, even when pytest's temp root is long.
    with tempfile.TemporaryDirectory(prefix="memos-qps-", dir="/tmp") as socket_dir:
        socket_path = os.path.join(socket_dir, "redis.sock")
        with (root / "redis.log").open("w") as log:
            process = subprocess.Popen(
                [
                    executable,
                    "--port",
                    "0",
                    "--unixsocket",
                    socket_path,
                    "--unixsocketperm",
                    "700",
                    "--save",
                    "",
                    "--appendonly",
                    "no",
                    "--dir",
                    str(root),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            client = redis.Redis(
                unix_socket_path=socket_path, decode_responses=True, socket_timeout=2
            )
            try:
                for _ in range(100):
                    assert process.poll() is None, "Local Redis startup failed"
                    try:
                        if client.ping():
                            break
                    except redis.ConnectionError:
                        time.sleep(0.05)
                else:
                    pytest.fail("Local Redis startup timed out")
                yield client, socket_path
            finally:
                client.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def test_real_script_total_burst_and_deny_does_not_advance_tat(local_redis):
    client, _ = local_redis
    script = client.register_script(rate_limit.GCRA_LUA)
    key = "test:burst"
    assert script(keys=[key], args=[200_000, 2]) == [1, 0]
    assert script(keys=[key], args=[200_000, 2]) == [1, 0]
    before = client.get(key)
    denied = script(keys=[key], args=[200_000, 2])
    assert denied[0] == 0 and 0 < denied[1] <= 200_000
    assert client.get(key) == before
    assert 0 < client.pttl(key) <= 400
    time.sleep(denied[1] / 1_000_000 + 0.01)
    assert script(keys=[key], args=[200_000, 2]) == [1, 0]


def test_real_queue_refill_and_script_cache_recovery(local_redis, monkeypatch):
    client, _ = local_redis
    monkeypatch.setattr(rate_limit, "_create_redis_client", lambda _: client)
    config = LLMRateLimitConfig(
        enabled=True, redis_host="unused.invalid", qps=5, burst=2, wait_jitter_seconds=0
    )
    limiter = rate_limit.RedisGCRALimiter(config, config.rule_for("gpt-4o-mini"), "test:queue")
    limiter.acquire()
    limiter.acquire()
    start = time.monotonic()
    limiter.acquire()
    assert time.monotonic() - start >= 0.15
    client.script_flush()
    limiter.acquire()
    assert limiter.pending_count == 0


def _process_attempts(socket_path, gate, output):
    client = redis.Redis(unix_socket_path=socket_path, decode_responses=True, socket_timeout=2)
    try:
        script = client.register_script(rate_limit.GCRA_LUA)
        client.ping()
        gate.wait(timeout=40)
        # A 100-second refill interval isolates atomic initial-burst behavior from timing noise.
        output.put(
            sum(script(keys=["test:processes"], args=[100_000_000, 2])[0] for _ in range(20))
        )
    finally:
        client.close()


def test_four_processes_share_one_atomic_burst(local_redis):
    _, socket_path = local_redis
    context = multiprocessing.get_context("spawn")
    gate = context.Barrier(4)
    output = context.Queue()
    processes = [
        context.Process(target=_process_attempts, args=(socket_path, gate, output))
        for _ in range(4)
    ]
    try:
        for process in processes:
            process.start()
        assert sum(output.get(timeout=60) for _ in processes) == 2
        for process in processes:
            process.join(timeout=5)
            assert process.exitcode == 0
    finally:
        for process in processes:
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=5)
        output.close()
        output.join_thread()


def test_corrupt_tat_is_not_silently_reset(local_redis):
    client, _ = local_redis
    client.set("test:corrupt", "invalid")
    script = client.register_script(rate_limit.GCRA_LUA)
    with pytest.raises(redis.ResponseError, match="Invalid GCRA state"):
        script(keys=["test:corrupt"], args=[200_000, 2])
    assert client.get("test:corrupt") == "invalid"


def test_model_quota_exhaustion_does_not_block_another_model(local_redis, monkeypatch):
    client, _ = local_redis
    monkeypatch.setattr(rate_limit, "_create_redis_client", lambda _: client)
    monkeypatch.setattr(rate_limit, "_registry", {})
    config = LLMRateLimitConfig(
        enabled=True,
        max_wait_seconds=0.01,
        rules={
            "gpt-4o-mini": {"qps": 0.001, "burst": 1},
            "other": {"qps": 0.002, "burst": 2},
        },
    )
    primary = rate_limit.get_limiter(config, config.rule_for("gpt-4o-mini"), "gpt-4o-mini")
    other = rate_limit.get_limiter(config, config.rule_for("other"), "other")
    primary_key = f"{config.key_prefix}:gpt-4o-mini"
    other_key = f"{config.key_prefix}:other"
    primary.acquire()
    before = client.get(primary_key)
    with pytest.raises(LLMRateLimitTimeoutError):
        primary.acquire()
    other.acquire()
    other.acquire()
    with pytest.raises(LLMRateLimitTimeoutError):
        other.acquire()
    assert client.get(primary_key) == before
    assert client.exists(other_key) == 1
