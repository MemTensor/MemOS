#!/usr/bin/env python3
"""对已启动的服务跑一遍项目记忆冒烟（走 HTTP，不 import 服务端代码）。

    python3 docker/project-memory/smoke.py                       # 默认 http://127.0.0.1:8000
    python3 docker/project-memory/smoke.py --base http://host:8000 --scenario decision

依次：health → create_space → add/message ×N → flush（会话结束）→ get/status →
search/memory → get/memory（space_id）→ get/memory/{topic} → get_message → delete_memory。

样例数据用 examples/project_memory/mock_rounds.json（构造的：决策七轮 + 经验三段）。
环境变了（模型、库）先跑这个，比单元测试更接近线上。
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from pathlib import Path

import httpx


ROOT = Path(__file__).resolve().parents[2]


def load_rounds(scenario: str) -> list[dict]:
    data = json.loads(
        (ROOT / "examples/project_memory/mock_rounds.json").read_text(encoding="utf-8")
    )
    if scenario == "decision":
        return data["decision"]
    if scenario == "experience":
        return data["experience"]
    return data["decision"] + data["experience"]


def check(name: str, cond: bool, detail: str = "") -> bool:
    print(f"  {'✓' if cond else '✗'} {name}{('：' + detail) if detail and not cond else ''}")
    return cond


def wait_task(c: httpx.Client, user_id: str, task_id: str, timeout: float = 240.0) -> dict:
    """整理是异步的（调度器里跑），轮询到 completed / failed，或超时。"""
    deadline = time.time() + timeout
    st: dict = {}
    while time.time() < deadline:
        st = c.get(
            "/product/scheduler/status", params={"user_id": user_id, "task_id": task_id}
        ).json()["data"][0]
        if st["status"] in ("completed", "failed"):
            return st
        time.sleep(2)
    return st


def post(c: httpx.Client, path: str, body: dict) -> dict:
    r = c.post(path, json=body)
    if r.status_code != 200:
        raise SystemExit(f"{path} → {r.status_code}: {r.text[:600]}")
    return r.json()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--scenario", default="all", choices=["all", "decision", "experience"])
    ap.add_argument("--timeout", type=float, default=180.0, help="单次请求超时（整段整理是同步的）")
    ap.add_argument("--keep", action="store_true", help="跑完不清空主题")
    args = ap.parse_args()

    ok = True
    with httpx.Client(base_url=args.base, timeout=args.timeout) as c:
        h = c.get("/health")
        ok &= check("health", h.status_code == 200, h.text[:200])
        if h.status_code != 200:
            return 1

        sp = post(
            c,
            "/product/create_space",
            {
                "space_name": "MemOS 云服务（冒烟）",
                "instructions": "术语以 PRD 为准",
                "domains": [
                    {"name": "代码开发", "description": "接口与存储实现"},
                    {"name": "产品设计"},
                ],
            },
        )["data"]
        sid = sp["space_id"]
        ok &= check("create_space 返回 space_id", bool(sid), str(sp))
        ok &= check("领域已建", len(sp["domains"]) == 2)

        rounds = load_rounds(args.scenario)
        task_ids: list[tuple[str, str]] = []
        for rnd in rounds:
            t0 = time.time()
            data = post(
                c,
                "/product/add",
                {
                    "user_id": rnd["user_id"],
                    "conversation_id": rnd["conversation_id"],
                    "space_ids": sid,
                    "allow_memory_view": ["project"],
                    "messages": rnd["messages"],
                },
            )["data"][0]
            task = data["task_id"]
            task_ids.append((rnd["user_id"], task))
            # 先把这一轮的 add 整理完，再发会话结束（否则段还没建，flush 找不到它）
            wait_task(c, rnd["user_id"], task)
            fl = post(
                c,
                "/product/flush_project_memory",
                {"space_id": sid, "conversation_id": rnd["conversation_id"], "task_id": task},
            )["data"]
            st = wait_task(c, rnd["user_id"], task)
            print(
                f"■ {rnd['label']}  add={data['status']}  flush={time.time() - t0:.1f}s  "
                f"status={st['status']}  topics={len(st['memory_views']['project']['memory_ids'])}"
            )
            for line in fl.get("trace") or []:
                print("   " + line)
            ok &= check(f"{rnd['label']} 整理完成", st["status"] == "completed", str(st))
            ok &= check(
                f"{rnd['label']} 归到主题",
                bool(st["memory_views"]["project"]["memory_ids"]),
                str(st),
            )

        got = post(
            c,
            "/product/search",
            {
                "user_id": "user_x",
                "query": "本机整理结果怎么存？",
                "space_ids": [sid],
                "include_memory_view": ["project"],
                "memory_limit_number": 3,
            },
        )["data"]
        topics = got.get("topic_detail_list") or []
        ok &= check(
            "search/memory 返回主题", bool(topics), json.dumps(got, ensure_ascii=False)[:400]
        )
        if topics:
            t = topics[0]
            for key in (
                "id",
                "space_id",
                "domain",
                "topic_name",
                "topic_summary",
                "topic_description",
                "decisions",
                "experiences",
                "timeline",
                "relativity",
            ):
                ok &= check(f"主题字段 {key}", key in t)
            ok &= check("search 不返回 sources", "sources" not in t)
            for d in t.get("decisions") or []:
                ok &= check(
                    "决策带 content/time/user_ids", {"content", "time", "user_ids"} <= set(d)
                )

        full = post(c, "/product/get_memory", {"space_id": sid})["data"]
        full_topics = full.get("topic_detail_list") or []
        ok &= check(
            "get/memory 按 space 返回",
            full.get("total", 0) >= 1,
            json.dumps(full, ensure_ascii=False)[:300],
        )
        if full_topics:
            ft = full_topics[0]
            ok &= check("get/memory 带来源会话", bool(ft.get("sources")))
            ok &= check("get/memory 带 create_time", bool(ft.get("create_time")))
            if ft.get("decisions"):
                ok &= check("决策带来源", bool(ft["decisions"][0].get("source")))
            one = c.get(f"/product/get_memory/{ft['id']}").json()["data"]["topic_detail_list"][0]
            ok &= check("get/memory/{id} 与列表一致", one["id"] == ft["id"])

        msgs = post(c, "/product/get_message", {"conversation_id": rounds[-1]["conversation_id"]})[
            "data"
        ]
        ok &= check("get_message 有消息", bool(msgs.get("message_detail_list")))

        if not args.keep:
            deleted = post(c, "/product/delete_memory", {"space_id": sid})["data"]
            ok &= check("delete_memory 清空主题", bool(deleted.get("deleted_topic_ids")))
            after = post(c, "/product/get_memory", {"space_id": sid})["data"]
            ok &= check("清空后主题为 0", after.get("total") == 0)
            ok &= check(
                "清空后领域还在",
                bool(post(c, "/product/list_domains", {"space_id": sid})["data"]["domains"]),
            )

    print("\n冒烟：" + ("全部通过" if ok else "有不通过项"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
