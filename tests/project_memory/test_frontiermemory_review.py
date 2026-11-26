import sys

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from evaluation.frontiermemory_topic import review, score  # noqa: E402


def _turn(turn_id, user, work):
    return {
        "turn_id": turn_id,
        "user_id": user,
        "conversation_id": f"c-{user}",
        "source_task": "task",
        "gold_work": work,
        "messages": [{"role": "user", "message_id": turn_id, "content": f"Request {turn_id}"}],
    }


def _scored():
    manifest = {
        "turns": [
            _turn("a1", "u1", "alpha"),
            _turn("b1", "u2", "beta"),
            _turn("c1", "u1", "gamma"),
            _turn("c2", "u2", "gamma"),
            _turn("d1", "u1", "delta"),
        ]
    }
    topics = {"a1": ["merged"], "b1": ["merged"], "c1": ["g1"], "c2": ["g2"], "d1": ["solo"]}
    replay = {
        "turns": [
            {
                "turn_id": tid,
                "topic_ids": ids,
                "witness_topic_ids": [],
                "status": "assigned",
            }
            for tid, ids in topics.items()
        ],
        "topics": [{"topic_id": t, "name": f"Topic {t}"} for t in ("merged", "g1", "g2", "solo")],
    }
    return manifest, score.score_replay(manifest, replay)


def test_review_lists_each_allowed_merge_and_split_without_gold_labels():
    manifest, scored = _scored()
    cases = review.review_cases(scored, manifest)
    assert [(c["kind"], c["tasks"]) for c in cases] == [
        ("merge", ["alpha", "beta"]),
        ("split", ["gamma"]),
    ]
    assert "alpha" not in str(cases[0]["input"]) and "gamma" not in str(cases[1]["input"])
    assert cases[0]["input"]["groups"] == [["Request a1"], ["Request b1"]]


def test_reviewed_rate_drops_tasks_behind_an_unreasonable_boundary():
    _, scored = _scored()
    verdicts = [
        {"kind": "merge", "tasks": ["alpha", "beta"], "verdict": "unreasonable"},
        {"kind": "split", "tasks": ["gamma"], "verdict": "reasonable"},
    ]
    rates = review.reviewed_rates(scored, verdicts)
    assert rates["allow_split_or_merge_reviewed"] == {"correct": 2, "total": 4, "rate": 0.5}
    assert rates["rejected_tasks"] == ["alpha", "beta"]
