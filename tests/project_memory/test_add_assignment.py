from datetime import datetime, timedelta, timezone

from memos.project_memory.add_algorithm import organize_episode, recall_candidates


NOW = datetime(2026, 11, 19, tzinfo=timezone.utc)


class Writer:
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.calls = []

    def write(self, scope, _prompt, inputs):
        self.calls.append((scope, inputs))
        return next(self.outputs)


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


def test_recall_preserves_predecessor_and_does_not_expose_other_domains_or_drafts():
    ep = episode("new", previous={"result": {"topic_ids": ["prior"]}})
    ranked = recall_candidates(
        ep,
        [
            topic("excluded", "other"),
            topic("top", "project"),
            topic("prior", "project", "Unrelated title"),
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
                "positive_basis": "previous_episode",
                "independently_deliverable": False,
                "affects_existing_decisions": True,
            }
        ]
    )
    plan = organize_episode(writer, ep, ranked, [], {}, now=NOW)
    assert plan["assignments"][0]["topic"]["id"] == "prior"
    assert "secret draft content" not in str(writer.calls[0][1])


def test_name_only_match_is_staged():
    ep = episode("new")
    writer = Writer(
        [
            {
                "action": "attach",
                "topic_id": "top",
                "relationship": "same_work",
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
