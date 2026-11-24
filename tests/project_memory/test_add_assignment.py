from datetime import datetime, timedelta, timezone

import pytest

from memos.project_memory.add_algorithm import (
    _ASSIGN,
    _ASSIGN_BATCH,
    organize_episode,
    recall_candidates,
)
from memos.project_memory.judge import ModelError


NOW = datetime(2026, 11, 19, tzinfo=timezone.utc)


@pytest.mark.parametrize("prompt", [_ASSIGN, _ASSIGN_BATCH], ids=["direct", "batch"])
def test_assignment_prompt_compares_decision_subjects_across_implementations(prompt):
    assert "同一具体决策事项" in prompt
    assert "即使方案可独立实施" in prompt
    assert "不确定用 stage" in prompt


class Writer:
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.calls = []

    def write(self, scope, _prompt, inputs):
        self.calls.append((scope, inputs))
        decision = next(self.outputs)
        if isinstance(decision, ModelError):
            raise decision
        return decision


def topic(tid, domain, name="Cache rollout", **extra):
    return {
        "id": tid,
        "space_id": "space",
        "domain": domain,
        "domain_id": domain,
        "version": 1,
        "topic_name": name,
        "topic_summary": "Planning deployment",
        "topic_description": "",
        **extra,
    }


def episode(eid, **extra):
    return {
        "id": eid,
        "space_id": "space",
        "domains": ["project"],
        "conversation_id": "conversation",
        "episode_summary": "Cache rollout deployment",
        "drafts": [
            {
                "kind": "decision",
                "content": "secret draft content",
                "origin": "member",
                "source": {"turn_ids": [f"turn-{eid}"]},
            }
        ],
        **extra,
    }


@pytest.mark.parametrize(
    "previous",
    [
        {"result": {"topic_ids": ["prior"]}},
        {
            "result": {"topic_ids": []},
            "staged_status": "moved",
            "moved_to_topic_id": "prior",
        },
    ],
    ids=["committed", "moved"],
)
def test_recall_preserves_predecessor_and_does_not_expose_other_domains_or_drafts(previous):
    ep = episode("new", previous=previous)
    ranked = recall_candidates(
        ep,
        [
            topic("excluded", "other"),
            topic("top", "project"),
            topic("prior", "project", "Unrelated title", topic_summary="Unrelated overview"),
        ],
        limit=1,
    )
    assert {candidate["id"] for candidate in ranked} == {"prior", "top"}
    writer = Writer(
        [
            {
                "action": "attach",
                "topic_id": "prior",
                "relationship": "same_work",
                "same_deliverable": True,
                "positive_basis": "previous_episode",
                "independently_deliverable": False,
                "affects_existing_decisions": True,
            }
        ]
    )

    def unexpected_topic_read(_domains):
        pytest.fail("Direct Topic attachment should not load additional Domains")

    plan = organize_episode(
        writer,
        ep,
        ranked,
        [episode("staged", domains=["other"])],
        {"staged_since_last_formation": 9},
        now=NOW,
        load_formation_topics=unexpected_topic_read,
    )
    assert plan["assignments"][0]["topic"]["id"] == "prior"
    assert "secret draft content" not in str(writer.calls[0][1])


@pytest.mark.parametrize(
    "destination",
    [topic("prior", "other"), topic("prior", "project", space_id="foreign")],
    ids=["other-domain", "other-space"],
)
def test_moved_predecessor_target_must_still_be_in_scope(destination):
    current = episode(
        "new",
        previous={
            "result": {"topic_ids": []},
            "staged_status": "moved",
            "moved_to_topic_id": "prior",
        },
    )
    assert recall_candidates(current, [destination]) == []


def test_name_only_match_is_staged():
    ep = episode("new")
    writer = Writer(
        [
            {
                "action": "attach",
                "topic_id": "top",
                "relationship": "same_work",
                "same_deliverable": True,
                "positive_basis": "name",
                "independently_deliverable": False,
                "affects_existing_decisions": True,
            }
        ]
    )
    plan = organize_episode(
        writer, ep, recall_candidates(ep, [topic("top", "project")]), [], {}, now=NOW
    )
    assert not plan["assignments"]
    assert plan["staging"]["episode_id"] == "new"


def test_mention_only_anchor_does_not_establish_same_work():
    ep = episode(
        "new",
        anchor_keys=["path:README.md"],
        anchors=[
            {"path": "README.md", "status": "unresolved", "change_kind": "mention"},
        ],
    )
    writer = Writer(
        [
            {
                "action": "attach",
                "topic_id": "top",
                "relationship": "same_work",
                "same_deliverable": True,
                "positive_basis": "shared_anchor",
                "independently_deliverable": False,
                "affects_existing_decisions": True,
            }
        ]
    )
    previous = topic(
        "top",
        "project",
        anchor_keys=["path:README.md"],
        anchors=[
            {"path": "README.md", "status": "unresolved", "change_kind": "mention"},
        ],
    )
    plan = organize_episode(writer, ep, recall_candidates(ep, [previous]), [], {}, now=NOW)
    assert plan["assignments"] == []


def test_formation_checks_evidence_and_transfers_prior_episodes():
    ep = episode("new")
    old = episode("old", staged_at=NOW - timedelta(hours=3), staged_attempts=0)
    writer = Writer(
        [
            {
                "clusters": [
                    {
                        "episode_ids": ["new", "old"],
                        "domain": "project",
                        "name": "Cache deployment",
                        "independently_deliverable": True,
                        "affects_existing_decisions": False,
                    }
                ]
            }
        ]
    )
    plan = organize_episode(
        writer,
        ep,
        [],
        [old],
        {
            "formation_version": 4,
            "staged_since_last_formation": 3,
            "last_formation_at": NOW - timedelta(hours=3),
        },
        now=NOW,
    )
    (assignment,) = plan["assignments"]
    assert {row["id"] for row in assignment["episodes"]} == {"old", "new"}
    assert assignment["topic"]["version"] is None
    by_id = {update["episode_id"]: update for update in plan["staged_updates"]}
    assert by_id["old"]["status"] == "moved"
    assert plan["formation"] == {"version": 4, "consumed": 3}


def staged_choice(eid, target):
    return {
        "episode_id": eid,
        "topic_id": target,
        "action": "attach",
        "relationship": "same_work",
        "same_deliverable": True,
        "positive_basis": "same_goal",
        "independently_deliverable": False,
        "affects_existing_decisions": True,
    }


def test_formation_reassigns_old_episodes_in_scoped_bounded_batches():
    current = episode("new")
    candidates = [topic("project-topic", "project"), topic("other-topic", "other")]
    old = [episode(f"old-{i}", domains=["project"] if i % 2 == 0 else ["other"]) for i in range(10)]
    old[0]["staged_attempts"] = 2
    old[1]["staged_attempts"] = 2
    old[1]["drafts"] = [{"kind": "timeline"}]
    no_match = episode("no-match", domains=["unavailable"])
    foreign = episode("foreign", space_id="foreign-space")
    choices = [
        {"episode_id": "old-0", "action": "stage"},
        {"episode_id": "old-1", "action": "stage"},
        *[staged_choice(f"old-{i}", candidates[i % 2]["id"]) for i in range(2, len(old))],
    ]
    writer = Writer(
        [
            {"action": "stage"},
            {"assignments": list(reversed(choices[:8]))},
            {"assignments": list(reversed(choices[8:]))},
            {"clusters": []},
        ]
    )
    plan = organize_episode(
        writer,
        current,
        recall_candidates(current, candidates),
        [*old, no_match, foreign],
        {"formation_version": 2, "staged_since_last_formation": 11},
        now=NOW,
        all_topics=[*candidates, topic("foreign-topic", "project", space_id="foreign-space")],
    )
    assert [scope for scope, _ in writer.calls] == [
        "episode.assign",
        "episode.assign.batch",
        "episode.assign.batch",
        "episode.formation",
    ]
    assert [len(inputs["episodes"]) for _, inputs in writer.calls[1:3]] == [8, 2]
    judged = [ep for _, inputs in writer.calls[1:3] for ep in inputs["episodes"]]
    assert [(ep["episode_id"], [c["id"] for c in ep["candidates"]]) for ep in judged] == [
        (f"old-{i}", [candidates[i % 2]["id"]]) for i in range(10)
    ]
    assert "secret draft content" not in str(judged)
    assert [ep["id"] for ep in writer.calls[-1][1]["episodes"]] == [
        "new",
        "old-0",
        "old-1",
        "no-match",
    ]
    assert plan["formation"] == {"version": 2, "consumed": 11}
    by_id = {row["episode_id"]: row for row in plan["staged_updates"]}
    assert by_id["old-0"]["status"] == "long_unassigned"
    assert by_id["old-1"]["status"] == "archived"
    assert by_id["no-match"]["status"] == "active"
    assert [row["attempts"] for row in plan["staged_updates"]] == [3, 3, *([1] * 9)]
    assert [ep["id"] for ep in plan["assignments"][0]["episodes"]] == [
        "old-2",
        "old-4",
        "old-6",
        "old-8",
    ]


@pytest.mark.parametrize(
    "reply",
    [
        [],
        {"assignments": [{"episode_id": "old-b", "action": "stage"}]},
        {"assignments": [{"episode_id": "old-a", "action": "stage"}] * 2},
        {
            "assignments": [
                {"episode_id": "old-a", "action": "stage"},
                {"episode_id": "foreign", "action": "stage"},
            ]
        },
        {
            "assignments": [
                staged_choice("old-a", "other-topic"),
                staged_choice("old-b", "other-topic"),
            ]
        },
        {"assignments": [staged_choice("old-a", "project-topic"), "bad-slot"]},
        ModelError("batch backend unavailable"),
    ],
)
def test_invalid_formation_reassignment_preserves_the_staging_plan(reply):
    current = episode("new")
    candidates = [topic("project-topic", "project"), topic("other-topic", "other")]
    writer = Writer([reply])
    plan = organize_episode(
        writer,
        current,
        [],
        [episode("old-a"), episode("old-b", domains=["other"])],
        {"staged_since_last_formation": 9},
        now=NOW,
        all_topics=candidates,
    )
    assert [scope for scope, _ in writer.calls] == ["episode.assign.batch"]
    assert plan["staging"]["episode_id"] == "new"
    assert plan["warnings"] == ["FORMATION_MODEL_UNAVAILABLE"]
    assert plan["assignments"] == plan["staged_updates"] == []
    assert plan["formation"] is None


def test_failed_later_batch_discards_earlier_reassignments():
    old = [episode(f"old-{index}") for index in range(9)]
    candidate = topic("existing", "project")
    writer = Writer(
        [
            {"assignments": [staged_choice(ep["id"], "existing") for ep in old[:8]]},
            ModelError("batch backend unavailable"),
        ]
    )
    plan = organize_episode(
        writer,
        episode("new"),
        [],
        old,
        {"staged_since_last_formation": 9},
        now=NOW,
        all_topics=[candidate],
    )
    assert len(writer.calls) == 2
    assert plan["staging"]["episode_id"] == "new"
    assert plan["warnings"] == ["FORMATION_MODEL_UNAVAILABLE"]
    assert plan["assignments"] == plan["staged_updates"] == []
    assert plan["formation"] is None


def test_batched_formation_reassignment_uses_the_same_evidence_guards():
    current = episode("new")
    old = episode("old", anchor_keys=["path:README.md"])
    candidate = topic("existing", "project", anchor_keys=["path:README.md"])
    weak_choice = {**staged_choice("old", "existing"), "positive_basis": "shared_anchor"}
    writer = Writer([{"assignments": [weak_choice]}, {"clusters": []}])
    plan = organize_episode(
        writer,
        current,
        [],
        [old],
        {"staged_since_last_formation": 9},
        now=NOW,
        all_topics=[candidate],
    )
    assert [ep["id"] for ep in writer.calls[-1][1]["episodes"]] == ["new", "old"]
    assert plan["assignments"] == plan["warnings"] == []
    assert plan["staged_updates"][0]["status"] == "active"


def test_formation_keeps_bounded_context_from_unresolved_episode_domains():
    current = episode("new")
    unresolved = episode("unresolved", domains=["reliability"])
    related = episode("related", domains=["reliability"])
    resolved = episode("resolved", domains=["other"])
    primary = [topic(f"primary-{i:02}", "project") for i in range(20)]
    secondary = [topic(f"secondary-{i:02}", "reliability") for i in range(20)]
    all_topics = [
        *primary,
        *secondary,
        topic("attached", "other"),
        topic("out-of-scope", "unrelated"),
        topic("foreign", "reliability", space_id="foreign"),
    ]
    writer = Writer(
        [
            {"action": "stage"},
            {
                "assignments": [
                    {"episode_id": "unresolved", "action": "stage"},
                    {"episode_id": "related", "action": "stage"},
                    staged_choice("resolved", "attached"),
                ]
            },
            {"clusters": []},
        ]
    )
    plan = organize_episode(
        writer,
        current,
        recall_candidates(current, all_topics),
        [unresolved, related, resolved],
        {"staged_since_last_formation": 9},
        now=NOW,
        all_topics=all_topics,
    )
    direct = writer.calls[0][1]["candidates"]
    assert {candidate["domain"] for candidate in direct} == {"project"}
    existing = writer.calls[-1][1]["existing_topics"]
    assert [candidate["domain"] for candidate in existing[:2]] == ["project", "reliability"]
    assert len(existing) == len({candidate["id"] for candidate in existing}) == 24
    for candidate in existing:
        assert candidate["episode_ids"] == (
            ["new"] if candidate["domain"] == "project" else ["unresolved", "related"]
        )
    assert {candidate["domain"] for candidate in existing} == {"project", "reliability"}
    assert plan["assignments"][0]["topic"]["id"] == "attached"


def formation_reply(ids, name="Cache deployment"):
    return {
        "clusters": [
            {
                "episode_ids": ids,
                "domain": "project",
                "name": name,
                "independently_deliverable": True,
                "affects_existing_decisions": False,
            }
        ]
    }


def test_formation_prompt_follows_the_prd_same_work_rule():
    from memos.project_memory.add_algorithm import _FORMATION

    assert "互不影响、可分别交付的规则必须分别建 cluster" in _FORMATION
    assert "同一功能或产出物的多个设置与子问题属于同一项工作" in _FORMATION
    assert "same_conversation 只说明发生在同一会话" in _FORMATION
    assert "拿不准时拆开" in _FORMATION


def test_formation_links_ignore_phrasing_shared_by_most_summaries():
    from memos.project_memory.add_algorithm import _formation_links

    template = " confirmed rule statement only"
    episodes = [
        episode("a", episode_summary="tire tread depth" + template),
        episode("b", episode_summary="fuel card payment" + template),
        episode("c", episode_summary="insurance renewal date" + template),
        episode("d", episode_summary="tire tread depth replacement" + template),
    ]
    pairs = {tuple(link["episode_ids"]): link["signals"] for link in _formation_links(episodes)}
    assert "similar_summary" in pairs[("a", "d")]
    assert "similar_summary" not in pairs[("a", "b")]
    assert pairs[("a", "b")] == ["same_conversation"]


def test_formation_does_not_join_episodes_linked_only_by_conversation():
    new = episode("new", episode_summary="tire tread depth")
    old = episode("old", episode_summary="fuel card payment", staged_at=NOW - timedelta(hours=3))
    writer = Writer([formation_reply(["new", "old"])])
    plan = organize_episode(
        writer,
        new,
        [],
        [old],
        {"staged_since_last_formation": 3, "last_formation_at": NOW - timedelta(hours=3)},
        now=NOW,
    )
    assert plan["assignments"] == []
    assert {u["episode_id"]: u["status"] for u in plan["staged_updates"]}["old"] == "active"


def _formation_plan(writer, new, staged, candidates=(), all_topics=None):
    return organize_episode(
        writer,
        new,
        list(candidates),
        staged,
        {"staged_since_last_formation": 3, "last_formation_at": NOW - timedelta(hours=3)},
        now=NOW,
        all_topics=all_topics,
    )


def test_formation_records_why_each_cluster_was_rejected():
    new = episode("new", episode_summary="tire tread depth")
    old = episode("old", episode_summary="fuel card payment", staged_at=NOW - timedelta(hours=3))
    lone = episode("lone", staged_at=NOW - timedelta(hours=3))
    reply = formation_reply(["new", "old"])
    reply["clusters"].append({**reply["clusters"][0], "episode_ids": ["lone"], "name": "x" * 40})
    plan = _formation_plan(Writer([reply]), new, [old, lone])
    assert plan["assignments"] == []
    assert plan["formation"]["rejected"] == [
        {"episode_ids": ["new", "old"], "reason": "unlinked_episode"},
        {"episode_ids": ["lone"], "reason": "invalid_name"},
    ]


def test_formation_accepts_a_specific_name_longer_than_twenty_characters():
    new = episode("new")
    old = episode("old", staged_at=NOW - timedelta(hours=3))
    name = "Validated.combine_n 多值组合"
    plan = _formation_plan(Writer([formation_reply(["new", "old"], name=name)]), new, [old])
    (assignment,) = plan["assignments"]
    assert assignment["topic"]["topic_name"] == name
    assert "rejected" not in plan["formation"]


def test_formation_attaches_a_cluster_to_an_existing_topic_every_member_recalled():
    existing = topic("combine", "project", name="Cache rollout")
    new = episode("new")
    old = episode("old", staged_at=NOW - timedelta(hours=3))
    reply = {"clusters": [{"episode_ids": ["new", "old"], "topic_id": "combine"}]}
    writer = Writer(
        [{"action": "stage"}, {"assignments": [{"episode_id": "old", "action": "stage"}]}, reply]
    )
    candidates = recall_candidates(new, [existing])
    plan = _formation_plan(writer, new, [old], candidates, all_topics=[existing])
    (assignment,) = plan["assignments"]
    assert assignment["topic"]["id"] == "combine"
    assert assignment["topic"]["version"] == 1
    assert {row["id"] for row in assignment["episodes"]} == {"new", "old"}
    assert {u["episode_id"]: u["status"] for u in plan["staged_updates"]}["old"] == "moved"


def test_formation_rejects_an_existing_topic_not_recalled_by_every_member():
    existing = topic("combine", "project", name="Cache rollout")
    new = episode("new")
    old = episode(
        "old", domains=["other"], episode_summary="unrelated", staged_at=NOW - timedelta(hours=3)
    )
    reply = {"clusters": [{"episode_ids": ["new", "old"], "topic_id": "combine"}]}
    writer = Writer([{"action": "stage"}, reply])
    candidates = recall_candidates(new, [existing])
    plan = _formation_plan(writer, new, [old], candidates, all_topics=[existing])
    assert plan["assignments"] == []
    assert plan["formation"]["rejected"] == [
        {"episode_ids": ["new", "old"], "reason": "topic_not_recalled"}
    ]


def test_formation_prompt_offers_attaching_to_existing_topics():
    from memos.project_memory.add_algorithm import _FORMATION

    assert "topic_id" in _FORMATION
    assert "无法独立交付的组保留在默认主题" not in _FORMATION


@pytest.mark.parametrize("prompt", [_ASSIGN, _ASSIGN_BATCH], ids=["direct", "batch"])
def test_assignment_prompt_requires_the_same_deliverable(prompt):
    assert "same_deliverable" in prompt
    assert "episode_deliverable" in prompt
    assert "连续的请求常常已转到下一项工作" in prompt


@pytest.mark.parametrize("judged", [False, None, "true"], ids=["false", "missing", "text"])
def test_attach_needs_an_explicit_same_deliverable_judgment(judged):
    target = topic("prior", "project")
    current = episode("new", previous={"result": {"topic_ids": ["prior"]}})
    reply = {
        "action": "attach",
        "topic_id": "prior",
        "relationship": "same_work",
        "positive_basis": "previous_episode",
        "independently_deliverable": False,
        "affects_existing_decisions": True,
    }
    if judged is not None:
        reply["same_deliverable"] = judged
    plan = organize_episode(
        Writer([reply]),
        current,
        recall_candidates(current, [target]),
        [],
        {"staged_since_last_formation": 0, "last_formation_at": NOW},
        now=NOW,
    )
    assert plan["assignments"] == []
    assert plan["staging"]["reason"] == "NO_CONFIRMED_TOPIC"


def test_formation_prompt_separates_deliverables_in_one_module():
    from memos.project_memory.add_algorithm import _FORMATION

    assert "交付对象和验收条件不同" in _FORMATION


def test_formation_due_covers_a_quiet_space_after_the_interval():
    from memos.project_memory.add_algorithm import formation_due

    staged = [episode("old", staged_at=NOW - timedelta(hours=1))]
    quiet = {"staged_since_last_formation": 1, "last_formation_at": NOW - timedelta(hours=3)}
    recent = {"staged_since_last_formation": 1, "last_formation_at": NOW - timedelta(minutes=5)}
    full = {"staged_since_last_formation": 10, "last_formation_at": NOW}
    due = {"formation_count": 10, "formation_interval": 7200}
    assert formation_due(quiet, staged, NOW, **due)
    assert not formation_due(recent, staged, NOW, **due)
    assert formation_due(full, staged, NOW, **due)
    assert not formation_due(quiet, [], NOW, **due)


def test_organize_staged_forms_topics_without_a_carrier_episode():
    from memos.project_memory.add_algorithm import organize_staged

    first = episode("first", staged_at=NOW - timedelta(hours=3), staged_attempts=1)
    second = episode("second", staged_at=NOW - timedelta(hours=2))
    lone = episode("lone", episode_summary="fuel card payment", staged_at=NOW)
    foreign = episode("foreign", space_id="other-space")
    writer = Writer([formation_reply(["first", "second"])])
    space = {"id": "space", "formation_version": 3, "staged_since_last_formation": 3}
    plan = organize_staged(writer, [first, second, lone, foreign], space, [], now=NOW)
    assert [scope for scope, _ in writer.calls] == ["episode.formation"]
    assert plan["episode_id"] is None and plan["staging"] is None
    (assignment,) = plan["assignments"]
    assert {row["id"] for row in assignment["episodes"]} == {"first", "second"}
    updates = {u["episode_id"]: (u["status"], u["attempts"]) for u in plan["staged_updates"]}
    assert updates == {"first": ("moved", 2), "second": ("moved", 1), "lone": ("active", 1)}
    assert plan["formation"] == {"version": 3, "consumed": 3}


def test_organize_staged_keeps_the_plan_when_formation_is_unavailable():
    from memos.project_memory.add_algorithm import organize_staged

    writer = Writer([ModelError("down")])
    plan = organize_staged(writer, [episode("a", staged_at=NOW)], {"id": "space"}, [], now=NOW)
    assert plan["formation"] is None
    assert plan["staged_updates"] == []
    assert plan["warnings"] == ["FORMATION_MODEL_UNAVAILABLE"]
