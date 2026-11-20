"""Independent worker, real Redis transport and real openGauss resource ownership.

MEMOS_WORKER_REDIS_TEST_PORT must point at an isolated, disposable Redis instance.
"""

import multiprocessing
import os
import uuid

from functools import partial

import pytest
import redis

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.graph_dbs.opengauss import OpenGaussGraphDB
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.task_schedule_modules.task_queue import ScheduleTaskQueue
from memos.mem_scheduler.worker import run_scheduler_worker
from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import database as _database


database = _database
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG") or not os.getenv("MEMOS_WORKER_REDIS_TEST_PORT"),
    reason="requires openGauss and an isolated worker-test Redis",
)


class _ReportingGraph:
    def __init__(self, graph, results):
        self.graph, self.results = graph, results

    def close(self):
        self.graph.close()
        self.results.put(("closed", os.getpid()))


def _build_storage_worker(config, results):
    scheduler = BaseScheduler(
        {"use_redis_queue": True, "thread_pool_max_workers": 2, "consume_interval_seconds": 0.01}
    )
    try:
        graph = OpenGaussGraphDB(OpenGaussGraphDBConfig(**config))
        scheduler.components = {"graph_db": _ReportingGraph(graph, results)}

        def persist(messages):
            for message in messages:
                graph.add_node(
                    message.item_id,
                    message.content,
                    {"memory_type": "WorkingMemory"},
                    user_name=message.mem_cube_id,
                )
                results.put((message.content, os.getpid()))

        scheduler.register_handlers({"worker-test": persist})
        results.put(("ready", os.getpid()))
        return scheduler
    except BaseException:
        scheduler.close()
        raise


def test_real_cross_process_queue_and_database_sessions(database, monkeypatch):
    admin, config = database
    prefix = "worker-test-" + uuid.uuid4().hex
    port = int(os.environ["MEMOS_WORKER_REDIS_TEST_PORT"])
    for key, value in {
        "MEMOS_ENABLE_REDIS": "true",
        "MEMSCHEDULER_REDIS_HOST": "127.0.0.1",
        "MEMSCHEDULER_REDIS_PORT": str(port),
        "MEMSCHEDULER_REDIS_DB": "0",
        "MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX": prefix,
        "MEMSCHEDULER_REDIS_TIMEOUT": "2",
        "MEMSCHEDULER_REDIS_CONNECT_TIMEOUT": "2",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("MEMSCHEDULER_REDIS_PASSWORD", raising=False)
    ctx = multiprocessing.get_context("spawn")
    stop, results = ctx.Event(), ctx.Queue()
    transport = ScheduleTaskQueue(use_redis_queue=True, maxsize=100)
    inspect_redis = redis.Redis(host="127.0.0.1", port=port, decode_responses=True)
    before_clients = len(inspect_redis.client_list())
    child = ctx.Process(
        target=run_scheduler_worker,
        args=(partial(_build_storage_worker, config.model_dump(), results), stop),
    )
    try:
        child.start()
        assert results.get(timeout=15) == ("ready", child.pid)
        for index in range(2):
            content = f"late task {index}"
            transport.submit_messages(
                ScheduleMessageItem(
                    item_id=f"{prefix}-{index}",
                    user_id=prefix,
                    task_id=f"{prefix}-task",
                    mem_cube_id="A",
                    label="worker-test",
                    content=content,
                )
            )
            # A different process discovers new streams on the existing 30 s
            # refresh cycle; the test budget must include that documented delay.
            assert results.get(timeout=45) == (content, child.pid)
        stop.set()
        assert results.get(timeout=10) == ("closed", child.pid)
        child.join(10)
        assert child.exitcode == 0
        assert _query(
            admin, 'SELECT memory FROM ONLY memos_graph."Memory" ORDER BY business_id'
        ) == [("late task 0",), ("late task 1",)]
        assert _query(
            admin,
            "SELECT count(*) FROM pg_stat_activity WHERE datname=%s AND application_name='memos-opengauss'",
            (config.db_name,),
        ) == [(0,)]
        assert len(inspect_redis.client_list()) == before_clients
    finally:
        stop.set()
        if child.pid is not None:
            child.join(10)
            if child.is_alive():
                child.terminate()
                child.join(5)
            child.close()
        results.close()
        results.join_thread()
        transport.memos_message_queue._stop_stream_keys_refresh_thread()
        transport.memos_message_queue.redis_close()
        keys = list(inspect_redis.scan_iter(match=f"*{prefix}*"))
        if keys:
            inspect_redis.delete(*keys)
        assert list(inspect_redis.scan_iter(match=f"*{prefix}*")) == []
        inspect_redis.close()
