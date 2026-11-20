"""项目记忆主干演示：mock add 数据走一遍完整的 HTTP 链路。

    create_space → add/message ×N（决策七轮 / 经验三段）→ 调度 → get/status
    → search/memory → get/memory（space_id）→ get_message

默认用替身（假 graph_db、假向量模型、按规则答题的 RuleLLM），不联网、不需要 key：

    MEMOS_BASE_PATH=/tmp/memos python examples/project_memory/demo_mock_add.py

接真模型、真库（SQLite 文件库，数据留在磁盘上）：

    # 用测试专用的 key，逐个 export；不要 source 整份 env 文件（里面有非 shell 语法，值会被打进日志）
    export PROJECT_MEMORY_LLM_MODEL=gpt-4o-mini
    export PROJECT_MEMORY_LLM_API_BASE=<网关地址>
    export PROJECT_MEMORY_LLM_API_KEY=<测试 key>
    export PROJECT_MEMORY_EMBEDDER_BACKEND=universal_api PROJECT_MEMORY_EMBEDDER_PROVIDER=openai
    export PROJECT_MEMORY_EMBEDDER_MODEL=bge-m3 PROJECT_MEMORY_EMBEDDER_DIMENSION=1024
    export PROJECT_MEMORY_EMBEDDER_API_BASE=<向量服务地址> PROJECT_MEMORY_EMBEDDER_API_KEY=<测试 key>
    export PROJECT_MEMORY_SQLITE_PATH=/tmp/memos/project_memory.db
    MEMOS_BASE_PATH=/tmp/memos python examples/project_memory/demo_mock_add.py --live

`--live` 时：模型与向量模型走 MemOS 的 LLMFactory / EmbedderFactory（配置见 project_memory/config.py），
存储走 memos.graph_dbs.sqlite.SQLiteGraphDB（FTS5 全文 + sqlite-vec 向量 + rev 条件写）。
"""

from __future__ import annotations

import argparse
import json
import os
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


def build(live: bool):
    if not live:
        return build_http_app()
    import memos.project_memory.config as cfg

    llm = cfg.build_llm()
    judge_llm = cfg.build_llm("PROJECT_MEMORY_JUDGE_LLM")
    embedder = cfg.build_embedder()
    graph_db = cfg.build_graph_db()
    if llm is None:
        raise SystemExit(
            "没有可用的模型配置：设 PROJECT_MEMORY_LLM_* 或 OPENAI_API_KEY / MOS_CHAT_MODEL"
        )
    print(
        f"[live] 模型 {os.getenv('PROJECT_MEMORY_LLM_MODEL') or os.getenv('MOS_CHAT_MODEL')}"
        f"｜判别 {'独立模型' if judge_llm else '同生成模型'}"
        f"｜向量 {'自带' if embedder else '核心 embedder'}"
        f"｜库 {type(graph_db).__name__} → {getattr(graph_db.config, 'db_path', '')}"
    )
    return build_http_app(llm=llm, graph_db=graph_db, embedder=embedder)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="用真模型与真库（SQLite），见文件头")
    ap.add_argument("--scenario", default="all", choices=["all", "decision", "experience"])
    args = ap.parse_args()

    client, sched, plugin = build(args.live)
    rounds = {
        "all": DECISION_ROUNDS + EXPERIENCE_ROUNDS,
        "decision": DECISION_ROUNDS,
        "experience": EXPERIENCE_ROUNDS,
    }[args.scenario]
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

        for rnd in rounds:
            body = {
                "user_id": rnd["user_id"],
                "conversation_id": rnd["conversation_id"],
                "space_ids": sid,
                "allow_memory_view": ["project"],
                "messages": rnd["messages"],
            }
            resp = client.post("/product/add", json=body)
            if resp.status_code != 200:
                print(f"\n■ {rnd['label']}  add 失败 {resp.status_code}: {resp.text[:400]}")
                continue
            task = resp.json()["data"][0]
            sched.drain()
            st = client.get(
                "/product/scheduler/status",
                params={"user_id": rnd["user_id"], "task_id": task["task_id"]},
            ).json()["data"][0]
            # 会话结束：把还开着的段关掉并整理（线上由本地插件在会话结束时调，或定时任务调）
            plugin.service.flush(sid, rnd["conversation_id"])
            print(f"\n■ {rnd['label']}  add → {task['status']}  调度后 → {st['status']}")
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
        topics = r.json()["data"]["topic_detail_list"]
        if topics and topics[0]["decisions"]:
            show("get/memory（space_id）· 第一条决策（带来源）", topics[0]["decisions"][0])
        r = client.post(
            "/product/get_message", json={"conversation_id": rounds[-1]["conversation_id"]}
        )
        show(
            "get_message",
            [f"{m['role']}: {m['content'][:30]}" for m in r.json()["data"]["message_detail_list"]],
        )
    finally:
        reset_project_hooks()
    return 0


if __name__ == "__main__":
    sys.exit(main())
