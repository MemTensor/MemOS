"""11/18 接口与行为改动的用例：报错 reason、组件单独获取、成员 ID 对照表、Agent 数组、
未整理条数现算、flush 不改状态、删除围栏、检索门槛与混排钩子、经验稿校验、按时间筛选。"""

from __future__ import annotations

import pytest

from memos.plugins.result_kinds import apply_relativity_to_plugin_kinds
from memos.project_memory import experience as exp
from memos.project_memory.errors import REASONS, reason_of
from memos.project_memory.testing import (
    DECISION_ROUNDS,
    EXPERIENCE_ROUNDS,
    build_http_app,
    make_test_db,
    reset_project_hooks,
)
from memos.project_memory.types import EXP_CANDIDATE, Episode, Msg


@pytest.fixture(params=["fake", "sqlite"])
def app(request, tmp_path):
    graph_db = make_test_db(request.param, tmp_path / request.param)
    client, sched, plugin = build_http_app(graph_db=graph_db)
    yield client, sched, plugin
    reset_project_hooks()


def _space(client, domains=("代码开发", "产品设计")) -> str:
    r = client.post(
        "/product/create_space",
        json={"space_name": "S", "domains": [{"name": d} for d in domains]},
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


def _status(client, task_id):
    return client.get(
        "/product/scheduler/status", params={"user_id": "x", "task_id": task_id}
    ).json()["data"][0]


def _all(client, sched, sid, rounds):
    for rnd in rounds:
        assert _add(client, sid, rnd).status_code == 200
        sched.drain()
    client.post("/product/flush_project_memory", json={"space_id": sid})


# ── 报错 reason ─────────────────────────────────────────────────────────────


def test_errors_carry_reason(app):
    client, _, _ = app
    r = client.post("/product/get_space", json={"space_id": "nope"})
    assert r.status_code == 404 and r.json()["reason"] == "SPACE_NOT_FOUND"
    r = client.post(
        "/product/add",
        json={"user_id": "u", "allow_memory_view": ["project"], "messages": []},
    )
    assert r.status_code == 422 and r.json()["reason"] == "SCOPE_REQUIRED"
    sid = _space(client)
    r = _add(client, sid, DECISION_ROUNDS[0], domains="没有这个领域")
    assert r.status_code == 400 and r.json()["reason"] == "DOMAIN_NOT_REGISTERED"
    r = client.post(
        "/product/search",
        json={
            "user_id": "u",
            "query": "q",
            "space_ids": sid,
            "include_memory_view": ["project"],
            "project_item_types": ["nope"],
        },
    )
    assert r.status_code == 400 and r.json()["reason"] == "INVALID_PARAM"


def test_every_service_message_has_a_reason():
    msgs = [
        "Space 不存在：x",
        "主题不在这个 Space 里：['t']",
        "未配置领域：Space x 至少登记一个领域后才能写入项目记忆",
        "领域未登记：['a']",
        "同一批里领域重名：['a']",
        "每个 Space 最多 20 个领域",
        "领域改名冲突：a → b",
        "领域仍被主题引用，不能删除：['a']",
        "space_name 不能为空",
        "领域名称不能为空",
        "filter.related_id 只接受单个字符串",
        "user_id and space_ids are required when using project memory",
        "space_ids accepts at most 20 spaces",
    ]
    assert all(reason_of(m) for m in msgs)
    assert len({r for _, _, r in REASONS}) >= 12


# ── 组件单独获取 ────────────────────────────────────────────────────────────


def test_components_by_type_and_by_id(app):
    client, sched, _ = app
    sid = _space(client)
    _all(client, sched, sid, DECISION_ROUNDS + EXPERIENCE_ROUNDS)
    base = {
        "user_id": "u",
        "query": "本机整理结果怎么存？",
        "space_ids": sid,
        "include_memory_view": ["project"],
        "relativity": 0,
    }
    data = client.post(
        "/product/search",
        json={**base, "project_result_format": "item", "project_item_types": ["decision"]},
    ).json()["data"]
    items = data["project_item_list"]
    assert items and {x["item_type"] for x in items} == {"decision"}
    assert all(x["topic_id"] and x["space_id"] == sid for x in items)

    got = client.get(f"/product/get_memory/{items[0]['id']}").json()["data"]
    full = got["project_item_list"][0]
    assert full["item_type"] == "decision" and "source" in full

    topics = client.post(
        "/product/search", json={**base, "project_item_types": ["experience"]}
    ).json()["data"]["topic_detail_list"]
    assert topics and all(not t["decisions"] and not t["timeline"] for t in topics)
    exp_ids = [e["id"] for t in topics for e in t["experiences"]]
    if exp_ids:
        e = client.get(f"/product/get_memory/{exp_ids[0]}").json()["data"]["project_item_list"][0]
        assert e["item_type"] == "experience" and "card" in e

    tid = topics[0]["id"]
    assert (
        client.get(f"/product/get_memory/{tid}").json()["data"]["topic_detail_list"][0]["id"] == tid
    )


def test_search_threshold_applies_to_project_only_requests(app):
    client, sched, _ = app
    sid = _space(client)
    _all(client, sched, sid, DECISION_ROUNDS[:2])
    body = {"user_id": "u", "query": "x", "space_ids": sid, "include_memory_view": ["project"]}
    assert client.post("/product/search", json={**body, "relativity": 0}).json()["data"][
        "topic_detail_list"
    ]
    assert not client.post("/product/search", json={**body, "relativity": 0.99}).json()["data"][
        "topic_detail_list"
    ]


def test_mixed_search_goes_through_core_buckets(app):
    """混合检索：插件在 search.memory_results 加 project_mem，核心按同一门槛过滤，
    after_rerank 再组成对外的列表。"""
    client, sched, plugin = app
    sid = _space(client)
    _all(client, sched, sid, DECISION_ROUNDS[:2])

    class Req:
        include_memory_view = ["text_mem", "project"]
        project_view_flag = True
        project_view_only_flag = False
        query = "本机整理结果怎么存"
        space_ids = [sid]
        domains = None
        user_id = "u"
        conversation_id = None
        project_item_types = None
        project_result_format = None
        model_fields_set: set = set()

    results = plugin._search_add_bucket(search_req=Req(), results={"text_mem": []})
    assert results["project_mem"][0]["memories"]
    kept = apply_relativity_to_plugin_kinds(results, 0.99)
    assert kept["project_mem"][0]["memories"] == []
    results = plugin._search_add_bucket(search_req=Req(), results={"text_mem": []})
    out = plugin._search_finish(search_req=Req(), results=results)
    assert "project_mem" not in out and out["topic_detail_list"]


# ── 写入：成员 ID 对照表、Agent 数组 ─────────────────────────────────────────


def test_member_map_and_agent_array(app):
    client, sched, plugin = app
    sid = _space(client)
    r = client.post(
        "/product/add",
        json={
            "user_id": "mid-1",  # 开源版只收字符串；企业版收数组（群聊）
            "agent_id": ["claude-code", "codex"],
            "space_ids": sid,
            "allow_memory_view": ["project"],
            "project_member_map": {"mid-1": "user_a", "mid-2": "user_b"},
            "messages": [
                {
                    "role": "user",
                    "content": "本机整理结果存入单个 SQLite 库，按 space_id 分表。",
                    "role_id": "mid-2",
                    "role_name": "用户B",
                    "chat_time": "2026-11-03T09:30:00+08:00",
                },
                {
                    "role": "assistant",
                    "content": "好的。",
                    "chat_time": "2026-11-03T09:31:00+08:00",
                },
            ],
        },
    )
    assert r.status_code == 200, r.text
    sched.drain()
    topics = plugin.service.store.list_topics(sid)
    assert topics
    src = topics[0].sources[0]
    assert src["user_id"] == ["user_b"] and src["agent_id"] == ["claude-code", "codex"]


def test_agent_array_is_recorded_as_is(app):
    client, sched, plugin = app
    sid = _space(client)
    rnd = dict(DECISION_ROUNDS[0], conversation_id=None)
    body = {
        "user_id": rnd["user_id"],
        "agent_id": ["claude-code", "codex"],
        "space_ids": sid,
        "allow_memory_view": ["project"],
        "messages": rnd["messages"],
    }
    assert client.post("/product/add", json=body).status_code == 200
    sched.drain()
    src = plugin.service.store.list_topics(sid)[0].sources
    assert src[0]["agent_id"] == ["claude-code", "codex"]


# ── 任务状态与 flush ────────────────────────────────────────────────────────


OPEN_ROUND = {
    "user_id": "user_a",
    "conversation_id": "workbuddy:a-open",
    "messages": [
        {
            "role": "user",
            "content": "本机整理结果按领域分库，每个领域一个 SQLite 库文件。",
            "role_id": "user_a",
            "role_name": "用户A",
            "chat_time": "2026-11-03T09:30:00+08:00",
        },
        {
            "role": "assistant",
            "content": "我先看一下按领域分库要改哪些文件。",
            "chat_time": "2026-11-03T09:31:00+08:00",
        },
    ],
}


def test_open_count_is_live_and_flush_keeps_status(app):
    client, sched, _ = app
    sid = _space(client)
    r = _add(client, sid, OPEN_ROUND)
    task = r.json()["data"][0]["task_id"]
    sched.drain()
    before = _status(client, task)
    assert before["status"] == "completed"
    assert before["memory_views"]["project"]["open_episode_messages"] == 2  # 段还开着
    out = client.post(
        "/product/flush_project_memory",
        json={"space_id": sid, "conversation_id": OPEN_ROUND["conversation_id"], "task_id": task},
    ).json()["data"]
    assert "trace" not in out and out["failed_episodes"] == 0 and out["memory_ids"]
    after = _status(client, task)
    assert after["status"] == "completed"
    assert after["memory_views"]["project"]["open_episode_messages"] == 0  # 现算，flush 后归零
    assert after["memory_views"]["project"]["memory_ids"] == out["memory_ids"]


def test_flush_does_not_complete_a_queued_task(app):
    client, sched, _ = app
    sid = _space(client)
    r = _add(client, sid, DECISION_ROUNDS[0])
    task = r.json()["data"][0]["task_id"]  # 还在队列里，没 drain
    client.post("/product/flush_project_memory", json={"space_id": sid, "task_id": task})
    assert _status(client, task)["status"] == "in_progress"
    sched.drain()
    assert _status(client, task)["status"] == "completed"


# ── 删除围栏 ────────────────────────────────────────────────────────────────


def test_clear_fences_queued_and_open_content(app):
    client, sched, plugin = app
    sid = _space(client)
    _add(client, sid, DECISION_ROUNDS[0])  # 受理了、还在队列里
    client.post("/product/delete_memory", json={"space_id": sid})  # 清空
    sched.drain()
    client.post("/product/flush_project_memory", json={"space_id": sid})
    assert plugin.service.store.list_topics(sid) == []

    # 清空之后的新写入照常整理
    _add(client, sid, DECISION_ROUNDS[1])
    sched.drain()
    client.post("/product/flush_project_memory", json={"space_id": sid})
    assert plugin.service.store.list_topics(sid)


# ── 读取：按时间筛选、Agent 匹配 ───────────────────────────────────────────


def test_get_memory_filters(app):
    client, sched, _ = app
    sid = _space(client)
    _all(client, sched, sid, DECISION_ROUNDS[:1])

    def total(flt):
        r = client.post("/product/get_memory", json={"space_id": sid, "filter": flt})
        assert r.status_code == 200, r.text
        return r.json()["data"]["total"]

    assert total({}) == 1
    assert total({"update_time": {"gte": "2099-01-01"}}) == 0
    assert total({"create_time": {"lt": "2099-01-01"}}) == 1
    agent = DECISION_ROUNDS[0]["conversation_id"].split(":")[0]
    assert total({"related_id": DECISION_ROUNDS[0]["user_id"]}) == 1
    assert total({"related_id": "nobody"}) == 0
    r = client.post("/product/get_memory", json={"space_id": sid, "filter": {"related_id": ["a"]}})
    assert r.status_code == 400 and r.json()["reason"] == "INVALID_FILTER"
    assert agent


# ── 经验稿 ─────────────────────────────────────────────────────────────────


def test_note_cards_validate_values_and_cap_count():
    notes = [
        {"task_intent": f"t{i}", "principle": "p", "status": "bogus", "signal": "weird"}
        for i in range(5)
    ]
    ep = Episode(id="e", space_id="s", conversation_id="c")
    ep.messages = [
        Msg(id="a", role="agent", text="", chat_time="2026-11-03T09:30:00+08:00", notes=notes)
    ]
    logs: list[str] = []
    cards = exp.note_cards(ep, logs.append)
    assert len(cards) == exp.MAX_NOTES
    assert all(c.exp_status == EXP_CANDIDATE and c.signal == "none" for c in cards)
    assert logs
