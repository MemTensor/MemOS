"""项目记忆（memory view `project`）的测试。

全部走真实代码路径：核心 `/product` 路由 → 单实现钩子 → 插件服务 → 核心调度处理器
（ProjectMemoryMessageHandler）→ 存储（假 graph_db，接口与语义照开源 Postgres 后端）。
大模型用按规则答题的 RuleLLM：真实拼提示词、真实解析 JSON，输出是构造的、不是实跑。
"""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from memos.project_memory import decision as dec
from memos.project_memory import experience as exp
from memos.project_memory.graph_store import ProjectStore
from memos.project_memory.judge import ModelError, ModelHub
from memos.project_memory.service import ProjectMemoryService, parse_messages
from memos.project_memory.testing import (
    DECISION_ROUNDS,
    EXPERIENCE_ROUNDS,
    FakeEmbedder,
    FakeGraphDB,
    RuleLLM,
    build_http_app,
    make_test_db,
    reset_project_hooks,
    storage_kinds,
)
from memos.project_memory.types import (
    EXP_CANDIDATE,
    EXP_VERIFIED,
    Decision,
    DecisionDraft,
    Episode,
    ExperienceCard,
    InvariantError,
    Msg,
    Source,
    time_key,
)


SPLIT = "本机整理结果存入单个 SQLite 库，按 space_id 分表。"
CAS_KINDS = [k for k in storage_kinds() if k != "fake"]  # 带 rev 条件写的存储


# ── 装配 ───────────────────────────────────────────────────────────────────


@pytest.fixture(params=storage_kinds())
def app(request, tmp_path):
    """同一批用例跑几种存储：内存版、SQLite（FTS5 全文与条件写）；设了 PG_TEST_DSN 时再跑项目记忆自己的 Postgres。"""
    graph_db = make_test_db(request.param, tmp_path / request.param)
    client, sched, plugin = build_http_app(graph_db=graph_db)
    yield client, sched, plugin
    reset_project_hooks()


def _sqlite_db(tmp_path):
    from memos.configs.graph_db import GraphDBConfigFactory
    from memos.graph_dbs.factory import GraphStoreFactory

    return GraphStoreFactory.from_config(
        GraphDBConfigFactory.model_validate(
            {
                "backend": "sqlite",
                "config": {
                    "db_path": str(tmp_path / "pm.db"),
                    "embedding_dimension": FakeEmbedder.dim,
                },
            }
        )
    )


def _space(client, domains=("代码开发", "产品设计")) -> str:
    r = client.post(
        "/product/create_space",
        json={
            "space_name": "MemOS 云服务",
            "instructions": "术语以 PRD 为准",
            "domains": [{"name": d} for d in domains],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["space_id"]


def _add(client, sid, rnd, **extra):
    body = {
        "user_id": rnd["user_id"],
        "conversation_id": rnd["conversation_id"],
        "space_ids": sid,
        "allow_memory_view": ["project"],
        "messages": rnd["messages"],
        **extra,
    }
    return client.post("/product/add", json=body)


def _run_all(client, sched, sid, rounds):
    tasks = []
    for rnd in rounds:
        r = _add(client, sid, rnd)
        assert r.status_code == 200, r.text
        tasks.append((rnd["user_id"], r.json()["data"][0]["task_id"]))
        sched.drain()
    return tasks


def _status(client, user_id, task_id):
    return client.get(
        "/product/scheduler/status", params={"user_id": user_id, "task_id": task_id}
    ).json()["data"][0]


# ── Space 与领域 ────────────────────────────────────────────────────────────


def test_space_and_domain_crud(app):
    client, _, _ = app
    sid = _space(client)
    got = client.post("/product/get_space", json={"space_id": sid}).json()["data"]
    assert got["space_name"] == "MemOS 云服务" and got["instructions"] == "术语以 PRD 为准"

    client.post("/product/update_space", json={"space_id": sid, "instructions": "新的项目指令"})
    assert (
        client.post("/product/get_space", json={"space_id": sid}).json()["data"]["instructions"]
        == "新的项目指令"
    )

    r = client.post(
        "/product/create_domains", json={"space_id": sid, "domains": [{"name": "运营物料"}]}
    )
    assert [d["name"] for d in r.json()["data"]["domains"]] == ["代码开发", "产品设计", "运营物料"]
    # 已有的同名领域跳过、保留原说明，其余照常创建（PRD）
    before = {d["name"]: d["description"] for d in r.json()["data"]["domains"]}
    r = client.post(
        "/product/create_domains",
        json={
            "space_id": sid,
            "domains": [{"name": "测试"}, {"name": "代码开发", "description": "新说明"}],
        },
    )
    assert r.status_code == 200
    after = {d["name"]: d["description"] for d in r.json()["data"]["domains"]}
    assert list(after) == ["代码开发", "产品设计", "运营物料", "测试"]
    assert after["代码开发"] == before["代码开发"]

    # 同一批里重名的整批失败（PRD 共同规则），三个批量接口都一样
    for path, doms in (
        ("/product/create_domains", [{"name": "甲"}, {"name": "甲"}]),
        ("/product/update_domains", [{"name": "测试"}, {"name": "测试", "new_name": "乙"}]),
        ("/product/delete_domains", ["测试", "测试"]),
    ):
        r = client.post(path, json={"space_id": sid, "domains": doms})
        assert r.status_code == 400 and r.json()["reason"] == "DOMAIN_DUPLICATE", path
    r = client.post(
        "/product/create_space",
        json={"space_name": "x", "domains": [{"name": "甲"}, {"name": "甲"}]},
    )
    assert r.status_code == 400 and r.json()["reason"] == "DOMAIN_DUPLICATE"
    assert [
        d["name"]
        for d in client.post("/product/list_domains", json={"space_id": sid}).json()["data"][
            "domains"
        ]
    ] == ["代码开发", "产品设计", "运营物料", "测试"]

    # 已不存在的名称忽略（PRD）
    r = client.post(
        "/product/delete_domains",
        json={"space_id": sid, "domains": ["运营物料", "测试", "没有这个"]},
    )
    assert r.status_code == 200 and len(r.json()["data"]["domains"]) == 2

    assert client.post("/product/get_space", json={"space_id": "nope"}).status_code == 404


def test_write_requires_space_and_domains(app):
    client, _, _ = app
    rnd = DECISION_ROUNDS[0]
    assert _add(client, "no-such-space", rnd).status_code == 404  # Space 不存在
    empty = _space(client, domains=())
    r = _add(client, empty, rnd)
    assert r.status_code == 400 and "未配置领域" in r.text
    sid = _space(client)
    r = _add(client, sid, rnd, domains="不存在的领域")
    assert r.status_code == 400 and "领域未登记" in r.text
    # project 时 space_ids 必填（字段校验）
    r = client.post(
        "/product/add",
        json={"user_id": "u", "allow_memory_view": ["project"], "messages": rnd["messages"]},
    )
    assert r.status_code == 422


def test_project_view_disabled_returns_400(app):
    client, _, _ = app
    sid = _space(client)
    reset_project_hooks()
    r = _add(client, sid, DECISION_ROUNDS[0])
    assert r.status_code == 400 and "not enabled" in r.text


# ── 写入链路：add → 调度 → 整理 → get/status ──────────────────────────────────


def test_add_returns_task_and_status_reports_topics(app):
    client, sched, _ = app
    sid = _space(client)
    r = _add(client, sid, DECISION_ROUNDS[0])
    data = r.json()["data"][0]
    assert data["success"] and data["status"] == "running" and data["memory_view"] == "project"
    assert _status(client, "user_b", data["task_id"])["status"] == "in_progress"

    assert sched.drain() == 1  # 一个 Space 一条消息
    st = _status(client, "user_b", data["task_id"])
    assert st["status"] == "completed"
    assert len(st["memory_views"]["project"]["memory_ids"]) == 1


def test_seven_rounds_final_state(app):
    client, sched, plugin = app
    sid = _space(client)
    _run_all(client, sched, sid, DECISION_ROUNDS)

    decisions = plugin.service.store.list_decisions(sid)
    assert len(decisions) == 1, "七轮只应有一条决策"
    d = decisions[0]
    assert d.content == SPLIT
    assert d.time == "2026-10-31T10:02:00+08:00", "当前结论的时间是拍板那条消息的时间"
    assert {"user_c", "user_d", "user_b"} == set(d.user_ids)
    assert [h.content for h in d.history] == [
        "本机整理结果存入 SQLite，每个 Space 一个库文件。",
        "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。",
    ]
    assert all(h.change_source.quote == "以用户C 的为准。" for h in d.history)
    assert [c.content for c in d.conflicts] == [
        "本机整理结果按领域分库，每个领域一个 SQLite 库文件。"
    ], "第 7 轮晚于拍板，记成新的不一致结论"


def test_search_get_and_delete(app):
    client, sched, _ = app
    sid = _space(client)
    _run_all(client, sched, sid, DECISION_ROUNDS + EXPERIENCE_ROUNDS)

    body = {
        "user_id": "user_x",
        "query": "本机整理结果怎么存？",
        "space_ids": [sid],
        "include_memory_view": ["project"],
        "memory_limit_number": 3,
        "relativity": 0,  # 替身向量的分数偏低，这里只看结构；门槛另有用例
    }
    data = client.post("/product/search", json=body).json()["data"]
    assert list(data) == ["topic_detail_list"], "只要 project 时不走个人记忆"
    topic = data["topic_detail_list"][0]
    for k in (
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
        "update_time",
    ):
        assert k in topic
    assert "sources" not in topic, "search 不返回来源会话"
    d = topic["decisions"][0]
    assert d["conflicts"] and d["history"] and "source" not in d

    full = client.post("/product/get_memory", json={"space_id": sid}).json()["data"]
    t = full["topic_detail_list"][0]
    assert t["sources"] and t["create_time"] and t["decisions"][0]["source"]["quote"]
    one = client.get(f"/product/get_memory/{t['id']}").json()["data"]["topic_detail_list"][0]
    assert one["id"] == t["id"]

    mine = client.post(
        "/product/get_memory", json={"space_id": sid, "filter": {"related_id": "user_a"}}
    ).json()["data"]
    assert mine["total"] == 1
    none = client.post(
        "/product/get_memory", json={"space_id": sid, "filter": {"related_id": "nobody"}}
    ).json()["data"]
    assert none["total"] == 0

    msgs = client.post(
        "/product/get_message", json={"conversation_id": "claude-code:b-1031"}
    ).json()["data"]
    assert [m["role"] for m in msgs["message_detail_list"]] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]

    r = client.post("/product/delete_memory", json={"space_id": sid})
    assert r.status_code == 200 and len(r.json()["data"]["deleted_topic_ids"]) == 1
    assert client.post("/product/get_memory", json={"space_id": sid}).json()["data"]["total"] == 0
    assert client.post("/product/list_domains", json={"space_id": sid}).json()["data"]["domains"], (
        "清空主题保留领域"
    )


def test_delete_space(app):
    client, sched, plugin = app
    sid = _space(client)
    _run_all(client, sched, sid, DECISION_ROUNDS[:1])
    assert client.post("/product/delete_space", json={"space_id": sid}).status_code == 200
    assert client.post("/product/get_space", json={"space_id": sid}).status_code == 404
    assert plugin.service.store.list_decisions(sid) == []


# ── 段切分：由模型判，判「接着做」就不关段 ─────────────────────────────────────


def test_follow_up_keeps_episode_open(app):
    client, sched, _ = app
    sid = _space(client)
    rnd = DECISION_ROUNDS[4]  # 第 5–6 轮；只交第 5 轮：Agent 在列选项、还没结束
    first = {**rnd, "messages": rnd["messages"][:2]}
    task = _add(client, sid, first).json()["data"][0]["task_id"]
    sched.drain()
    st = _status(client, "user_b", task)
    assert st["status"] == "completed"
    assert st["memory_views"]["project"]["memory_ids"] == [], "段还开着，没有整理"
    assert st["memory_views"]["project"]["open_episode_messages"] == 2

    second = {**rnd, "messages": rnd["messages"][2:]}
    task2 = _add(client, sid, second).json()["data"][0]["task_id"]
    sched.drain()
    assert _status(client, "user_b", task2)["memory_views"]["project"]["memory_ids"], (
        "这一轮结束了这件事：关段整理"
    )


def test_flush_records_topics_on_the_task(app):
    """会话结束调 flush：段立即关掉并整理，结果记到这个 add 的任务上（get/status 看得到）。"""
    client, sched, plugin = app
    sid = _space(client)
    rnd = DECISION_ROUNDS[4]  # 第 5 轮：Agent 在列选项，段还开着
    first = {**rnd, "messages": rnd["messages"][:2]}
    task = _add(client, sid, first).json()["data"][0]["task_id"]
    sched.drain()
    assert _status(client, "user_b", task)["memory_views"]["project"]["memory_ids"] == []

    out = plugin.service.flush(sid, rnd["conversation_id"], task_id=task)
    assert out.topic_ids, "flush 会把开着的段关掉并整理"
    st = _status(client, "user_b", task)
    assert st["memory_views"]["project"]["memory_ids"] == out.topic_ids


def test_resubmitted_messages_are_deduplicated(app):
    client, sched, plugin = app
    sid = _space(client)
    _run_all(client, sched, sid, DECISION_ROUNDS[:1] + DECISION_ROUNDS[:1])
    msgs = plugin.service.store.list_messages(sid, DECISION_ROUNDS[0]["conversation_id"])
    assert len(msgs) == 2
    assert len(plugin.service.store.list_decisions(sid)) == 1


# ── 决策：代码护栏与核对 ─────────────────────────────────────────────────────


def test_guard_turns_model_rewrite_into_conflict(tmp_path):
    graph_db = _sqlite_db(tmp_path)
    client, sched, plugin = build_http_app(llm=RuleLLM(misbehave=True), graph_db=graph_db)
    try:
        sid = _space(client)
        _run_all(client, sched, sid, DECISION_ROUNDS[:2])
        d = plugin.service.store.list_decisions(sid)[0]
        assert d.content == "本机整理结果存入 SQLite，每个 Space 一个库文件。", "非负责人不能改写"
        assert [c.content for c in d.conflicts] == [SPLIT]
        assert any("代码改为 conflict" in line for line in plugin.service.last_trace)
    finally:
        reset_project_hooks()


def _episode(msgs: list[Msg]) -> Episode:
    return Episode(id="ep", space_id="s", conversation_id="c", messages=msgs)


def test_approved_by_must_be_nameable_in_the_message():
    """「已和用户B 确认」必须能在原话里落到那个名字上，否则不能凭它改写别人的结论。"""
    m = Msg("m1", "member", "改为单库分表。", "2026-10-30T10:00:00+08:00", "user_c", "用户C")
    ep = _episode([m])
    fake = DecisionDraft("m1", "改为单库分表。", "单库分表", approved_by=["用户B"])
    kept, _ = dec.verify(ep, [fake], ["用户B", "用户C"])
    assert kept[0].approved_by == [], "原话里没提用户B"
    real = DecisionDraft("m1", "改为单库分表。", "单库分表", approved_by=["用户B"])
    m.text = "已和用户B 确认，改为单库分表。"
    real.quote = m.text
    kept, _ = dec.verify(ep, [real], ["用户B", "用户C"])
    assert kept[0].approved_by == ["用户B"]


def test_verify_drops_quote_mismatch_and_strips_unlisted():
    m1 = Msg("m1", "member", "以用户C 的为准。", "2026-10-31T10:02:00+08:00", "user_b", "用户B")
    ep = _episode([m1])
    bad = DecisionDraft("m1", "这句话不在原文里", SPLIT, sure=True)
    good = DecisionDraft(
        "m1", "以用户C 的为准。", SPLIT, sure=True, final=True, listed=["每个 Space 一个库文件"]
    )
    kept, dropped = dec.verify(ep, [bad, good], ["用户B"])
    assert len(kept) == 1 and "source_mismatch" in dropped[0]["reason"]
    assert kept[0].listed == [], "Agent 之前没说过，listed 必须清掉——否则会误拍板"
    assert kept[0].user_id == "user_b" and kept[0].time == "2026-10-31T10:02:00+08:00"


def _decision() -> Decision:
    return Decision(
        id="d1",
        space_id="s",
        topic_id="t",
        content="A 方案",
        time="2026-10-29T10:00:00+08:00",
        user_ids=["user_b"],
        source=Source("c", "m0", "A 方案"),
        user_labels={"user_b": "用户B"},
    )


def test_decide_owner_rewrites_non_owner_conflicts_old_message_cannot_rewrite():
    d = _decision()
    owner = DecisionDraft(
        "m1", "q", "B 方案", user_id="user_b", name="用户B", time="2026-10-30T10:00:00+08:00"
    )
    other = DecisionDraft(
        "m2", "q", "B 方案", user_id="user_c", name="用户C", time="2026-10-30T10:00:00+08:00"
    )
    old = DecisionDraft(
        "m3", "q", "B 方案", user_id="user_b", name="用户B", time="2026-10-28T10:00:00+08:00"
    )
    row = {"decision_id": "d1", "same_as": None, "action": "rewrite"}
    assert dec.decide(owner, row, {"d1": d}).action == "rewrite"
    assert dec.decide(other, row, {"d1": d}).action == "conflict"
    p = dec.decide(old, row, {"d1": d})
    assert p.action == "conflict" and p.guarded, "早于当前结论的话不能改写"


def test_complete_decision_update_requires_explicit_option_comparison():
    target = _decision()
    draft = DecisionDraft("m", "q", target.content, user_id="user_b")
    row = {"n": 1, "decision_id": target.id, "action": "join"}
    hub = Mock()
    hub.write.return_value = {"results": [row]}

    with pytest.raises(ModelError, match="same_as"):
        dec.update(hub, [draft], [target], "Topic", require_complete=True)

    row["same_as"] = None
    assert dec.update(hub, [draft], [target], "Topic", require_complete=True) == [row]
    row["same_as"] = "current"
    assert dec.update(hub, [draft], [target], "Topic", require_complete=True) == [row]


def test_resolve_needs_informed_on_every_item():
    d = _decision()
    d.conflicts = [dec.ConflictItem(1, "B 方案", "2026-10-30T10:00:00+08:00", ["user_c"], Source())]
    draft = DecisionDraft(
        "m",
        "q",
        "B 方案",
        final=True,
        listed=["A 方案"],
        user_id="user_b",
        name="用户B",
        time="2026-10-31T10:00:00+08:00",
    )
    partial = {
        "decision_id": "d1",
        "same_as": "c1",
        "action": "resolve",
        "informed": {"current": "A 方案"},
    }
    assert dec.decide(draft, partial, {"d1": d}).action == "join", "没把各项都说给他听，不拍板"
    repeated = {**partial, "informed": {"current": "A 方案", "c1": "A 方案"}}
    assert dec.decide(draft, repeated, {"d1": d}).action == "join"
    draft.listed = ["A 方案", "A  方案"]
    repeated = {**partial, "informed": {"current": "A 方案", "c1": "A  方案"}}
    assert dec.decide(draft, repeated, {"d1": d}).action == "join"
    malformed = {**partial, "informed": ["current", "c1"]}
    assert dec.decide(draft, malformed, {"d1": d}).action == "join"
    draft.listed = ["A 方案", "B 方案"]
    full = {**partial, "informed": {"current": "A 方案", "c1": "B 方案"}}
    plan = dec.decide(draft, full, {"d1": d})
    assert plan.action == "resolve"
    after, plan = dec.apply(d, plan, draft, "c")
    assert (
        after.content == "B 方案"
        and after.conflicts == []
        and [h.content for h in after.history] == ["A 方案"]
    )
    assert set(after.user_ids) == {"user_c", "user_b"}


def test_member_switching_item_moves_emptied_conflict_to_history():
    d = _decision()
    d.conflicts = [dec.ConflictItem(1, "B 方案", "t1", ["user_c"], Source())]
    draft = DecisionDraft(
        "m", "q", "A 方案", user_id="user_c", name="用户C", time="2026-10-31T10:00:00+08:00"
    )
    plan = dec.decide(
        draft, {"decision_id": "d1", "same_as": "current", "action": "join"}, {"d1": d}
    )
    after, plan = dec.apply(d, plan, draft, "c")
    assert after.conflicts == [] and after.history[0].content == "B 方案", (
        "被移空的不一致结论进历史，不凭空消失"
    )
    assert set(after.user_ids) == {"user_b", "user_c"}


def test_owner_switching_merges_into_that_item():
    """负责人是当前结论唯一的人，却改去支持某一项不一致结论：并入那一项，原结论进历史。"""
    d = _decision()
    d.user_ids = ["user_b"]
    d.conflicts = [dec.ConflictItem(1, "B 方案", "2026-10-30T10:00:00+08:00", ["user_c"], Source())]
    draft = DecisionDraft(
        "m", "q", "B 方案", user_id="user_b", name="用户B", time="2026-10-31T10:00:00+08:00"
    )
    plan = dec.decide(draft, {"decision_id": "d1", "same_as": "c1", "action": "join"}, {"d1": d})
    assert plan.action == "join"
    after, plan = dec.apply(d, plan, draft, "c")
    assert after.content == "B 方案" and after.conflicts == []
    assert set(after.user_ids) == {"user_b", "user_c"}
    assert after.history[0].content == "A 方案"


def test_invariant_owner_not_empty():
    d = _decision()
    d.user_ids = []
    with pytest.raises(InvariantError):
        d.check()


# ── 经验 ───────────────────────────────────────────────────────────────────


def test_experience_confidence_follows_confirm_and_update(app):
    client, sched, plugin = app
    sid = _space(client)
    _run_all(client, sched, sid, EXPERIENCE_ROUNDS)
    exps = plugin.service.store.list_experiences(sid)
    assert len(exps) == 1
    k = exps[0]
    assert k.confidence == pytest.approx(0.65), "新建 0.5 → 再次确认 +0.05 → 补充 +0.10"
    assert k.version == 2 and k.exp_status == EXP_VERIFIED
    # 证实、更新、反驳都把成员补进 user_ids，time 取最近一次（PRD）
    assert set(k.author_ids) == {"user_b", "user_d", "user_e"}
    assert k.time == max((s["chat_time"] for s in k.sources), key=time_key)
    assert len(k.sources) == 3 and len(k.history) == 1
    archived = plugin.service.store.list_experiences(sid, include_archived=True)
    assert len(archived) == 2, "旧版本另存为 archived 节点"


def test_experience_guard():
    target = ExperienceCard(id="k", principle="1. 串行执行", exp_status=EXP_VERIFIED, signal="test")
    weak = ExperienceCard(principle="并行就行", exp_status=EXP_CANDIDATE, signal="none")
    assert exp.guard("refute", weak, target, None)[0] == "add_opposed", "没有证据不能推翻"
    assert exp.guard("update", weak, target, {"principle": "并行就行"})[0] == "add_opposed"
    strong = ExperienceCard(principle="读之前入队", exp_status=EXP_VERIFIED, signal="test")
    assert exp.guard("update", strong, target, {"principle": "读之前入队"})[0] == "update", (
        "有证据的 update 可以改"
    )
    eight = {"principle": "；".join(f"{i}. 步骤{i}" for i in range(1, 9))}
    assert exp.guard("update", strong, target, eight)[0] == "update", "8 步以内可以合并"
    oversized = {"principle": "；".join(f"{i}. 步骤{i}" for i in range(1, 10))}
    assert exp.guard("update", strong, target, oversized)[0] == "add_opposed", (
        "合并结果超过 8 步（T2 §5.2 的约束）→ 不写进已有卡片"
    )
    assert exp.guard("confirm", strong, None, None)[0] == "add"


def test_candidate_experience_only_visible_to_author():
    k = ExperienceCard(exp_status=EXP_CANDIDATE, author_ids=["user_b"])
    assert exp.visible(k, "user_b") and not exp.visible(k, "user_c")


# ── 消息解析 ────────────────────────────────────────────────────────────────


def test_parse_messages_merges_tool_results_and_keeps_speaker():
    msgs = parse_messages(EXPERIENCE_ROUNDS[0]["messages"], "user_b")
    roles = [m.role for m in msgs]
    assert roles == ["member", "tool", "tool", "tool", "agent"]
    assert msgs[0].user_id == "user_b" and msgs[0].name == "用户B"
    assert "FAIL" in msgs[1].text and msgs[1].tool_args.startswith("pnpm vitest")


def test_service_runs_inline_without_scheduler():
    """没有调度器句柄时（本地、测试）整理在请求里同步完成。"""
    from memos.api.product_models import APIADDRequest

    svc = ProjectMemoryService(
        ProjectStore(FakeGraphDB(), FakeEmbedder().embed), ModelHub(RuleLLM())
    )
    sp = svc.create_space("s", "", [{"name": "代码开发"}])
    rnd = DECISION_ROUNDS[0]
    out = svc.accept(
        APIADDRequest(
            user_id=rnd["user_id"],
            conversation_id=rnd["conversation_id"],
            space_ids=sp.space_id,
            allow_memory_view=["project"],
            messages=rnd["messages"],
        )
    )
    assert out["status"] == "completed"
    assert len(svc.store.list_decisions(sp.space_id)) == 1


# ── SQLite 后端 ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind", CAS_KINDS)
def test_sqlite_backend_mirrors_memory_table_and_cas(kind, tmp_path):
    from memos.graph_dbs.base import ConcurrentUpdateError

    db = make_test_db(kind, tmp_path)
    assert db.supports_cas
    db.add_node(
        "a",
        "本机整理结果存入单个 SQLite 库，按 space_id 分表",
        {"memory_type": "X", "status": "activated", "tags": ["k1"]},
        user_name="s1",
    )
    db.add_node(
        "b", "向量索引存入 LanceDB", {"memory_type": "X", "status": "activated"}, user_name="s1"
    )
    db.add_node(
        "c",
        "本机整理结果存入单个 SQLite 库",
        {"memory_type": "X", "status": "activated"},
        user_name="s2",
    )

    assert db.get_by_metadata(
        [{"field": "memory_type", "op": "=", "value": "X"}], user_name="s1"
    ) == ["a", "b"]
    assert db.get_by_metadata(
        [{"field": "tags", "op": "contains", "value": "k1"}], user_name="s1"
    ) == ["a"]
    assert [
        h["id"] for h in db.search_by_fulltext(["整理结果怎么存"], scope="X", user_name="s1")
    ] == ["a"]

    node = db.get_node("a", user_name="s1")
    assert node["rev"] == 1
    assert node["memory"].startswith("本机整理结果") and node["metadata"]["memory_type"] == "X"
    assert node["metadata"]["user_name"] == "s1" and node["metadata"]["status"] == "activated"
    db.add_node(
        "a", "改", {"memory_type": "X", "status": "activated"}, user_name="s1", expected_rev=1
    )
    with pytest.raises(ConcurrentUpdateError):
        db.add_node(
            "a", "再改", {"memory_type": "X", "status": "activated"}, user_name="s1", expected_rev=1
        )

    db.delete_node("a", user_name="s1")
    assert db.get_node("a") is None
    assert db.search_by_fulltext(["整理结果"], scope="X", user_name="s1") == []


@pytest.mark.parametrize("kind", CAS_KINDS)
def test_sqlite_vector_search(kind, tmp_path):
    emb = FakeEmbedder()
    db = make_test_db(kind, tmp_path)
    vec = emb.embed(["决策存储方式"])[0]
    db.add_node(
        "d",
        "决策存储方式",
        {"memory_type": "Y", "status": "activated", "embedding": vec},
        user_name="s1",
    )
    hits = db.search_by_embedding(emb.embed(["存储方式"])[0], top_k=3, scope="Y", user_name="s1")
    assert hits and hits[0]["id"] == "d" and hits[0]["score"] > 0.5


@pytest.mark.parametrize("kind", CAS_KINDS)
def test_concurrent_write_is_retried(kind, tmp_path):
    """两个任务同时改同一条决策：第二个撞上 rev 变化，重读重判后仍然写对。"""
    db = make_test_db(kind, tmp_path)
    store = ProjectStore(db, FakeEmbedder().embed)
    svc = ProjectMemoryService(store, ModelHub(RuleLLM(), graph_db=db))
    sp = svc.create_space("s", "", [{"name": "代码开发"}])
    from memos.api.product_models import APIADDRequest

    rnd = DECISION_ROUNDS[0]
    svc.accept(
        APIADDRequest(
            user_id=rnd["user_id"],
            conversation_id=rnd["conversation_id"],
            space_ids=sp.space_id,
            allow_memory_view=["project"],
            messages=rnd["messages"],
        )
    )
    d = store.list_decisions(sp.space_id)[0]
    stale = store.get_decision(d.id, sp.space_id)
    d.content = d.content + "（别人先写了）"
    store.put_decision(d, expected_rev=stale.rev)
    from memos.graph_dbs.base import ConcurrentUpdateError

    with pytest.raises(ConcurrentUpdateError):
        store.put_decision(d, expected_rev=stale.rev)  # 同一 rev 再写一次会撞


def test_project_scope_checks_on_add_and_search():
    """带 project 时 user_id / space_ids 必填、最多 20 个、不能有空值：写入与检索都在插件里查，返回 422。"""
    client, _, _ = build_http_app(graph_db=FakeGraphDB())
    try:
        sid = _space(client)
        msgs = DECISION_ROUNDS[0]["messages"]
        cases = [
            {"user_id": "u"},  # 缺 space_ids
            {"user_id": "u", "space_ids": [f"s{i}" for i in range(21)]},
            {"user_id": "u", "space_ids": [sid, " "]},
        ]
        for extra in cases:
            r = client.post(
                "/product/add",
                json={**extra, "allow_memory_view": ["project"], "messages": msgs},
            )
            assert r.status_code == 422, (extra, r.text)
            r = client.post(
                "/product/search",
                json={**extra, "include_memory_view": ["project"], "query": "x"},
            )
            assert r.status_code == 422, (extra, r.text)
    finally:
        reset_project_hooks()


def test_naive_chat_time_gets_configured_offset(monkeypatch):
    """没带时区的 chat_time 按 PROJECT_MEMORY_NAIVE_TZ 补；与带时区的混在同一会话里也不报错。"""
    from memos.project_memory.service import ensure_tz

    monkeypatch.setenv("PROJECT_MEMORY_NAIVE_TZ", "+08:00")
    assert ensure_tz("2026-10-28 12:00:00") == "2026-10-28T12:00:00+08:00"
    assert ensure_tz("2026-10-28T12:00:00Z") == "2026-10-28T12:00:00Z"  # 带了就不动
    assert ensure_tz("不是时间") == "不是时间"

    client, sched, _ = build_http_app(graph_db=FakeGraphDB())
    try:
        sid = _space(client)
        rnd = DECISION_ROUNDS[0]
        naive = [{**m, "chat_time": m["chat_time"][:19].replace("T", " ")} for m in rnd["messages"]]
        tasks = []
        for msgs in (naive, rnd["messages"]):  # 先不带时区、再带时区，同一会话
            r = _add(client, sid, {**rnd, "messages": msgs})
            tasks.append(r.json()["data"][0]["task_id"])
            sched.drain()
        assert all(_status(client, "user_b", t)["status"] == "completed" for t in tasks)
    finally:
        reset_project_hooks()


def test_internal_view_flags_cannot_be_forged_and_stay_out_of_schema():
    """内部标志只按视图算：调用方传 true 不起作用；接口字段列表与序列化里都没有。"""
    from memos.api.product_models import APIADDRequest, APISearchRequest

    forged = {"project_view_flag": True, "project_view_only_flag": True}
    r = APIADDRequest.model_validate({"user_id": "u", "messages": [], **forged})
    assert (r.project_view_flag, r.project_view_only_flag) == (False, False)
    r = APIADDRequest.model_validate(
        {"user_id": "u", "messages": [], "allow_memory_view": ["project"], "space_ids": "s"}
    )
    assert (r.project_view_flag, r.project_view_only_flag) == (True, True)
    assert "project_view_flag" not in r.model_dump()
    for model in (APIADDRequest, APISearchRequest):
        props = model.model_json_schema()["properties"]
        assert "project_view_flag" not in props and "project_view_only_flag" not in props


def test_expected_4xx_are_not_logged_as_hook_failures(monkeypatch):
    """Space 不存在、缺字段这类预期的 4xx 不经通用钩子触发器，不打带堆栈的 ERROR。"""
    import memos.plugins.hooks as hooks_mod

    logged: list[str] = []
    monkeypatch.setattr(hooks_mod.logger, "exception", lambda msg, *a, **k: logged.append(msg % a))
    client, _, _ = build_http_app(graph_db=FakeGraphDB())
    try:
        rnd = DECISION_ROUNDS[0]
        assert _add(client, "no-such-space", rnd).status_code == 404
        r = client.post(
            "/product/search",
            json={"user_id": "u", "query": "x", "include_memory_view": ["project"]},
        )
        assert r.status_code == 422
        r = client.post("/product/get_memory", json={"space_id": "no-such-space"})
        assert r.status_code == 404
        assert logged == []
    finally:
        reset_project_hooks()
