from copy import deepcopy

import pytest

from memos.project_memory.add_merge import prepare_merge, rebase_append_only, rewrite_metadata
from memos.project_memory.judge import ModelError


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
        {"dec.update": {"results": [{"n": 1, "decision_id": "same-decision", "action": "rewrite"}]}}
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
    writer = Writer({"dec.update": {"results": [{"n": 1, "action": "add", "decision_id": None}]}})

    change = prepare_merge(writer, plan)

    assert [entry["content"] for entry in change["topics"][0]["topic"]["decisions"]] == [
        "Export daily.",
        "Export CSV.",
    ]
