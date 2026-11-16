# -*- coding: utf-8 -*-
"""主干自测：用 mock add 的样例跑完整链路，打印每一步与落库状态。

跑法（在 MemOS 仓库根目录，不用装全量依赖）：
    PYTHONPATH=src/memos python3 -m project_memory.demo_mock_add

不连数据库、不调模型：存储用 InMemoryProjectStore，模型答案来自 mock_script。
顺序按 T1 §0 的七轮：新增 → 不一致 → 加入 → 再不一致 →（拍板）→ 拍板后又有第三种说法。
"""

from __future__ import annotations

import json
import os
import sys

from .mock_data import CONV, SPACE, decision_final_turns, decision_turn7, decision_turns, experience_segment
from .mock_script import build_script
from .pipeline import ProjectMemoryPipeline, render_injection
from .store import InMemoryProjectStore


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def run() -> int:
    store = InMemoryProjectStore()
    pipe = ProjectMemoryPipeline(store, script=build_script())

    _banner("① 第 1–4 轮：新增 → 不一致 1 → 加入 → 不一致 2")
    _trace(pipe.ingest(SPACE, CONV, decision_turns()))

    _banner("② 第 5–6 轮：Agent 列出各项结论，用户B 定案（拍板）")
    _trace(pipe.ingest(SPACE, CONV, decision_final_turns()))

    _banner("③ 第 7 轮（构造）：拍板之后，用户A 又提了第三种说法")
    _trace(pipe.ingest(SPACE, CONV, decision_turn7()))

    print("\n--- 三张表此刻的行 ---")
    for d in store.list_decisions(SPACE):
        print(_decision_table(d))

    _banner("④ 经验一段：规则闸 → 过滤 → 抽卡片 → 合并")
    _trace(pipe.ingest(SPACE, CONV, experience_segment()))
    for e in store.list_experiences(SPACE):
        print(f"\n经验 {e.id}｜{e.status}｜confidence {e.confidence}｜{e.form}")
        print(f"  任务：{e.task_intent}")
        print(f"  做法：{e.principle}")
        print(f"  锚点：{e.anchors}｜来源段 {[s.get('segment_id') for s in e.sources]}")

    _banner("⑤ 检索：search/memory 的 project 部分")
    got = pipe.search(SPACE, "本机整理结果怎么存？")
    print(dump(got))

    _banner("⑥ 注入给 Agent 的文本（接入方按模板拼）")
    print(render_injection(got["topic_detail_list"]))

    _banner("⑦ 终态核对（T1 的七轮版）")
    ok = _assert_final(store)
    print("核对：" + ("全部通过" if ok else "有不通过项"))
    return 0 if ok else 1


def _banner(title: str) -> None:
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def _trace(res) -> None:
    for line in res.trace:
        print(line)
    if res.dropped:
        print("  丢弃清单：" + json.dumps(res.dropped, ensure_ascii=False))


def _decision_table(d) -> str:
    rows = [("decisions", "当前结论", d.content, d.time, "、".join(d.user_ids), "")]
    for c in d.conflicts:
        rows.append(("conflicts", f"不一致 {c.seq}", c.content, c.time, "、".join(c.user_ids), ""))
    for h in d.history:
        rows.append(("history", f"历史 {h.seq}", h.content, h.time, "、".join(h.user_ids), h.reason))

    head = ("表", "位置", "内容", "时间", "成员", "原因")
    widths = [max(_w(r[i]) for r in rows + [head]) for i in range(6)]
    out = [f"\n决策 {d.id}｜主题 {d.topic_id}｜v{d.version}"]
    out.append("  " + "  ".join(head[i] + " " * (widths[i] - _w(head[i])) for i in range(6)))
    for r in rows:
        out.append("  " + "  ".join(r[i] + " " * (widths[i] - _w(r[i])) for i in range(6)))
    return "\n".join(out)


def _w(s: str) -> int:
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in s)


def _assert_final(store) -> bool:
    decs = store.list_decisions(SPACE)
    ok = True
    if len(decs) != 1:
        print(f"  ✗ 应当只有 1 条决策，实际 {len(decs)}")
        return False
    d = decs[0]
    checks = [
        ("当前结论是「单库按 space_id 分表」（第 6 轮拍板）",
         d.content == "本机整理结果存入单个 SQLite 库，按 space_id 分表。"),
        ("第 7 轮那句晚于拍板，记成新的不一致结论（没有被清掉）",
         len(d.conflicts) == 1 and "按领域分库" in d.conflicts[0].content),
        ("历史 2 项（分库 → 拍板时落选；LanceDB → 拍板时落选）", len(d.history) == 2),
        ("负责人含 C、D、B", {"user_c", "user_d", "user_b"}.issubset(set(d.user_ids))),
        ("当前结论时间 = 拍板那条消息的时间", d.time == "2026-10-31T10:02:00+08:00"),
        ("经验 1 张，状态 candidate", len(store.list_experiences(SPACE)) == 1),
    ]
    for name, cond in checks:
        print(f"  {'✓' if cond else '✗'} {name}")
        ok = ok and bool(cond)
    return ok


if __name__ == "__main__":
    os.environ.setdefault("MEMOS_BASE_PATH", "/tmp/pm_run")
    sys.exit(run())
