"""主干自测与演示用的替身：假 graph_db（照开源 Postgres 后端的接口与语义）、假向量模型、
按规则答题的假大模型，以及 mock add 的样例数据。

假大模型走的是真实路径：`LLMBackend` 照常拼提示词、调 `generate(messages)`、解析 JSON，
它只是看提示词里的材料按规则给出「一个合格的模型会给的输出」。输出是构造的，不是实跑结果。
"""

from __future__ import annotations

import hashlib
import json
import math
import re

from typing import Any


# ═════════════════════════════ 假 graph_db ══════════════════════════════════


class FakeGraphDB:
    """只实现项目记忆用到的方法；参数与返回形状照 `graph_dbs/postgres.py`。"""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.writes = 0

    def add_node(
        self, id: str, memory: str, metadata: dict[str, Any], user_name: str | None = None
    ) -> None:
        meta = json.loads(json.dumps(metadata, ensure_ascii=False))
        emb = meta.pop("embedding", None)
        self.rows[id] = {
            "id": id,
            "memory": memory,
            "properties": meta,
            "embedding": emb,
            "user_name": user_name or meta.get("user_name"),
        }
        self.writes += 1

    def _out(self, r: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": r["id"],
            "memory": r["memory"],
            "metadata": json.loads(json.dumps(r["properties"], ensure_ascii=False)),
        }

    def get_node(self, id: str, include_embedding: bool = False, **kwargs) -> dict[str, Any] | None:
        r = self.rows.get(id)
        if r is None or (kwargs.get("user_name") and r["user_name"] != kwargs["user_name"]):
            return None
        return self._out(r)

    def get_nodes(
        self, ids: list, include_embedding: bool = False, **kwargs
    ) -> list[dict[str, Any]]:
        return [n for n in (self.get_node(i, **kwargs) for i in ids) if n]

    def delete_node(self, id: str, user_name: str | None = None) -> None:
        r = self.rows.get(id)
        if r and (user_name is None or r["user_name"] == user_name):
            del self.rows[id]

    def get_by_metadata(
        self,
        filters: list[dict[str, Any]],
        status: str | None = None,
        user_name: str | None = None,
        **kwargs,
    ) -> list[str]:
        out = []
        for r in list(self.rows.values()):  # 并发用例里别的线程可能正在写
            p = r["properties"]
            if user_name and r["user_name"] != user_name:
                continue
            if status and p.get("status") != status:
                continue
            ok = True
            for f in filters:
                field, op, value = f["field"], f.get("op", "="), f["value"]
                got = p.get(field)
                if (
                    (op == "=" and str(got) != str(value))
                    or (op == "in" and str(got) not in [str(v) for v in value])
                    or (op == "contains" and value not in (got or []))
                ):
                    ok = False
            if ok:
                out.append(r["id"])
        return out

    def search_by_embedding(
        self,
        vector: list[float],
        top_k: int = 5,
        scope: str | None = None,
        status: str | None = None,
        threshold: float | None = None,
        search_filter: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ) -> list[dict]:
        hits = []
        for r in list(self.rows.values()):  # 并发用例里别的线程可能正在写
            p = r["properties"]
            if r["embedding"] is None or (user_name and r["user_name"] != user_name):
                continue
            if scope and p.get("memory_type") != scope:
                continue
            if (status and p.get("status") != status) or (
                not status and p.get("status") not in ("activated", None)
            ):
                continue
            if search_filter and any(str(p.get(k)) != str(v) for k, v in search_filter.items()):
                continue
            s = _cos(vector, r["embedding"])
            if threshold is None or s >= threshold:
                hits.append({"id": r["id"], "score": s})
        hits.sort(key=lambda h: h["score"], reverse=True)
        return hits[:top_k]


def _cos(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b, strict=False)) / (na * nb)


class FakeEmbedder:
    """二元组哈希到 256 维，够让向量召回这条路真正跑起来。"""

    dim = 256

    def embed(self, texts: list[str]) -> list[list[float]]:
        out = []
        for t in texts:
            v = [0.0] * self.dim
            t = (t or "").lower()
            grams = [t[i : i + 2] for i in range(len(t) - 1)] or [t]
            for g in grams:
                v[int(hashlib.md5(g.encode()).hexdigest(), 16) % self.dim] += 1.0
            out.append(v)
        return out


# ═════════════════════════════ 假大模型 ═════════════════════════════════════


def _user_json(messages: list[dict[str, str]], marker: str | None = None) -> Any:
    user = messages[-1]["content"]
    if marker and marker in user:
        user = user.split(marker, 1)[1]
    start = user.find("{")
    return json.loads(user[start:]) if start >= 0 else {}


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


# 七轮例子里每句成员的话该抽出什么（一个合格的抽取模型会给的输出）
DECISION_TABLE = {
    "本机整理结果存入 SQLite，每个 Space 一个库文件。": (
        "本机整理结果存入 SQLite，每个 Space 一个库文件。",
        False,
    ),
    "本机整理结果存入单个 SQLite 库，按 space_id 分表。": (
        "本机整理结果存入单个 SQLite 库，按 space_id 分表。",
        False,
    ),
    "同意单库按 space_id 分表。": ("本机整理结果存入单个 SQLite 库，按 space_id 分表。", False),
    "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。": (
        "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。",
        False,
    ),
    "以用户C 的为准。": ("本机整理结果存入单个 SQLite 库，按 space_id 分表。", True),
    "本机整理结果按领域分库，每个领域一个 SQLite 库文件。": (
        "本机整理结果按领域分库，每个领域一个 SQLite 库文件。",
        False,
    ),
}


class RuleLLM:
    """按提示词种类分派。`misbehave=True` 时第二次调用会把非负责人的不同结论错判成 rewrite，
    用来验证代码护栏能改回 conflict。"""

    def __init__(self, misbehave: bool = False):
        self.misbehave = misbehave
        self.calls: list[str] = []

    def generate(self, messages: list[dict[str, str]], **kwargs) -> str:
        system = messages[0]["content"] if messages[0]["role"] == "system" else ""
        user = messages[-1]["content"]
        text = system + user
        if "你是一个判定器" in text:
            self.calls.append("judge")
            return json.dumps(self._judge(user), ensure_ascii=False)
        if "归到项目里的一个主题" in text:
            self.calls.append("topic.assign")
            return json.dumps(self._topic(_user_json(messages)), ensure_ascii=False)
        if "有没有定下要团队照做的选择" in text:
            self.calls.append("dec.extract")
            return json.dumps(self._extract(_user_json(messages)), ensure_ascii=False)
        if "并进项目里已有的决策" in text:
            self.calls.append("dec.update")
            return json.dumps(self._update(_user_json(messages)), ensure_ascii=False)
        if "你在维护团队的经验库" in text:
            self.calls.append("exp.merge")
            return json.dumps(self._merge(user), ensure_ascii=False)
        if "整理成一张卡片" in text:
            self.calls.append("exp.extract")
            return json.dumps(self._exp_extract(user), ensure_ascii=False)
        if "值不值得整理成团队经验" in text:
            self.calls.append("exp.filter")
            ok = "FAIL" in user and "passed" in user
            return json.dumps(
                {
                    "has_exploration": "是" if ok else "否",
                    "has_user_correction": "否",
                    "reason": "测试先失败、改动后通过" if ok else "直线完成",
                },
                ensure_ascii=False,
            )
        raise AssertionError("RuleLLM 不认识这个提示词")

    # —— 段关系 ——
    @staticmethod
    def _judge(user: str) -> dict[str, Any]:
        state = json.loads(user.split("【材料】", 1)[1].split("【题目】", 1)[0])
        turn = state.get("turn") or []
        reply = " ".join(r["text"] for r in turn if r["role"] == "agent")
        done = any(k in reply for k in ("已按", "已记下", "好的，按", "已完成", "已提交"))
        return {"answers": {"turn_relation": {"choice": "end_topic" if done else "follow_up"}}}

    @staticmethod
    def _topic(inp: dict[str, Any]) -> dict[str, Any]:
        topics = inp.get("topics") or []
        if topics:
            return {
                "skip": False,
                "topic_id": topics[0]["id"],
                "new_topic": None,
                "summary": None,
                "description": None,
                "timeline": [],
            }
        dom = (inp.get("domains") or [{"name": ""}])[0]["name"]
        return {
            "skip": False,
            "topic_id": None,
            "new_topic": {
                "name": "项目记忆接口开发",
                "domain": dom,
                "summary": "为 MemOS 云服务实现项目记忆的写入、整理与检索接口。",
                "description": "本机整理结果的存储方式有几种结论；写入链路按 episode 整理。",
            },
            "summary": None,
            "description": None,
            "timeline": [],
        }

    @staticmethod
    def _extract(inp: dict[str, Any]) -> dict[str, Any]:
        out = []
        agent_before: list[str] = []
        for m in inp["episode"]:
            if m["role"] == "agent":
                agent_before.append(m["text"])
                continue
            hit = DECISION_TABLE.get(m["text"])
            if not hit:
                continue
            content, final = hit
            listed: list[str] = []
            if final:
                for line in "\n".join(agent_before).split("\n"):
                    mm = re.match(r"\d+\.\s*(.+?)（", line)
                    if mm:
                        listed.append(mm.group(1))
            out.append(
                {
                    "message_id": m["id"],
                    "quote": m["text"],
                    "content": content,
                    "category": "共同约定",
                    "change_reason": None,
                    "sure": True,
                    "final": final,
                    "approved_by": [],
                    "listed": listed,
                }
            )
        return {"has_decision": bool(out), "decisions": out}

    def _update(self, inp: dict[str, Any]) -> dict[str, Any]:
        results = []
        for n in inp["new"]:
            dec = next(
                (d for d in inp["decisions"] if "本机整理结果" in d["items"][0]["text"]), None
            )
            if dec is None:
                results.append(
                    {
                        "n": n["n"],
                        "decision_id": None,
                        "same_as": None,
                        "reason": "新的事",
                        "action": "add",
                        "informed": {},
                        "result": {"current": n["content"], "history": []},
                    }
                )
                continue
            items = dec["items"]
            same = next(
                (it["item"] for it in items if _norm(it["text"]) == _norm(n["content"])), None
            )
            cur = items[0]
            has_conflicts = len(items) > 1
            informed = {}
            for it in items:
                hit = next((x for x in n["listed"] if _norm(x) in _norm(it["text"])), None)
                if hit:
                    informed[it["item"]] = hit
            covers = len(informed) == len(items)
            if has_conflicts and n["final"] and same and covers:
                action = "resolve"
            elif same is None and n["name"] in cur["members"]:
                action = "rewrite"
            elif same is not None:
                action = "join"
            else:
                action = "rewrite" if self.misbehave else "conflict"
            results.append(
                {
                    "n": n["n"],
                    "decision_id": dec["id"],
                    "same_as": same,
                    "reason": f"规则：{action}",
                    "action": action,
                    "informed": informed if action == "resolve" else {},
                    "result": {"current": cur["text"], "history": []},
                }
            )
        return {"results": results}

    # —— 经验 ——
    @staticmethod
    def _exp_extract(user: str) -> dict[str, Any]:
        if "FAIL" not in user:
            return {
                "has_exploration": "否",
                "has_user_correction": "否",
                "reason": "",
                "quality_score": None,
                "card": None,
            }
        version = "版本校验" in user
        card = {
            "task_intent": "实现或修改会读取、整理并写回同一批数据的异步任务",
            "problem": "两轮消息几乎同时提交时，后写回的整理结果覆盖先写回的",
            "technical_context": "写回带版本校验时可以并行"
            if version
            else "同一 Space 内的异步整理任务并行执行时",
            "failed_shape": "多个整理任务并行写回，不做任何协调",
            "principle": "写回带版本校验，校验失败就重读重算"
            if version
            else "同一 Space 内按数据范围串行执行整理任务",
            "validation": "pnpm vitest run test/pipeline.concurrency.test.ts，12 passed",
            "anchors": ["src/project/queue.ts", "test/pipeline.concurrency.test.ts"],
            "status": "verified",
            "signal": "test",
        }
        return {
            "has_exploration": "是",
            "has_user_correction": "否",
            "reason": "测试先失败后通过",
            "quality_score": 0.85,
            "card": card,
        }

    @staticmethod
    def _merge(user: str) -> dict[str, Any]:
        new = json.loads(user.split("## 新卡片", 1)[1].split("## 召回的已有卡片", 1)[0])
        olds = json.loads(user.split("## 召回的已有卡片", 1)[1].split("## 输出", 1)[0])
        target = olds[0] if olds else None
        if target is None:
            return {"action": "add", "target_id": None, "card": None, "reason": "没有同一件事"}
        if "版本校验" in (new.get("principle") or "") and "版本校验" not in (
            target.get("principle") or ""
        ):
            card = {
                k: target.get(k)
                for k in ("task_intent", "problem", "failed_shape", "validation", "anchors")
            }
            card["technical_context"] = (
                "同一 Space 内的异步整理任务并行执行时；写回带版本校验时不需要串行"
            )
            card["principle"] = (
                f"1. {target['principle']}；2. 需要并行时写回带版本校验，校验失败就重读重算"
            )
            return {
                "action": "update",
                "target_id": target["id"],
                "card": card,
                "reason": "带来了新条件与可行做法",
            }
        return {
            "action": "confirm",
            "target_id": target["id"],
            "card": None,
            "reason": "同一件事，没有新信息",
        }


# ═════════════════════════════ mock add 样例 ════════════════════════════════
# 决策：T1 的七轮（每位成员在自己的会话里）；经验：三段（B 新建 → D 再次确认 → E 补版本校验）


def _u(text: str, t: str, uid: str, name: str, mid: str) -> dict[str, Any]:
    return {
        "role": "user",
        "content": text,
        "chat_time": t,
        "role_id": uid,
        "role_name": name,
        "message_id": mid,
    }


def _a(
    text: str, t: str, mid: str, tool_calls: list | None = None, notes: list | None = None
) -> dict[str, Any]:
    m: dict[str, Any] = {"role": "assistant", "content": text, "chat_time": t, "message_id": mid}
    if tool_calls:
        m["tool_calls"] = tool_calls
    if notes:
        m["experience_notes"] = notes
    return m


def _call(cid: str, name: str, args: str) -> dict[str, Any]:
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": args}}


def _tool(cid: str, out: str, t: str) -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": cid, "content": out, "chat_time": t}


DECISION_ROUNDS: list[dict[str, Any]] = [
    {
        "label": "第 1 轮 · 用户B 新增",
        "user_id": "user_b",
        "conversation_id": "claude-code:b-1029",
        "messages": [
            _u(
                "本机整理结果存入 SQLite，每个 Space 一个库文件。",
                "2026-10-29T10:20:00+08:00",
                "user_b",
                "用户B",
                "b-u-1",
            ),
            _a(
                "已按每个 Space 一个 SQLite 库文件实现存储层。",
                "2026-10-29T10:21:00+08:00",
                "b-a-1",
            ),
        ],
    },
    {
        "label": "第 2 轮 · 用户C 不同结论",
        "user_id": "user_c",
        "conversation_id": "codex:c-1030",
        "messages": [
            _u(
                "本机整理结果存入单个 SQLite 库，按 space_id 分表。",
                "2026-10-30T14:05:00+08:00",
                "user_c",
                "用户C",
                "c-u-1",
            ),
            _a(
                "已记下。这与项目里现有的结论不同：现在记录的是每个 Space 一个库文件（用户B）。",
                "2026-10-30T14:06:00+08:00",
                "c-a-1",
            ),
        ],
    },
    {
        "label": "第 3 轮 · 用户D 同意分表",
        "user_id": "user_d",
        "conversation_id": "cursor:d-1030",
        "messages": [
            _u(
                "同意单库按 space_id 分表。",
                "2026-10-30T14:40:00+08:00",
                "user_d",
                "用户D",
                "d-u-1",
            ),
            _a("已记下你同意单库按 space_id 分表。", "2026-10-30T14:41:00+08:00", "d-a-1"),
        ],
    },
    {
        "label": "第 4 轮 · 用户E 另一种",
        "user_id": "user_e",
        "conversation_id": "claude-code:e-1030",
        "messages": [
            _u(
                "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。",
                "2026-10-30T15:30:00+08:00",
                "user_e",
                "用户E",
                "e-u-1",
            ),
            _a("已记下，这与现有两项结论都不同。", "2026-10-30T15:31:00+08:00", "e-a-1"),
        ],
    },
    {
        "label": "第 5–6 轮 · Agent 列出三项，用户B 定案",
        "user_id": "user_b",
        "conversation_id": "claude-code:b-1031",
        "messages": [
            _u(
                "本机整理结果的存储层下一步怎么实现？",
                "2026-10-31T10:00:00+08:00",
                "user_b",
                "用户B",
                "b-u-2",
            ),
            _a(
                "本机整理结果的存储方式目前有三种结论，还没有定下来：\n1. 每个 Space 一个库文件（用户B，10/29）\n"
                "2. 单个 SQLite 库，按 space_id 分表（用户C、用户D，10/30）\n3. 改用 LanceDB 统一存储，不再使用 SQLite（用户E，10/30）\n"
                "请确认以哪一项为准，我再继续实现存储层。",
                "2026-10-31T10:01:00+08:00",
                "b-a-2",
            ),
            _u("以用户C 的为准。", "2026-10-31T10:02:00+08:00", "user_b", "用户B", "b-u-3"),
            _a(
                "好的，按单个 SQLite 库、按 space_id 分表继续实现存储层。",
                "2026-10-31T10:03:00+08:00",
                "b-a-3",
            ),
        ],
    },
    {
        "label": "第 7 轮 · 拍板之后用户A 又提第三种",
        "user_id": "user_a",
        "conversation_id": "workbuddy:a-1103",
        "messages": [
            _u(
                "本机整理结果按领域分库，每个领域一个 SQLite 库文件。",
                "2026-11-03T09:30:00+08:00",
                "user_a",
                "用户A",
                "a-u-1",
            ),
            _a("已记下，这与单库分表的结论不同。", "2026-11-03T09:31:00+08:00", "a-a-1"),
        ],
    },
]


def _exp_round(
    uid: str, name: str, conv: str, day: str, ask: str, fix: str, extra: str, done: str
) -> dict[str, Any]:
    p = conv.split(":")[-1]
    return {
        "label": f"经验 · {name}",
        "user_id": uid,
        "conversation_id": conv,
        "messages": [
            _u(ask, f"{day}T16:00:00+08:00", uid, name, f"{p}-u-1"),
            _a(
                "",
                f"{day}T16:05:00+08:00",
                f"{p}-a-1",
                [_call(f"{p}-c1", "Bash", "pnpm vitest run test/pipeline.concurrency.test.ts")],
            ),
            _tool(
                f"{p}-c1",
                " FAIL  test/pipeline.concurrency.test.ts > 两轮几乎同时提交时两轮都保留\nAssertionError: expected 12 entries, got 11\n Tests  1 failed | 11 passed (12)",
                f"{day}T16:05:30+08:00",
            ),
            _a(
                "",
                f"{day}T16:10:00+08:00",
                f"{p}-a-2",
                [_call(f"{p}-c2", "Edit", "src/project/queue.ts")],
            ),
            _tool(f"{p}-c2", fix, f"{day}T16:10:10+08:00"),
            _a(
                "",
                f"{day}T16:15:00+08:00",
                f"{p}-a-3",
                [_call(f"{p}-c3", "Bash", "pnpm vitest run test/pipeline.concurrency.test.ts")],
            ),
            _tool(
                f"{p}-c3",
                f" ✓ test/pipeline.concurrency.test.ts (12 tests)\n Tests  12 passed (12){extra}",
                f"{day}T16:15:30+08:00",
            ),
            _a(done, f"{day}T16:20:00+08:00", f"{p}-a-4"),
        ],
    }


EXPERIENCE_ROUNDS: list[dict[str, Any]] = [
    _exp_round(
        "user_b",
        "用户B",
        "claude-code:b-exp",
        "2026-10-30",
        "实现 add/message 的项目记忆写入，按 PRD 执行。",
        "ok",
        "",
        "已完成，已提交 PR #412。两轮几乎同时提交时后写回的覆盖了先写回的；改为同一 Space 内串行执行后不再出现。",
    ),
    _exp_round(
        "user_d",
        "用户D",
        "codex:d-exp",
        "2026-10-31",
        "知识库导入也要写回整理结果，照现有做法实现。",
        "ok",
        "",
        "已完成，已提交。知识库导入按数据范围串行写回后测试通过。",
    ),
    _exp_round(
        "user_e",
        "用户E",
        "cursor:e-exp",
        "2026-11-02",
        "整理任务太慢了，看看能不能并行写回。",
        "ok（加了版本校验）",
        "\n写回带版本校验",
        "已完成，已提交。写回加版本校验后并行执行，测试通过。",
    ),
]


# ═════════════════════════════ HTTP 端到端装配 ══════════════════════════════


class QueueScheduler:
    """替代真调度器的「投递」：submit 只入队，drain 时交给核心的 ProjectMemoryMessageHandler，
    和线上 dispatcher 一样按 label 取处理器、按 (user_id, mem_cube_id) 分组。"""

    def __init__(self) -> None:
        self.queue: list[Any] = []

    def submit_messages(self, items: list[Any]) -> None:
        self.queue.extend(items)

    def drain(self) -> int:
        from unittest.mock import Mock

        from memos.mem_scheduler.task_schedule_modules.handlers.project_memory_handler import (
            PROJECT_MEMORY_TASK_LABEL,
            ProjectMemoryMessageHandler,
        )

        handler = ProjectMemoryMessageHandler(Mock())
        n = 0
        while self.queue:
            batch, self.queue = self.queue, []
            items = [m for m in batch if m.label == PROJECT_MEMORY_TASK_LABEL]
            n += len(items)
            handler(items)
        return n


_PG_TEST_STORES: list[Any] = []


def storage_kinds() -> list[str]:
    """用例要跑的存储：内存版、SQLite；设了 PG_TEST_DSN 时再加项目记忆自己的 Postgres。"""
    import os

    return ["fake", "sqlite"] + (["postgres"] if os.getenv("PG_TEST_DSN") else [])


def make_test_db(kind: str, path: Any) -> Any:
    """按种类建一个空库：fake / sqlite（放在 path 下）/ postgres（每次一个新 schema，用完删）。"""
    import os
    import uuid

    from pathlib import Path

    if kind == "fake":
        return FakeGraphDB()
    if kind == "sqlite":
        from memos.configs.graph_db import GraphDBConfigFactory
        from memos.graph_dbs.factory import GraphStoreFactory

        Path(path).mkdir(parents=True, exist_ok=True)
        return GraphStoreFactory.from_config(
            GraphDBConfigFactory.model_validate(
                {
                    "backend": "sqlite",
                    "config": {
                        "db_path": str(Path(path) / "pm.db"),
                        "embedding_dimension": FakeEmbedder.dim,
                    },
                }
            )
        )
    if kind == "postgres":
        from .pg_backend import ProjectPostgresStore

        db = ProjectPostgresStore(
            {
                "dsn": os.environ["PG_TEST_DSN"],
                "schema_name": f"pmtest_{uuid.uuid4().hex[:12]}",
                "embedding_dimension": FakeEmbedder.dim,
            }
        )
        _PG_TEST_STORES.append(db)
        return db
    raise ValueError(kind)


def drop_test_dbs() -> None:
    """删掉用例建的 Postgres schema。"""
    while _PG_TEST_STORES:
        db = _PG_TEST_STORES.pop()
        try:
            db.drop_schema()
        finally:
            db.close()


def reset_project_hooks() -> None:
    """单实现钩子全局只能有一个回调：重复装配前先清掉。"""
    from memos.plugins.hook_defs import H
    from memos.plugins.hooks import _hooks

    for name in [v for k, v in vars(H).items() if k.startswith("PROJECT_MEMORY_")]:
        _hooks.pop(name, None)
    # Also clear the add/search intercept/after hooks registered by the plugin.
    for name in ("add.intercept", "add.after", "search.intercept", "search.after"):
        _hooks.pop(name, None)


def build_http_app(
    llm: Any | None = None, graph_db: Any | None = None, embedder: Any | None = None
):
    """装一个只含核心 `/product` 路由 + 项目记忆插件的 FastAPI 应用。

    核心的 add / search / get_memory / delete_memory / scheduler/status 走真实代码；
    其余组件（文本记忆、mem_reader…）用 Mock，与 tests/api/test_server_router.py 同样做法。
    返回 (TestClient, QueueScheduler, plugin)。
    """
    import importlib
    import sys

    from unittest.mock import Mock, patch

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from .plugin import CommunityProjectMemoryPlugin

    llm = llm or RuleLLM()
    graph_db = graph_db or FakeGraphDB()
    embedder = embedder or FakeEmbedder()
    sched = QueueScheduler()
    components = {
        "graph_db": graph_db,
        "mem_reader": Mock(),
        "llm": llm,
        "embedder": embedder,
        "reranker": Mock(),
        "internet_retriever": Mock(),
        "memory_manager": Mock(),
        "default_cube_config": Mock(),
        "mos_server": Mock(),
        "mem_scheduler": Mock(),
        "feedback_server": Mock(),
        "naive_mem_cube": Mock(),
        "searcher": Mock(),
        "api_module": Mock(),
        "vector_db": None,
        "pref_extractor": None,
        "pref_adder": None,
        "pref_retriever": None,
        "pref_mem": None,
        "online_bot": None,
        "chat_llms": Mock(),
        "redis_client": None,
        "deepsearch_agent": Mock(),
    }
    with patch("memos.api.handlers.init_server", return_value=components):
        mod = "memos.api.routers.server_router"
        server_router = (
            importlib.reload(sys.modules[mod])
            if mod in sys.modules
            else importlib.import_module(mod)
        )

    app = FastAPI()
    app.include_router(server_router.router)

    reset_project_hooks()
    plugin = CommunityProjectMemoryPlugin()
    plugin.on_load()
    plugin.init_components(
        {
            "shared": {
                "graph_db": graph_db,
                "embedder": embedder,
                "llm": llm,
                # 显式注入项目记忆用的组件：不受仓库根 .env 里 PROJECT_MEMORY_* 的影响
                "project_graph_db": graph_db,
                "project_embedder": embedder,
                "project_llm": llm,
                "project_judge_llm": llm,
                "submit_scheduler_messages": sched.submit_messages,
            }
        }
    )
    plugin._bind_app(app)
    plugin.init_app()
    return TestClient(app), sched, plugin
