import importlib.util
import json
import subprocess
import sys

from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "evaluation/frontiermemory_topic/score.py"
SPEC = importlib.util.spec_from_file_location("frontiermemory_score", SCRIPT)
score = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(score)


def turn(turn_id, user_id, task, work):
    return {
        "turn_id": turn_id,
        "user_id": user_id,
        "conversation_id": f"conversation-{user_id}",
        "source_task": task,
        "gold_work": work,
        "trace_url": "https://example.com/trace",
        "source_ordinal": 1,
        "messages": [{"role": "user", "content": "Fictional evaluation input"}],
    }


def prediction(turn_id, topic_ids, *, witnesses=(), status="assigned"):
    return {
        "turn_id": turn_id,
        "episode_id": f"episode-{turn_id}",
        "topic_ids": list(topic_ids),
        "status": status,
        "witness_topic_ids": list(witnesses),
    }


def replay(turns, topic_ids=()):
    return {
        "turns": turns,
        "topics": [{"topic_id": topic_id, "name": topic_id} for topic_id in topic_ids],
    }


def test_frozen_pilot_pair_denominators_and_eight_gold_disagreements():
    families = {
        "conversion": ["public-api", "public-api", "release"],
        "validation": ["validation", "validation"],
        "sharding": ["sharding", "sharding", "sorting"],
    }
    turns = [
        turn(f"{task}-{attempt}-{index}", f"{task}-{attempt}", task, work)
        for task, work_groups in families.items()
        for attempt in (1, 2)
        for index, work in enumerate(work_groups)
    ]

    report = score.score_replay({"turns": turns}, replay([]))
    task = report["rubrics"]["source_task"]
    work = report["rubrics"]["gold_work"]

    assert task["pair_counts"] == {"total": 106, "tp": 0, "fp": 0, "fn": 22, "tn": 84}
    assert work["pair_counts"] == {"total": 106, "tp": 0, "fp": 0, "fn": 14, "tn": 92}
    assert len(report["rubric_disagreements"]) == 8
    assert report["turn_counts"]["statuses"] == {"missing": 16}
    assert task["precision"] is None
    assert task["recall"] == 0
    assert task["f1"] == 0


def test_score_counts_shared_topics_unassigned_turns_and_evidence():
    manifest = {
        "turns": [
            turn("a", "u1", "release", "compile"),
            turn("b", "u2", "release", "compile"),
            turn("c", "u3", "release", "publish"),
            turn("d", "u2", "support", "support"),
            turn("e", "u4", "release", "compile"),
        ]
    }
    result = replay(
        [
            prediction("a", ("compile",), witnesses=("compile", "support")),
            prediction("b", ("support", "compile"), witnesses=("compile",)),
            prediction("c", (), status="staged"),
            prediction("d", ("support",)),
        ],
        ("compile", "support"),
    )

    report = score.score_replay(manifest, result)
    work = report["rubrics"]["gold_work"]

    assert work["pair_counts"] == {"total": 9, "tp": 1, "fp": 0, "fn": 2, "tn": 6}
    assert work["recall"] == pytest.approx(1 / 3)
    assert work["false_merge_rate"] == 0
    assert work["f1"] == 0.5
    assert work["groups"]["compile"] == {
        "turn_count": 3,
        "dominant_topic_ids": ["compile"],
        "dominant_topic_turn_count": 2,
        "dominant_topic_coverage": pytest.approx(2 / 3),
        "topic_turn_counts": {"compile": 2, "support": 1},
        "unassigned_turn_count": 1,
    }
    assert work["groups"]["publish"]["dominant_topic_ids"] == []
    assert work["groups"]["publish"]["dominant_topic_coverage"] == 0
    assert report["turn_counts"] == {
        "total": 5,
        "assigned": 3,
        "unassigned": 2,
        "assignment_coverage": 0.6,
        "multi_topic": 1,
        "extra_topic_assignments": 1,
        "witnessed": 2,
        "fully_witnessed": 1,
        "witnessed_outside_assignment": 1,
        "statuses": {"assigned": 3, "missing": 1, "staged": 1},
    }
    assert [
        (pair["left_turn_id"], pair["right_turn_id"], pair["kind"]) for pair in work["errors"]
    ] == [
        ("a", "e", "unassigned"),
        ("b", "e", "unassigned"),
    ]
    assert "messages" not in report["turns"][0]


def test_split_merge_and_undefined_metrics():
    items = [
        turn("a", "u1", "left", "exact"),
        turn("b", "u2", "left", "exact"),
        turn("c", "u3", "right", "another"),
    ]
    result = replay(
        [prediction("a", ("one",)), prediction("b", ("two",)), prediction("c", ("one",))],
        ("one", "two"),
    )

    work = score.score_replay({"turns": items}, result)["rubrics"]["gold_work"]

    assert work["false_merge_rate"] == 0.5
    assert [pair["kind"] for pair in work["errors"]] == ["split", "merge"]
    assert work["groups"]["exact"]["dominant_topic_ids"] == ["one", "two"]

    work = score.score_replay({"turns": items[:1]}, replay([]))["rubrics"]["gold_work"]
    assert all(work[field] is None for field in ("precision", "recall", "f1", "false_merge_rate"))


@pytest.mark.parametrize(
    "predictions,topic_ids,error",
    [
        ([prediction("unknown", ())], (), "unknown Turn"),
        ([prediction("a", ()), prediction("a", ())], (), "duplicate turn_id"),
        ([prediction("a", ("unknown",))], ("known",), "unknown Topic"),
        ([prediction("a", ("known",), witnesses=("external",))], ("known",), "unknown Topic"),
        ([prediction("a", (), status="assigned")], (), "inconsistent status"),
    ],
)
def test_malformed_predictions_fail_closed(predictions, topic_ids, error):
    manifest = {"turns": [turn("a", "u1", "task", "work")]}

    with pytest.raises(ValueError, match=error):
        score.score_replay(manifest, replay(predictions, topic_ids))


def test_cli_reads_one_replay_and_writes_both_rubrics(tmp_path):
    manifest_path = tmp_path / "pilot.json"
    replay_path = tmp_path / "replay.json"
    score_path = tmp_path / "score.json"
    manifest_path.write_text(json.dumps({"turns": [turn("a", "u1", "task", "work")]}))
    replay_path.write_text(json.dumps(replay([])))

    subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--manifest",
            str(manifest_path),
            "--results",
            str(replay_path),
            "--out",
            str(score_path),
        ],
        check=True,
    )

    report = json.loads(score_path.read_text())
    assert set(report["rubrics"]) == {"source_task", "gold_work"}
    assert report["turns"][0]["status"] == "missing"
