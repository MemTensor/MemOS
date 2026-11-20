from copy import deepcopy
from types import SimpleNamespace

import pytest

from memos.project_memory.add_commit import refresh_topic_items
from memos.project_memory.add_merge import prepare_merge, rebase_append_only, rewrite_metadata
from memos.project_memory.add_view import RelationalProjectView
from memos.project_memory.judge import ModelError
from memos.project_memory.service import ProjectMemoryService
from tests.project_memory import test_add_store


add_store = test_add_store.add_store


class Writer:
    def __init__(self, output=None):
        self.output = output or {}
        self.calls = []

    def write(self, scope, *_args):
        self.calls.append(scope)
        return self.output.get(scope, {})


def plan_for(draft, topic=None):
    topic = topic or {
        "id": "topic",
        "space_id": "space",
        "domain_id": "domain",
        "version": 1,
        "topic_name": "Connection pools",
        "topic_summary": "",
        "topic_description": "",
    }
    episode = {
        "id": "episode",
        "space_id": "space",
        "conversation_id": "session",
        "drafts": [
            {
                "draft_id": "draft",
                "origin": "member",
                "chat_time": "2026-11-19T11:00:00+08:00",
                "authors": ["user"],
                "author_name": "User",
                "quote": "池大小设为 16",
                "source_refs": [
                    {"message_id": "message", "source_path": "/content", "start": 0, "end": 9}
                ],
                **draft,
            }
        ],
    }
    return {
        "episode_id": "episode",
        "space_id": "space",
        "assignments": [{"topic": topic, "episodes": [episode]}],
        "staging": None,
        "staged_updates": [],
        "formation": None,
        "warnings": [],
    }


@pytest.mark.parametrize("reason", [None, "新版接口使用独立连接池"])
def test_existing_decision_rewrite_retains_history_and_does_not_mutate_snapshot(reason):
    initial = {
        "id": "same-decision",
        "content": "池大小设为 8",
        "time": "2026-11-19T01:00:00Z",
        "user_ids": ["user"],
        "source": {},
        "reason": "旧服务共用连接池",
        "history": [
            {
                "content": "池大小设为 4",
                "time": "2026-11-19T00:00:00Z",
                "user_ids": ["user"],
                "source": {},
                "reason": "已有变更依据",
            }
        ],
        "conflicts": [],
    }
    data = plan_for({"kind": "decision", "content": "池大小设为 16", "reason_quote": reason})
    data["assignments"][0]["topic"]["decisions"] = [initial]
    frozen = deepcopy(data)
    writer = Writer(
        {
            "dec.update": {
                "results": [
                    {"n": 1, "decision_id": "same-decision", "same_as": None, "action": "rewrite"}
                ]
            }
        }
    )
    change = prepare_merge(writer, data)
    proposed = change["topics"][0]["topic"]
    assert proposed["decisions"][0]["content"] == "池大小设为 16"
    assert proposed["decisions"][0]["history"][0]["reason"] == "已有变更依据"
    assert proposed["decisions"][0]["history"][1]["content"] == "池大小设为 8"
    assert proposed["decisions"][0]["history"][1]["reason"] == (reason or "")
    assert proposed["decisions"][0]["reason"] == (reason or "")
    assert proposed["decisions"][0]["source"]["message_id"] == "message"
    assert change["kind"] == "modify"
    assert data == frozen
    assert writer.calls == ["dec.update"]


def test_append_rebase_keeps_concurrent_entries_and_rewrites_metadata():
    change = prepare_merge(Writer(), plan_for({"kind": "timeline", "content": "池大小设为 16"}))
    assert change["kind"] == "append"
    base = change["topics"][0]["topic"]
    concurrent = {
        **base,
        "version": 2,
        "timeline": [{"id": "another", "content": "Ready for release"}],
    }
    rebased = rebase_append_only(change, [concurrent])
    assert rebased["topics"][0]["expected_version"] == 2
    items = rebased["topics"][0]["topic"]["timeline"]
    assert len(items) == 2 and items[0]["id"] == "another"
    writer = Writer(
        {"episode.metadata": {"summary": "已发布 99 台机器", "description": "后续扩大部署"}}
    )
    ready = rewrite_metadata(writer, rebased)
    assert writer.calls == ["episode.metadata", "episode.metadata"]
    proposed = ready["topics"][0]["topic"]
    assert "99" not in proposed["topic_summary"]
    assert "后续" not in proposed["topic_description"]


def test_m05_adds_experience_from_draft_with_evidence():
    draft = {
        "kind": "experience",
        "content": "池大小设为 16",
        "card": {"task_intent": "调整池", "principle": "池大小设为 16"},
    }
    writer = Writer()
    change = prepare_merge(writer, plan_for(draft))
    (experience,) = change["topics"][0]["topic"]["experiences"]
    assert experience["card"]["principle"] == "池大小设为 16"
    assert experience["sources"][0]["message_id"] == "message"
    assert experience["user_ids"] == ["user"]
    assert change["kind"] == "append"
    assert not writer.calls


def test_same_conversation_provenance_merges_members_additively():
    data = plan_for({"kind": "timeline", "content": "池大小设为 16"})
    topic = data["assignments"][0]["topic"]
    topic["sources"] = [{"conversation_id": "session", "user_id": "earlier", "agent_id": "cli"}]
    change = prepare_merge(Writer(), data)
    assert change["kind"] == "append"
    (source,) = change["topics"][0]["topic"]["sources"]
    assert source["user_id"] == ["earlier", "user"]
    concurrent = {
        **topic,
        "version": 2,
        "sources": [{"conversation_id": "session", "user_id": "concurrent"}],
    }
    rebased = rebase_append_only(change, [concurrent])
    (source,) = rebased["topics"][0]["topic"]["sources"]
    assert source["user_id"] == ["concurrent", "earlier", "user"]


def test_experience_update_preserves_migrated_topic_links():
    data = plan_for({"kind": "experience", "content": "池大小设为 16"})
    data["assignments"][0]["topic"]["experiences"] = [
        {"id": "old", "card": {"principle": "池大小设为 16"}, "legacy_topic_ids": ["secondary"]},
    ]
    writer = Writer({"exp.merge": {"action": "confirm", "target_id": "old"}})
    change = prepare_merge(writer, data)
    (row,) = change["topics"][0]["topic"]["experiences"]
    assert row["id"] == "old"
    assert row["legacy_topic_ids"] == ["secondary"]


def plan_with_disagreement(draft):
    plan = plan_for(draft)
    plan["assignments"][0]["topic"]["decisions"] = [
        {
            "id": "export-cadence",
            "content": "Export daily.",
            "time": "2026-11-19T01:00:00Z",
            "user_ids": ["owner"],
            "source": {},
            "history": [],
            "conflicts": [
                {
                    "seq": 1,
                    "content": "Export hourly.",
                    "time": "2026-11-19T04:00:00Z",
                    "user_ids": ["dissenter"],
                    "source": {},
                }
            ],
        }
    ]
    return plan


@pytest.mark.parametrize("same_as", [None, "current"])
@pytest.mark.parametrize("draft_time", ["2026-11-19T03:00:00Z", "2026-11-19T05:00:00Z"])
def test_disagreement_changes_respect_the_members_existing_item_time(same_as, draft_time):
    content = "Export daily." if same_as else "Export weekly."
    plan = plan_with_disagreement(
        {
            "kind": "decision",
            "content": content,
            "quote": content,
            "authors": ["dissenter"],
            "chat_time": draft_time,
        }
    )
    writer = Writer(
        {"dec.update": {"results": [{"n": 1, "decision_id": "export-cadence", "same_as": same_as}]}}
    )

    change = prepare_merge(writer, plan)
    (result,) = change["topics"][0]["topic"]["decisions"]

    assert result["content"] == "Export daily."
    if draft_time == "2026-11-19T03:00:00Z":
        assert result["user_ids"] == ["owner"]
        assert result["conflicts"][0]["content"] == "Export hourly."
        assert result["history"] == []
    elif same_as:
        assert set(result["user_ids"]) == {"owner", "dissenter"}
        assert result["conflicts"] == []
        assert result["history"][0]["reason"] == ""
    else:
        assert result["conflicts"][0]["content"] == "Export weekly."


@pytest.mark.parametrize(
    ("draft_time", "should_resolve"),
    [
        ("2026-11-19T03:00:00Z", False),
        ("2026-11-19T05:00:00Z", True),
    ],
)
def test_resolution_does_not_archive_a_newer_choice(draft_time, should_resolve):
    plan = plan_with_disagreement(
        {
            "kind": "decision",
            "content": "Export daily.",
            "authors": ["facilitator"],
            "chat_time": draft_time,
            "final": True,
            "listed": ["Export daily.", "Export hourly."],
        }
    )
    writer = Writer(
        {
            "dec.update": {
                "results": [
                    {
                        "n": 1,
                        "decision_id": "export-cadence",
                        "same_as": "current",
                        "action": "resolve",
                        "informed": {"current": "Export daily.", "c1": "Export hourly."},
                    }
                ]
            }
        }
    )

    change = prepare_merge(writer, plan)
    (result,) = change["topics"][0]["topic"]["decisions"]

    assert result["content"] == "Export daily."
    if should_resolve:
        assert result["conflicts"] == []
        assert result["history"][0]["reason"] == ""
    else:
        assert result["conflicts"][0]["content"] == "Export hourly."
        assert result["history"] == []


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [{"n": 1, "action": "rewrite", "decision_id": "outside-snapshot"}],
        [{"n": 1, "action": "rewrite", "decision_id": None}],
        [{"n": 1, "action": "add"}],
        [{"n": 1, "action": "add", "decision_id": None}] * 2,
        [{"n": 1, "action": "join", "decision_id": "export-cadence", "same_as": "c2"}],
    ],
)
def test_invalid_decision_update_cannot_add_a_new_current_decision(rows):
    plan = plan_with_disagreement({"kind": "decision", "content": "Export weekly."})
    writer = Writer({"dec.update": {"results": rows}})

    with pytest.raises(ModelError, match="Decision update"):
        prepare_merge(writer, plan)


def test_explicit_new_decision_is_allowed_when_existing_decisions_are_unrelated():
    plan = plan_with_disagreement({"kind": "decision", "content": "Export CSV."})
    writer = Writer(
        {
            "dec.update": {
                "results": [{"n": 1, "action": "add", "decision_id": None, "same_as": None}]
            }
        }
    )

    change = prepare_merge(writer, plan)

    assert [entry["content"] for entry in change["topics"][0]["topic"]["decisions"]] == [
        "Export daily.",
        "Export CSV.",
    ]


def with_stance(topic, author, content, hour, *, same_as=None, confirms=None):
    draft = {
        "kind": "decision",
        "draft_id": f"{author}-{hour}",
        "content": content,
        "quote": content,
        "authors": [author],
        "author_name": author.title(),
        "chat_time": f"2026-11-19T{hour:02}:00:00Z",
        "final": confirms is not None,
        "listed": list((confirms or {}).values()),
    }
    writer = Writer()
    if topic is not None:
        (existing,) = topic["decisions"]
        writer.output["dec.update"] = {
            "results": [
                {
                    "n": 1,
                    "decision_id": existing["id"],
                    "same_as": same_as,
                    "action": "resolve" if confirms else "join" if same_as else "conflict",
                    "informed": confirms or {},
                }
            ]
        }
    change = prepare_merge(writer, plan_for(draft, topic))
    return change["topics"][0]["topic"]


@pytest.mark.parametrize("reaffirm", [False, True], ids=["join", "reaffirm"])
def test_newer_member_stance_survives_out_of_order_rewrite(reaffirm):
    topic = with_stance(None, "alice", "Export daily.", 1)
    topic = with_stance(topic, "bob", "Export daily.", 2 if reaffirm else 5, same_as="current")
    if reaffirm:
        (before_reaffirmation,) = topic["decisions"]
        topic = with_stance(topic, "bob", "Export daily.", 5, same_as="current")
        (after_reaffirmation,) = topic["decisions"]
        assert after_reaffirmation["version"] == before_reaffirmation["version"]

    (before,) = topic["decisions"]
    assert before["user_ids"] == ["alice", "bob"]
    assert before["time"] == "2026-11-19T01:00:00+00:00"
    late = with_stance(topic, "bob", "Export weekly.", 3)
    assert late["decisions"] == [before]

    fresh = with_stance(topic, "bob", "Export weekly.", 6)
    (rewritten,) = fresh["decisions"]
    assert rewritten["content"] == "Export weekly."
    assert rewritten["history"][0]["user_ids"] == ["alice", "bob"]


def test_late_move_cannot_withdraw_a_newer_stance_on_an_alternative():
    topic = with_stance(None, "alice", "Export daily.", 1)
    topic = with_stance(topic, "bob", "Export hourly.", 2)
    topic = with_stance(topic, "carol", "Export hourly.", 5, same_as="c1")

    late = with_stance(topic, "carol", "Export daily.", 3, same_as="current")
    assert late["decisions"] == topic["decisions"]


def test_resolution_respects_newer_member_support_on_an_active_alternative():
    topic = with_stance(None, "alice", "Export daily.", 1)
    topic = with_stance(topic, "bob", "Export hourly.", 2)
    topic = with_stance(topic, "bob", "Export hourly.", 5, same_as="c1")
    (before,) = topic["decisions"]
    assert before["conflicts"][0]["time"] == "2026-11-19T02:00:00+00:00"

    disclosed = {"current": "Export daily.", "c1": "Export hourly."}
    late = with_stance(topic, "carol", "Export daily.", 3, same_as="current", confirms=disclosed)
    assert late["decisions"] == [before]

    fresh = with_stance(topic, "carol", "Export daily.", 6, same_as="current", confirms=disclosed)
    (resolved,) = fresh["decisions"]
    assert resolved["conflicts"] == []
    assert resolved["history"][0]["content"] == "Export hourly."


def resolved_export_cadence():
    topic = with_stance(None, "alice", "Export daily.", 1)
    topic = with_stance(topic, "bob", "Export hourly.", 2)
    disclosed = {"current": "Export daily.", "c1": "Export hourly."}
    return with_stance(topic, "carol", "Export daily.", 6, same_as="current", confirms=disclosed)


@pytest.mark.parametrize(
    ("author", "content", "hour", "fresh"),
    [
        ("alice", "Export weekly.", 3, False),
        ("bob", "Export hourly.", 3, False),
        ("bob", "Export hourly.", 7, True),
    ],
    ids=["current-supporter", "archived-supporter", "new-disagreement"],
)
def test_resolution_fences_delayed_statements_from_all_affected_members(
    author, content, hour, fresh
):
    topic = resolved_export_cadence()
    (before,) = topic["decisions"]
    assert before["content"] == "Export daily."
    assert before["conflicts"] == []
    assert before["time"] == "2026-11-19T06:00:00+00:00"

    (after,) = with_stance(topic, author, content, hour)["decisions"]
    if fresh:
        (conflict,) = after["conflicts"]
        assert conflict["content"] == content
        assert conflict["user_ids"] == [author]
        assert after["time"] == before["time"]
        assert after["history"] == before["history"]
    else:
        assert after == before


def test_active_option_time_bounds_older_stored_member_watermark():
    topic = resolved_export_cadence()
    (stored,) = topic["decisions"]
    stored["_member_stance_times"]["alice"] = "2026-11-19T01:00:00+00:00"

    late = with_stance(topic, "alice", "Export weekly.", 3)
    assert late["decisions"] == [stored]


def test_rewrite_uses_replaced_current_stances_not_unrelated_alternative_stances():
    topic = with_stance(None, "alice", "Export daily.", 1)
    alternative = with_stance(topic, "carol", "Export hourly.", 5)

    allowed = with_stance(alternative, "alice", "Export weekly.", 3)
    (decision,) = allowed["decisions"]
    assert decision["content"] == "Export weekly."
    assert decision["conflicts"][0]["content"] == "Export hourly."

    supported = with_stance(alternative, "bob", "Export daily.", 5, same_as="current")
    late = with_stance(supported, "alice", "Export weekly.", 3)
    assert late["decisions"] == supported["decisions"]


def test_archived_member_stance_still_fences_an_older_statement():
    topic = with_stance(None, "alice", "Export daily.", 1)
    topic = with_stance(topic, "bob", "Export daily.", 5, same_as="current")
    topic = with_stance(topic, "alice", "Export weekly.", 6)
    (current,) = topic["decisions"]
    assert current["user_ids"] == ["alice"]

    late = with_stance(topic, "bob", "Export hourly.", 3)
    assert late["decisions"] == [current]


def test_relational_search_and_get_keep_member_stance_times_private(add_store):
    topic = with_stance(None, "alice", "Export daily.", 1)
    topic = with_stance(topic, "bob", "Export daily.", 5, same_as="current")
    (stored,) = topic["decisions"]
    decision_id = stored["id"]
    with add_store.transaction() as cur:
        cur.execute(
            "INSERT INTO spaces (id, project_id, space_name) VALUES ('space', 'project-a', 'A')"
        )
        cur.execute(
            "INSERT INTO domains (id, space_id, domain) VALUES ('domain', 'space', 'product')"
        )
        cur.execute(
            """INSERT INTO topics (id, space_id, domain_id, topic_name, topic_summary,
                                   topic_description, create_time, update_time)
               VALUES ('topic', 'space', 'domain', 'Exports', 'Export daily.', '', %s, %s)""",
            (topic["create_time"], topic["update_time"]),
        )
        refresh_topic_items(cur, {**topic, "id": "topic", "space_id": "space"})
    (projected_topic,) = add_store.read_topics("space")
    (projected_decision,) = projected_topic["decisions"]
    assert projected_decision["_member_stance_times"]["bob"] == "2026-11-19T05:00:00+00:00"

    service = ProjectMemoryService(RelationalProjectView(add_store), Writer())
    request = SimpleNamespace(
        space_ids=["space"], query="Export daily", project_item_types=["decision"]
    )
    (search_topic,) = service.search_result(request)["topic_detail_list"]
    request.project_result_format = "item"
    (search_item,) = service.search_result(request)["project_item_list"]
    (get_topic,) = service.get_by_id("topic")["topic_detail_list"]
    (get_item,) = service.get_by_id(decision_id)["project_item_list"]
    for row in (search_topic["decisions"][0], search_item, get_topic["decisions"][0], get_item):
        assert row["id"] == decision_id
        assert row["time"] == "2026-11-19T01:00:00+00:00"
        assert "_member_stance_times" not in row
