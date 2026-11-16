"""项目记忆主干的自测：算法动作、不变式、存储适配。

不连数据库、不调模型。存储两种实现各跑一遍：InMemoryProjectStore 与 GraphProjectStore（配假 graph_db）。
"""

from __future__ import annotations

import json

from typing import Any

import pytest

from memos.project_memory.decision import (
    apply_action,
    decide_action,
    extract_drafts,
    has_decision,
    verify_drafts,
)
from memos.project_memory.mock_data import (
    CONV,
    SPACE,
    decision_final_turns,
    decision_turn7,
    decision_turns,
    experience_segment,
)
from memos.project_memory.mock_script import D1, D2, D3, E1, F5, build_script
from memos.project_memory.pipeline import ProjectMemoryPipeline, render_injection
from memos.project_memory.store import GraphProjectStore, InMemoryProjectStore
from memos.project_memory.types import (
    OP_CONFLICT_APPEND,
    OP_JOIN,
    OP_RESOLVE,
    Decision,
    DecisionAction,
    DecisionDraft,
    Episode,
    InvariantError,
    Source,
)


# ── 假 graph_db：只实现项目记忆用到的那几个方法 ──────────────────────────────


class FakeGraphDB:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}

    def add_node(self, id, memory, metadata, user_name=None):
        props = dict(metadata)
        props.pop("embedding", None)
        props["user_name"] = user_name or props.get("user_name", "")
        self.nodes[id] = {"id": id, "memory": memory, "metadata": props}

    def get_node(self, id, include_embedding=False, **kwargs):
        n = self.nodes.get(id)
        if not n:
            return None
        space = kwargs.get("user_name")
        if space and n["metadata"].get("user_name") != space:
            return None
        return n

    def get_nodes(self, ids, include_embedding=False, **kwargs):
        out = []
        for i in ids:
            n = self.get_node(i, include_embedding, **kwargs)
            if n:
                out.append(n)
        return out

    def delete_node(self, id, **kwargs):
        self.nodes.pop(id, None)

    def get_by_metadata(self, filters, status=None):
        out = []
        for i, n in self.nodes.items():
            m = n["metadata"]
            if status and m.get("status") != status:
                continue
            if all(m.get(k) == v for f in filters for k, v in f.items()):
                out.append(i)
        return out

    def search_by_embedding(self, vector, top_k=5, scope=None, user_name=None, **kwargs):
        return [
            n
            for n in self.nodes.values()
            if (not scope or n["metadata"].get("memory_type") == scope)
            and (not user_name or n["metadata"].get("user_name") == user_name)
        ][:top_k]

    def search_by_fulltext(self, query, top_k=5, scope=None, user_name=None, **kwargs):
        return self.search_by_embedding(None, top_k, scope, user_name)


# ── 存储后端参数化 ─────────────────────────────────────────────────────────


@pytest.fixture(params=["memory", "graph"])
def store(request):
    if request.param == "memory":
        return InMemoryProjectStore()
    return GraphProjectStore(FakeGraphDB())


def _pipe(store):
    return ProjectMemoryPipeline(store, script=build_script())


# ── 端到端：七轮 ───────────────────────────────────────────────────────────


def test_seven_rounds_end_state(store):
    pipe = _pipe(store)
    pipe.ingest(SPACE, CONV, decision_turns())
    pipe.ingest(SPACE, CONV, decision_final_turns())
    pipe.ingest(SPACE, CONV, decision_turn7())

    decs = store.list_decisions(SPACE)
    assert len(decs) == 1, "七轮只应产生一条决策"
    d = decs[0]
    assert d.content == "本机整理结果存入单个 SQLite 库，按 space_id 分表。"
    assert d.time == "2026-10-31T10:02:00+08:00", "当前结论的时间是拍板那条消息的时间"
    assert {"user_c", "user_d", "user_b"}.issubset(set(d.user_ids)), "拍板的成员要进负责人"
    assert len(d.history) == 2, "拍板时落选的两项进历史"
    assert len(d.conflicts) == 1, "第 7 轮晚于拍板，应记成新的不一致结论"
    assert "按领域分库" in d.conflicts[0].content


def test_search_returns_topic_detail_list(store):
    pipe = _pipe(store)
    pipe.ingest(SPACE, CONV, decision_turns())
    pipe.ingest(SPACE, CONV, decision_final_turns())
    pipe.ingest(SPACE, CONV, decision_turn7())
    pipe.ingest(SPACE, CONV, experience_segment())

    got = pipe.search(SPACE, "本机整理结果怎么存？")
    assert got["topic_detail_list"], "至少要召回一个主题"
    topic = got["topic_detail_list"][0]
    for key in ("id", "space_id", "domain", "topic_name", "topic_summary", "topic_description"):
        assert key in topic, f"PRD 的 topic_detail_list 缺 {key}"
    assert topic["decisions"] and topic["experiences"]
    d = topic["decisions"][0]
    assert "conflicts" in d and "history" in d, "决策要带全部不一致结论与历史"

    text = render_injection(got["topic_detail_list"])
    assert "不一致：" in text and "此前：" in text
    assert "user_c" not in text, "注入文本用成员名字，不用 user_id"


def test_experience_card_saved(store):
    pipe = _pipe(store)
    pipe.ingest(SPACE, CONV, experience_segment())
    exps = store.list_experiences(SPACE)
    assert len(exps) == 1
    e = exps[0]
    assert e.form == "principle" and e.status == "candidate"
    assert e.anchors == ["src/project/queue.ts"]
    assert e.sources and e.sources[0]["segment_id"]


# ── 抽取：代码核对 ─────────────────────────────────────────────────────────


def test_verify_drops_quote_not_in_message():
    ep = Episode(id="ep1", space_id=SPACE, conversation_id=CONV, messages=decision_turns()[:1])
    draft = DecisionDraft(
        message_id=ep.members[0].id,
        quote="这句话不在原消息里",
        content="本机整理结果存入 SQLite，每个 Space 一个库文件。",
    )
    kept, dropped = verify_drafts(ep, [draft], CONV)
    assert kept == []
    assert dropped and dropped[0]["reason"].startswith("source_mismatch")


def test_verify_drops_unsure_draft():
    ep = Episode(id="ep1", space_id=SPACE, conversation_id=CONV, messages=decision_turns()[:1])
    draft = DecisionDraft(
        message_id=ep.members[0].id,
        quote="本机整理结果存入 SQLite，每个 Space 一个库文件。",
        content="本机整理结果存入 SQLite，每个 Space 一个库文件。",
        sure=False,
    )
    kept, dropped = verify_drafts(ep, [draft], CONV)
    assert kept == [], "拿不准的不写入"
    assert dropped[0]["draft"] and dropped[0]["quote"], "丢弃清单要留原话，供统计判据"
    assert "拿不准" in dropped[0]["reason"]


def test_listed_must_come_from_agent_before_message():
    """成员说「定了，就用分表」，Agent 之前没列出过结论 → listed 应被清空，不能凭这个拍板。"""
    msgs = [
        decision_turns()[0],  # 第 1 轮：用户B 新增
        decision_final_turns()[0],  # 用户B 提问
        decision_final_turns()[2],  # 用户B「以用户C 的为准」
    ]
    ep = Episode(id="ep1", space_id=SPACE, conversation_id=CONV, messages=msgs)
    draft = DecisionDraft(
        message_id=msgs[2].id,
        quote="以用户C 的为准。",
        content="本机整理结果存入单个 SQLite 库，按 space_id 分表。",
        resolve=True,
        listed=["每个 Space 一个库文件"],
    )
    kept, _ = verify_drafts(ep, [draft], CONV)
    assert kept and kept[0].listed == [], "Agent 没说过，listed 必须清空"


# ── 冲突判定与不变式 ────────────────────────────────────────────────────────


def _decision() -> Decision:
    return Decision(
        id="dec_1",
        space_id=SPACE,
        topic_id="topic_1",
        content="本机整理结果存入 SQLite，每个 Space 一个库文件。",
        time="2026-10-29T10:20:00+08:00",
        user_ids=["user_b"],
        source=Source(CONV, "m1", "每个 Space 一个库文件"),
    )


def test_non_owner_different_conclusion_becomes_conflict():
    d = _decision()
    draft = DecisionDraft(
        message_id="m2",
        quote="按 space_id 分表",
        content="本机整理结果存入单个 SQLite 库，按 space_id 分表。",
        user_id="user_c",
        user_name="用户C",
        chat_time="2026-10-30T14:05:00+08:00",
    )
    a = decide_action(draft, d, CONV, {"same:content": "no"})
    assert a.op == OP_CONFLICT_APPEND, "非负责人给出不同结论：只并列，不覆盖"
    after = apply_action(d, a)
    assert after.content == d.content and len(after.conflicts) == 1


def test_owner_different_conclusion_rewrites():
    d = _decision()
    draft = DecisionDraft(
        message_id="m2",
        quote="改为单库分表",
        content="本机整理结果存入单个 SQLite 库，按 space_id 分表。",
        user_id="user_b",
        user_name="用户B",
        chat_time="2026-10-30T14:05:00+08:00",
    )
    a = decide_action(draft, d, CONV, {"same:content": "no"})
    assert a.op == "rewrite"
    after = apply_action(d, a)
    assert after.content != d.content and len(after.history) == 1


def test_resolve_requires_informed():
    """定案但不知情 → 不拍板，走后三行。"""
    d = _decision()
    d.conflicts = []
    draft = DecisionDraft(
        message_id="m2",
        quote="以用户C 的为准。",
        content="本机整理结果存入单个 SQLite 库，按 space_id 分表。",
        user_id="user_b",
        user_name="用户B",
        chat_time="2026-10-31T10:02:00+08:00",
        resolve=True,
        listed=["每个 Space 一个库文件"],
    )
    a = decide_action(draft, d, CONV, {"same:content": "no"})  # 知情题没给 → 拿不准 → 按不知情
    assert a.op != OP_RESOLVE


def test_one_member_one_item_and_history_is_kept():
    d = _decision()
    d.conflicts = [
        # 用户C 提的另一种说法
        __import__("memos.project_memory.types", fromlist=["ConflictItem"]).ConflictItem(
            seq=1,
            content="本机整理结果存入单个 SQLite 库，按 space_id 分表。",
            time="2026-10-30T14:05:00+08:00",
            user_ids=["user_c"],
            source=Source(CONV, "m2", "按 space_id 分表"),
        )
    ]
    draft = DecisionDraft(
        message_id="m3",
        quote="同意单库按 space_id 分表。",
        content="本机整理结果存入单个 SQLite 库，按 space_id 分表。",
        user_id="user_c",
        user_name="用户C",
        chat_time="2026-10-30T14:40:00+08:00",
    )
    a = decide_action(draft, d, CONV, {"same:content": "no", "same:conflict:1": "yes"})
    assert a.op == OP_JOIN and a.target == "conflict:1"
    after = apply_action(d, a)
    seen = set(after.user_ids) | {u for c in after.conflicts for u in c.user_ids}
    assert len(seen) == len(after.user_ids) + sum(len(c.user_ids) for c in after.conflicts), "一位成员只占一项"


def test_invariant_rejects_empty_owner():
    d = _decision()
    d.user_ids = []
    with pytest.raises(InvariantError):
        d.check()


def test_unknown_op_raises():
    with pytest.raises(ValueError):
        apply_action(_decision(), DecisionAction(op="nope"))


# ── 剧本自检：样例与脚本对得上 ──────────────────────────────────────────────


def test_script_covers_all_episodes():
    pipe = _pipe(InMemoryProjectStore())
    res = pipe.ingest(SPACE, CONV, decision_turns())
    assert len(res.decision_ops) == 4, "第 1–4 轮各出一条动作"
    ops = [o["op"] for o in res.decision_ops]
    assert ops == ["add", "conflict_append", "join", "conflict_append"], ops
