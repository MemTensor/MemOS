"""项目记忆主干演示：mock add 数据走一遍完整的 HTTP 链路。

    create_space → add/message ×9（决策七轮 + 经验三段）→ 调度 → get/status
    → search/memory → get/memory（space_id）→ get_message

跑法（MemOS 仓库根目录）：
    MEMOS_BASE_PATH=/tmp/memos python examples/project_memory/demo_mock_add.py

核心的 /product 路由、调度处理器、插件都是真代码；大模型是按规则答题的 RuleLLM（构造的输出，
不是实跑），存储是照开源 Postgres 后端语义写的内存版 graph_db。换成真模型：把 build_http_app 的
llm 换成 MemOS 的 LLM 实例（有 generate(messages) 即可）。
"""

from __future__ import annotations

import json
import sys

from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from memos.project_memory.testing import (
    DECISION_ROUNDS,
    EXPERIENCE_ROUNDS,
    build_http_app,
    reset_project_hooks,
)


def show(title: str, obj) -> None:
    print(f"\n── {title} " + "─" * max(0, 60 - len(title)))
    print(json.dumps(obj, ensure_ascii=False, indent=1) if not isinstance(obj, str) else obj)


def main() -> int:
    client, sched, plugin = build_http_app()
    try:
        r = client.post(
            "/product/create_space",
            json={
                "space_name": "MemOS 云服务",
                "instructions": "术语以 PRD 为准",
                "domains": [
                    {"name": "代码开发", "description": "接口与存储实现"},
                    {"name": "产品设计"},
                ],
            },
        )
        sid = r.json()["data"]["space_id"]
        show("create_space", r.json()["data"])

        for rnd in DECISION_ROUNDS + EXPERIENCE_ROUNDS:
            body = {
                "user_id": rnd["user_id"],
                "conversation_id": rnd["conversation_id"],
                "space_ids": sid,
                "allow_memory_view": ["project"],
                "messages": rnd["messages"],
            }
            task = client.post("/product/add", json=body).json()["data"][0]
            sched.drain()
            st = client.get(
                "/product/scheduler/status",
                params={"user_id": rnd["user_id"], "task_id": task["task_id"]},
            )
            print(
                f"\n■ {rnd['label']}  add → {task['status']}  调度后 → {st.json()['data'][0]['status']}"
            )
            for line in plugin.service.last_trace:
                print("   " + line)

        r = client.post(
            "/product/search",
            json={
                "user_id": "user_x",
                "query": "本机整理结果怎么存？",
                "space_ids": [sid],
                "include_memory_view": ["project"],
                "memory_limit_number": 3,
            },
        )
        show("search/memory（project）", r.json()["data"])

        r = client.post("/product/get_memory", json={"space_id": sid})
        t = r.json()["data"]["topic_detail_list"][0]
        show("get/memory（space_id）· 第一条决策（带来源）", t["decisions"][0])

        r = client.post("/product/get_message", json={"conversation_id": "claude-code:b-1031"})
        show(
            "get_message",
            [f"{m['role']}: {m['content'][:30]}" for m in r.json()["data"]["message_detail_list"]],
        )
    finally:
        reset_project_hooks()
    return 0


if __name__ == "__main__":
    sys.exit(main())
