import pytest

from evaluation.frontiermemory_topic.replay import (
    observe_turn,
    request_for_turn,
    validate_work_limit,
    witness_index,
)


def test_work_limit_counts_distinct_gold_groups_before_replay():
    turns = [{"gold_work": f"work-{i}"} for i in range(100)]
    assert validate_work_limit([*turns, *turns]) == 100
    with pytest.raises(ValueError, match="100"):
        validate_work_limit([*turns, {"gold_work": "one-too-many"}])


def test_request_preserves_ids_but_does_not_send_gold_labels():
    turn = {
        "turn_id": "t1",
        "user_id": "u1",
        "conversation_id": "c1",
        "source_task": "tomlkit",
        "gold_work": "table-conversion",
        "messages": [
            {"message_id": "t1", "role": "user", "content": "Use two conversion helpers."},
            {"message_id": "a1", "role": "assistant", "content": "I'll implement them."},
        ],
    }

    request = request_for_turn(turn)

    assert request.user_id == "u1"
    assert request.conversation_id == "c1"
    assert request.task_id == "t1"
    assert request.messages == turn["messages"]
    assert not hasattr(request, "source_task")
    assert not hasattr(request, "gold_work")


def test_observation_counts_moved_episode_and_distinguishes_receipt_from_witness():
    topic = {
        "id": "formal",
        "decisions": [
            {
                "sources": [{"turn_ids": ["t2"]}],
                "history": [{"source_refs": [{"message_id": "reply1"}]}],
            }
        ],
    }
    witnessed = witness_index([topic], {"reply1": "t1"})
    assert witnessed == {"t1": {"formal"}, "t2": {"formal"}}

    row = {
        "turn_id": "t1",
        "episode_id": "episode1",
        "outcome": "staged",
        "result": {"topic_ids": ["old"]},
        "staged_status": "moved",
        "moved_to_topic_id": "formal",
    }
    observation = observe_turn(row, {"formal", "old"}, witnessed)

    assert observation["topic_ids"] == ["formal", "old"]
    assert observation["witness_topic_ids"] == ["formal"]
    assert observation["status"] == "assigned"


def test_observation_classifies_no_drafts_staging_pending_and_failure():
    row = {"turn_id": "t1", "episode_id": "episode1", "result": {}}

    assert observe_turn({**row, "outcome": "skipped"}, set(), {})["status"] == "no_drafts"
    assert observe_turn({**row, "outcome": "pending"}, set(), {})["status"] == "pending"
    assert observe_turn({**row, "outcome": "failed"}, set(), {})["status"] == "failed"
    assert (
        observe_turn({**row, "outcome": "staged", "staged_status": "active"}, set(), {})["status"]
        == "staged"
    )


def test_flush_space_retries_until_nothing_is_in_flight(monkeypatch):
    from collections import deque
    from unittest.mock import Mock

    from evaluation.frontiermemory_topic import replay as module

    runtime = Mock()
    runtime.flush.side_effect = [
        {"formation": {"ran": False, "reason": "EPISODES_IN_FLIGHT"}},
        {"formation": {"ran": True}},
    ]
    drained = []
    monkeypatch.setattr(module, "drain_work", lambda *args: drained.append(args))
    results = module.flush_space(runtime, deque(), Mock(), Mock())
    assert [r["formation"].get("ran") for r in results] == [False, True]
    assert len(drained) == 2
    runtime.flush.assert_called_with(module.SPACE)


def test_decision_positions_name_current_conflicting_and_superseded_sources():
    from evaluation.frontiermemory_topic.replay import decision_positions

    decision = {
        "id": "d1",
        "user_ids": ["bob"],
        "source": {"message_id": "m3"},
        "conflicts": [{"source": {"message_id": "m2"}}, {"source": {}}],
        "history": [{"source": {"message_id": "m1"}}],
    }
    assert decision_positions(decision) == {
        "decision_id": "d1",
        "current": "m3",
        "current_user_ids": ["bob"],
        "conflicts": ["m2"],
        "history": ["m1"],
    }
