from html import escape

import pytest

from evaluation.frontiermemory_topic.expand2 import (
    ADDED_FIELDS,
    assign_waves,
    build_manifest,
    build_turn,
    same_user_variant,
    validate,
)


A = "https://frontiermemory.com/traces/task/a/"
B = "https://frontiermemory.com/traces/task/b/"
C = "https://frontiermemory.com/traces/other/c/"


def _page(*ordinals: int, user_only: tuple[int, ...] = ()) -> bytes:
    steps = []
    for ordinal in ordinals:
        roles = [("user", ordinal)] + ([] if ordinal in user_only else [("assistant", ordinal + 1)])
        for role, index in roles:
            steps.append(
                f'<article class="trace-step role-{role}">'
                f'<div class="trace-role"><span class="index">{index}</span></div>'
                f'<div class="trace-step-body"><section><pre>{escape(role)} {index}</pre>'
                "</section></div></article>"
            )
    return f'<div class="trace-full-view">{"".join(steps)}</div>'.encode()


PAGES = {A: _page(1, 3, 6, 9, user_only=(6,)), B: _page(2, 5), C: _page(1)}


def _base() -> dict:
    identities = {
        A: {"prefix": "fm-x01", "user_id": "u1", "conversation_id": "c1", "source_task": "t"},
        B: {"prefix": "fm-x02", "user_id": "u2", "conversation_id": "c2", "source_task": "t"},
    }
    turns = []
    for url, ordinal, wave in ((B, 5, 1), (A, 3, 1), (A, 9, 2)):
        label = {"wave": wave, "gold_work": "t-work", "memory_worthy": True}
        turn = build_turn(url, PAGES[url], ordinal, identities[url], label)
        turns.append({key: value for key, value in turn.items() if key not in ADDED_FIELDS})
    return {"frontiermemory_revision": "r", "seed": 1, "work_groups": {}, "turns": turns}


def test_waves_split_gaps_and_extend_the_tail_without_moving_old_turns():
    waves = assign_waves({10: 1, 20: 2}, [5, 12, 14, 15, 30, 40])
    assert waves == {10: 1, 20: 2, 5: 1, 12: 1, 14: 2, 15: 2, 30: 3, 40: 4}
    assert assign_waves({}, [4, 2]) == {2: 1, 4: 2}


def test_grown_manifest_keeps_base_turns_and_trajectory_order():
    base = _base()
    labels = {
        "base_manifest_sha256": "x",
        "base_memory_worthy": {"fm-x01-m009": False},
        "new_traces": [{"trace_url": C, "source_task": "other"}],
        "work_groups": {"t-other": {"source_task": "t", "why": "separate"}},
        "turns": [
            {"trace_url": A, "source_ordinal": 1, "gold_work": "t-work", "memory_worthy": True},
            {"trace_url": A, "source_ordinal": 6, "gold_work": "t-other", "memory_worthy": False},
            {"trace_url": B, "source_ordinal": 2, "gold_work": "t-work", "memory_worthy": True},
            {"trace_url": C, "source_ordinal": 1, "gold_work": "o-work", "memory_worthy": True},
        ],
        "conflicts": [
            {
                "id": "k1",
                "gold_work": "t-work",
                "item": "x",
                "turn_ids": ["fm-x01-m003", "fm-x02-m005"],
                "statements": {"fm-x01-m003": "a", "fm-x02-m005": "b"},
            }
        ],
    }
    manifest = build_manifest(base, labels, PAGES)
    validate(base, manifest)

    order = [(turn["turn_id"], turn["wave"]) for turn in manifest["turns"]]
    assert order[:5] == [
        ("fm-x02-m002", 1),
        ("fm-x02-m005", 1),
        ("fm-x01-m001", 1),
        ("fm-x01-m003", 1),
        ("fm-x03-m001", 1),
    ]
    assert order[5:] == [("fm-x01-m006", 2), ("fm-x01-m009", 2)]
    user_only = next(turn for turn in manifest["turns"] if turn["turn_id"] == "fm-x01-m006")
    assert [message["role"] for message in user_only["messages"]] == ["user"]
    old = next(turn for turn in manifest["turns"] if turn["turn_id"] == "fm-x01-m009")
    assert old["memory_worthy"] is False and old["label_source"] == "codex-frozen"
    assert manifest["conflicts"][0]["kind"] == "cross_user"
    assert old["conflict_ids"] == []

    variant = same_user_variant(manifest)
    validate(base, variant, same_user=True)
    assert {turn["user_id"] for turn in variant["turns"] if turn["source_task"] == "t"} == {"u2"}
    assert variant["conflicts"][0]["kind"] == "same_user"
    assert manifest["conflicts"][0]["kind"] == "cross_user"

    tampered = same_user_variant(manifest)
    tampered["turns"][1]["messages"][0]["content"] = "edited"
    with pytest.raises(ValueError, match="content hash"):
        validate(base, tampered, same_user=True)
