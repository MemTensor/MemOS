"""Score final Add Topic memberships against the two frozen pilot rubrics."""

from __future__ import annotations

import argparse
import json

from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any


_RUBRICS = ("source_task", "gold_work")
_STATUSES = {"assigned", "staged", "no_drafts", "failed", "unassigned", "pending", "missing"}
_RESULT_DETAILS = (
    "episode_id",
    "stage",
    "outcome",
    "extract_status",
    "close_reason",
    "staged_status",
    "staged_reason",
    "moved_to_topic_id",
    "error",
    "warnings",
)


def _index(document: dict[str, Any], key: str, id_key: str) -> dict[str, dict[str, Any]]:
    rows = document.get(key) if isinstance(document, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"Expected an object with a {key} array")
    indexed = {}
    for row in rows:
        row_id = row.get(id_key) if isinstance(row, dict) else None
        if not isinstance(row_id, str) or not row_id.strip():
            raise ValueError(f"Each {key} row needs a non-empty {id_key}")
        if row_id in indexed:
            raise ValueError(f"Found duplicate {id_key}: {row_id}")
        indexed[row_id] = row
    return indexed


def _topic_ids(turn: dict[str, Any], key: str, topics: dict[str, Any]) -> list[str]:
    ids = turn.get(key)
    if not isinstance(ids, list) or any(not isinstance(item, str) or not item for item in ids):
        raise ValueError(f"Turn {turn['turn_id']} needs a {key} string array")
    unknown = sorted(set(ids) - topics.keys())
    if unknown:
        raise ValueError(f"Turn {turn['turn_id']} has unknown Topic IDs in {key}: {unknown}")
    return sorted(set(ids))


def _join_turns(manifest: dict, replay: dict, topics: dict) -> list[dict]:
    gold = _index(manifest, "turns", "turn_id")
    predictions = _index(replay, "turns", "turn_id")
    if not gold:
        raise ValueError("Manifest must contain at least one Turn")
    if unknown := sorted(predictions.keys() - gold.keys()):
        raise ValueError(f"Replay contains unknown Turn IDs: {unknown}")

    joined = []
    for turn_id, label in gold.items():
        for key in ("user_id", *_RUBRICS):
            if not isinstance(label.get(key), str) or not label[key].strip():
                raise ValueError(f"Manifest Turn {turn_id} needs a non-empty {key}")
        prediction = predictions.get(turn_id)
        if prediction is None:
            status, topic_ids, witnesses = "missing", [], []
            prediction = {}
        else:
            status = prediction.get("status")
            if not isinstance(status, str) or status not in _STATUSES:
                raise ValueError(f"Turn {turn_id} has unknown status {status!r}")
            topic_ids = _topic_ids(prediction, "topic_ids", topics)
            witnesses = _topic_ids(prediction, "witness_topic_ids", topics)
            if (status == "assigned") != bool(topic_ids):
                raise ValueError(f"Turn {turn_id} has inconsistent status and Topic membership")

        joined.append(
            {
                "turn_id": turn_id,
                "user_id": label["user_id"],
                "source_task": label["source_task"],
                "gold_work": label["gold_work"],
                "conversation_id": label.get("conversation_id"),
                "trace_url": label.get("trace_url"),
                "source_ordinal": label.get("source_ordinal"),
                **{key: prediction[key] for key in _RESULT_DETAILS if key in prediction},
                "status": status,
                "topic_ids": topic_ids,
                "witness_topic_ids": witnesses,
            }
        )
    return joined


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _turn_counts(turns: list[dict]) -> dict[str, Any]:
    assignments = [set(turn["topic_ids"]) for turn in turns]
    witnesses = [set(turn["witness_topic_ids"]) for turn in turns]
    memberships = list(zip(assignments, witnesses, strict=True))
    assigned = sum(bool(ids) for ids in assignments)
    return {
        "total": len(turns),
        "assigned": assigned,
        "unassigned": len(turns) - assigned,
        "assignment_coverage": _ratio(assigned, len(turns)),
        "multi_topic": sum(len(ids) > 1 for ids in assignments),
        "extra_topic_assignments": sum(max(0, len(ids) - 1) for ids in assignments),
        "witnessed": sum(bool(ids & refs) for ids, refs in memberships),
        "fully_witnessed": sum(bool(ids) and ids <= refs for ids, refs in memberships),
        "witnessed_outside_assignment": sum(bool(refs - ids) for ids, refs in memberships),
        "statuses": dict(sorted(Counter(turn["status"] for turn in turns).items())),
    }


def _group_coverage(turns: list[dict], gold_field: str) -> dict[str, Any]:
    groups = defaultdict(list)
    for turn in turns:
        groups[turn[gold_field]].append(turn)

    output = {}
    for gold, group in sorted(groups.items()):
        counts = Counter(topic_id for turn in group for topic_id in turn["topic_ids"])
        top = max(counts.values(), default=0)
        output[gold] = {
            "turn_count": len(group),
            "dominant_topic_ids": sorted(topic for topic, count in counts.items() if count == top),
            "dominant_topic_turn_count": top,
            "dominant_topic_coverage": top / len(group),
            "topic_turn_counts": dict(sorted(counts.items())),
            "unassigned_turn_count": sum(not turn["topic_ids"] for turn in group),
        }
    return output


def _pair_records(turns: list[dict]) -> list[dict]:
    records = []
    for left, right in combinations(turns, 2):
        if left["user_id"] == right["user_id"]:
            continue
        records.append(
            {
                "left_turn_id": left["turn_id"],
                "right_turn_id": right["turn_id"],
                "shared_topic_ids": sorted(set(left["topic_ids"]).intersection(right["topic_ids"])),
                "both_assigned": bool(left["topic_ids"] and right["topic_ids"]),
                "same_source_task": left["source_task"] == right["source_task"],
                "same_gold_work": left["gold_work"] == right["gold_work"],
            }
        )
    return records


def _score_rubric(turns: list[dict], pairs: list[dict], gold_field: str) -> dict[str, Any]:
    tp = fp = tn = fn = 0
    errors = []
    for pair in pairs:
        gold_same = pair[f"same_{gold_field}"]
        predicted_same = bool(pair["shared_topic_ids"])
        if gold_same and predicted_same:
            tp += 1
        elif gold_same:
            fn += 1
            kind = "split" if pair["both_assigned"] else "unassigned"
            errors.append({**pair, "kind": kind})
        elif predicted_same:
            fp += 1
            errors.append({**pair, "kind": "merge"})
        else:
            tn += 1

    return {
        "pair_counts": {"total": len(pairs), "tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "precision": _ratio(tp, tp + fp),
        "recall": _ratio(tp, tp + fn),
        "f1": _ratio(2 * tp, 2 * tp + fp + fn),
        "false_merge_rate": _ratio(fp, fp + tn),
        "groups": _group_coverage(turns, gold_field),
        "errors": errors,
    }


def score_replay(manifest: dict[str, Any], replay: dict[str, Any]) -> dict[str, Any]:
    """Score cross-user pairs on the same replay, treating absent Turn rows as uncovered."""
    topics = _index(replay, "topics", "topic_id")
    turns = _join_turns(manifest, replay, topics)
    pairs = _pair_records(turns)
    return {
        "turn_counts": _turn_counts(turns),
        "rubrics": {field: _score_rubric(turns, pairs, field) for field in _RUBRICS},
        "rubric_disagreements": [
            pair for pair in pairs if pair["same_source_task"] != pair["same_gold_work"]
        ],
        "turns": turns,
        "topics": list(topics.values()),
    }


def main() -> int:
    """Read a frozen manifest and replay JSON, and write scoring JSON."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        replay = json.loads(args.results.read_text(encoding="utf-8"))
        report = score_replay(manifest, replay)
        args.out.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
