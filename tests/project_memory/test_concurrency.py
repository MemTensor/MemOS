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
    reset_project_hooks,
)


class SlowLLM(RuleLLM):
    """每次调用睡一会儿，模拟真模型的耗时（sleep 会让出 GIL，线程能真正重叠）。"""

    def __init__(self, delay: float):
        super().__init__()
        self.delay = delay

    def generate(self, messages: list[dict[str, str]], **kwargs) -> str:
        time.sleep(self.delay)
        return super().generate(messages, **kwargs)


def _sqlite_db(tmp_path):
    from memos.configs.graph_db import GraphDBConfigFactory
    from memos.graph_dbs.factory import GraphStoreFactory

    return GraphStoreFactory.from_config(
        GraphDBConfigFactory.model_validate(
            {
                "backend": "sqlite",
                "config": {"db_path": str(tmp_path / "pm.db"), "embedding_dimension": 8},
            }
        )
    )


def _db(kind: str, tmp_path, name: str):
    if kind == "fake":
        return FakeGraphDB()
    path = tmp_path / name
    path.mkdir(exist_ok=True)
    return _sqlite_db(path)


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


@pytest.mark.parametrize("kind", ["fake", "sqlite"])
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


@pytest.mark.parametrize("kind", ["fake", "sqlite"])
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
