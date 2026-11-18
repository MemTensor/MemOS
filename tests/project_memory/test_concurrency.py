"""项目记忆：同一 Space 内的并行整理。

调度器按 (user_id, mem_cube_id) 分组派给线程池；项目记忆一个会话一条流，所以同一 Space
的不同会话会同时整理。这里照线上 dispatcher 的做法并行跑各组，检查三件事：
1. 结果与顺序整理一致：不重复建主题，两人相反的结论一条当前、一条分歧，不会都当新增；
2. 真的并行了：模型调用带延迟时，并行总耗时明显少于顺序；
3. 锁可以由工程换成自己的实现（`H.PROJECT_MEMORY_LOCK`），项目记忆代码不用改。
"""

from __future__ import annotations

import threading
import time

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from memos.project_memory.locks import InProcessLocks
from memos.project_memory.testing import (
    DECISION_ROUNDS,
    FakeGraphDB,
    RuleLLM,
    build_http_app,
    make_test_db,
    reset_project_hooks,
    storage_kinds,
)


class SlowLLM(RuleLLM):
    """每次调用睡一会儿，模拟真模型的耗时（sleep 会让出 GIL，线程能真正重叠）。"""

    def __init__(self, delay: float):
        super().__init__()
        self.delay = delay

    def generate(self, messages: list[dict[str, str]], **kwargs) -> str:
        time.sleep(self.delay)
        return super().generate(messages, **kwargs)


def _db(kind: str, tmp_path, name: str):
    return make_test_db(kind, tmp_path / name)


def _space(client) -> str:
    r = client.post(
        "/product/create_space",
        json={"space_name": "并发", "domains": [{"name": "代码开发"}]},
    )
    return r.json()["data"]["space_id"]


def _add(client, sid: str, rnd: dict[str, Any]) -> None:
    r = client.post(
        "/product/add",
        json={
            "user_id": rnd["user_id"],
            "conversation_id": rnd["conversation_id"],
            "space_ids": sid,
            "allow_memory_view": ["project"],
            "messages": rnd["messages"],
        },
    )
    assert r.status_code == 200, r.text


def _drain_parallel(sched, workers: int = 8) -> int:
    """照线上 dispatcher：按 (user_id, mem_cube_id) 分组，每组交给线程池里的一个线程。"""
    from unittest.mock import Mock

    from memos.mem_scheduler.task_schedule_modules.handlers.project_memory_handler import (
        PROJECT_MEMORY_TASK_LABEL,
        ProjectMemoryMessageHandler,
    )

    handler = ProjectMemoryMessageHandler(Mock())
    n = 0
    while sched.queue:
        batch, sched.queue = sched.queue, []
        groups: dict[tuple[str, str], list] = defaultdict(list)
        for m in batch:
            if m.label == PROJECT_MEMORY_TASK_LABEL:
                groups[(m.user_id, m.mem_cube_id)].append(m)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for f in [pool.submit(handler, items) for items in groups.values()]:
                f.result()
        n += sum(len(g) for g in groups.values())
    return n


def _state(plugin, sid: str) -> tuple[int, int, int]:
    store = plugin.service.store
    decisions = store.list_decisions(sid)
    return (
        len(store.list_topics(sid)),
        len(decisions),
        sum(len(d.conflicts) for d in decisions),
    )


def _task_round(k: int) -> dict[str, Any]:
    """一个独立的小任务：Agent 回复「已完成」，段当场关；不含决策与工具调用。"""
    return {
        "user_id": f"user_{k}",
        "conversation_id": f"codex:task-{k}",
        "messages": [
            {
                "role": "user",
                "content": f"把第 {k} 个接口的文档补上",
                "chat_time": f"2026-11-01T10:{k:02d}:00+08:00",
                "role_id": f"user_{k}",
                "role_name": f"成员{k}",
            },
            {
                "role": "assistant",
                "content": f"已完成第 {k} 个接口的文档。",
                "chat_time": f"2026-11-01T10:{k:02d}:30+08:00",
            },
        ],
    }


@pytest.fixture(autouse=True)
def _clean_hooks():
    yield
    reset_project_hooks()


@pytest.mark.parametrize("kind", storage_kinds())
def test_two_members_disagree_in_parallel(kind, tmp_path):
    """两人在各自会话里给出相反结论，同时整理：一个主题、一条决策、一项分歧。"""
    client, sched, plugin = build_http_app(llm=RuleLLM(), graph_db=_db(kind, tmp_path, "seq"))
    sid = _space(client)
    for rnd in DECISION_ROUNDS[:2]:
        _add(client, sid, rnd)
        sched.drain()
    expected = _state(plugin, sid)
    assert expected == (1, 1, 1)
    reset_project_hooks()

    client, sched, plugin = build_http_app(llm=SlowLLM(0.05), graph_db=_db(kind, tmp_path, "par"))
    sid = _space(client)
    for rnd in DECISION_ROUNDS[:2]:
        _add(client, sid, rnd)
    assert len({m.user_id for m in sched.queue}) == 2, "两个会话应是两条流"
    assert {m.mem_cube_id for m in sched.queue} == {sid}, "mem_cube_id 仍是 Space"
    _drain_parallel(sched)
    assert _state(plugin, sid) == expected


@pytest.mark.parametrize("kind", storage_kinds())
def test_parallel_conversations_are_faster(kind, tmp_path):
    """6 个会话各做一件小事：并行整理的总耗时明显少于顺序，且只建一个主题。"""
    rounds = [_task_round(k) for k in range(6)]

    client, sched, plugin = build_http_app(llm=SlowLLM(0.05), graph_db=_db(kind, tmp_path, "seq"))
    sid = _space(client)
    for rnd in rounds:
        _add(client, sid, rnd)
    t0 = time.perf_counter()
    sched.drain()
    t_seq = time.perf_counter() - t0
    assert _state(plugin, sid)[0] == 1
    reset_project_hooks()

    client, sched, plugin = build_http_app(llm=SlowLLM(0.05), graph_db=_db(kind, tmp_path, "par"))
    sid = _space(client)
    for rnd in rounds:
        _add(client, sid, rnd)
    t0 = time.perf_counter()
    _drain_parallel(sched)
    t_par = time.perf_counter() - t0
    assert _state(plugin, sid)[0] == 1, "同时判成新建主题时只能建一个"
    print(f"[{kind}] 顺序 {t_seq:.2f}s，并行 {t_par:.2f}s")
    assert t_par < 0.7 * t_seq, f"并行 {t_par:.2f}s，顺序 {t_seq:.2f}s"


def test_lock_can_be_replaced_by_engineering():
    """工程注册 H.PROJECT_MEMORY_LOCK 后，项目记忆的每处加锁都走它。"""
    from memos.plugins.hook_defs import H
    from memos.plugins.hooks import register_hook

    client, sched, plugin = build_http_app(llm=RuleLLM(), graph_db=FakeGraphDB())
    keys: list[str] = []
    inner = InProcessLocks()
    guard = threading.Lock()

    def lock_hook(key: str, **kwargs):
        with guard:
            keys.append(key)
        return inner(key)

    register_hook(H.PROJECT_MEMORY_LOCK, lock_hook)
    sid = _space(client)
    for rnd in DECISION_ROUNDS[:2]:
        _add(client, sid, rnd)
        sched.drain()
    kinds = {k.split(":", 1)[0] for k in keys}
    assert {"conv", "topics", "topic", "task"} <= kinds, kinds
    assert _state(plugin, sid) == (1, 1, 1)


def _second_handle(kind: str, db, tmp_path):
    """同一份数据的第二个连接（模拟另一个副本）。"""
    if kind == "sqlite":
        return make_test_db("sqlite", tmp_path / "rep")  # 同一个文件
    import os

    from memos.project_memory.pg_backend import ProjectPostgresStore

    return ProjectPostgresStore(
        {"dsn": os.environ["PG_TEST_DSN"], "schema_name": db.schema, "embedding_dimension": db.dim}
    )


@pytest.mark.parametrize("kind", [k for k in storage_kinds() if k != "fake"])
def test_two_replicas_share_storage_and_lock(kind, tmp_path):
    """两个副本连同一个库、用同一把锁（工程注册的分布式锁的替身）：结果与顺序整理一致。"""
    from memos.api.product_models import APIADDRequest
    from memos.project_memory.judge import ModelHub
    from memos.project_memory.service import ProjectMemoryService
    from memos.project_memory.store import ProjectStore
    from memos.project_memory.testing import FakeEmbedder

    db1 = make_test_db(kind, tmp_path / "rep")
    db2 = _second_handle(kind, db1, tmp_path)
    shared_lock = InProcessLocks()  # 两个副本共用：相当于工程注册的 Redis 锁
    emb = FakeEmbedder().embed
    replicas = [
        ProjectMemoryService(ProjectStore(db, emb), ModelHub(SlowLLM(0.05)), lock=shared_lock)
        for db in (db1, db2)
    ]
    sid = replicas[0].create_space("并发", "", [{"name": "代码开发"}]).space_id

    def write(svc, rnd):
        svc.accept(
            APIADDRequest(
                user_id=rnd["user_id"],
                conversation_id=rnd["conversation_id"],
                space_ids=sid,
                allow_memory_view=["project"],
                messages=rnd["messages"],
            )
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        for f in [
            pool.submit(write, svc, rnd)
            for svc, rnd in zip(replicas, DECISION_ROUNDS[:2], strict=False)
        ]:
            f.result()

    store = replicas[0].store
    decisions = store.list_decisions(sid)
    assert (len(store.list_topics(sid)), len(decisions)) == (1, 1)
    assert sum(len(d.conflicts) for d in decisions) == 1
    if kind == "postgres":
        db2.close()


def test_plugin_storage_follows_config_not_core_graph_db(tmp_path, monkeypatch):
    """部署时项目记忆按 PROJECT_MEMORY_GRAPH_DB 建自己的库，不会落进核心的 graph_db。"""
    from memos.project_memory.plugin import CommunityProjectMemoryPlugin

    core_db = FakeGraphDB()
    monkeypatch.setenv("PROJECT_MEMORY_GRAPH_DB", "sqlite")
    monkeypatch.setenv("PROJECT_MEMORY_SQLITE_PATH", str(tmp_path / "own.db"))
    reset_project_hooks()
    plugin = CommunityProjectMemoryPlugin()
    plugin.on_load()
    plugin.init_components({"shared": {"graph_db": core_db, "llm": RuleLLM()}})
    db = plugin.service.store.db
    assert db is not core_db and type(db).__name__ == "SQLiteGraphDB"

    monkeypatch.setenv("PROJECT_MEMORY_GRAPH_DB", "shared")
    plugin.init_components({"shared": {"graph_db": core_db, "llm": RuleLLM()}})
    assert plugin.service.store.db is core_db


def test_topic_limit_defaults_to_9_and_caps_at_25():
    """条数：没传用 9；传了超过 25 按 25 截断，不报错（/product 不再校验，交给工程层）。"""
    from types import SimpleNamespace

    client, sched, plugin = build_http_app(llm=RuleLLM(), graph_db=FakeGraphDB())
    svc = plugin.service
    seen: list[int] = []
    real = svc.store.recall_topics

    def spy(space_id, query, k, domains=None):
        seen.append(k)
        return real(space_id, query, k, domains=domains)

    svc.store.recall_topics = spy
    sid = _space(client)
    base = {"query": "x", "space_ids": [sid], "user_id": "u", "domains": None}
    svc.search(SimpleNamespace(**base, memory_limit_number=10, model_fields_set=set()))
    svc.search(
        SimpleNamespace(**base, memory_limit_number=30, model_fields_set={"memory_limit_number"})
    )
    assert seen == [9 * 2, 25 * 2]  # recall 取 limit 的两倍
    r = client.post(
        "/product/search",
        json={**base, "include_memory_view": ["project"], "memory_limit_number": 30},
    )
    assert r.status_code == 200, r.text
