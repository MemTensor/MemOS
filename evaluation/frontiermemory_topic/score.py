"""Score final Add Topic memberships against the two frozen pilot rubrics."""

from __future__ import annotations

import argparse
import json

from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any


_RUBRICS = ("source_task", "gold_work")
_ATTRIBUTION_RULES = ("strict_one_to_one", "allow_split", "allow_merge", "allow_split_or_merge")
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
                # Pure acknowledgements have nothing to remember and need no Topic.
                "memory_worthy": label.get("memory_worthy", True) is not False,
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


def _task_topic_attribution(turns: list[dict], gold_field: str) -> dict[str, Any]:
    task_topics: dict[str, set[str]] = defaultdict(set)
    topic_turns: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    unassigned: dict[str, list[dict[str, str]]] = defaultdict(list)
    for turn in turns:
        task, topic_ids = turn[gold_field], turn["topic_ids"]
        task_topics[task].update(topic_ids)
        if not topic_ids:
            unassigned[task].append(
                {
                    "turn_id": turn["turn_id"],
                    "status": turn["status"],
                    "memory_worthy": turn["memory_worthy"],
                }
            )
        for topic_id in topic_ids:
            topic_turns[topic_id][task].append(turn["turn_id"])

    tasks = {}
    counts: Counter[str] = Counter()
    full: Counter[str] = Counter()  # Every Turn of the Task also has a formal Topic.
    for task, topic_ids in sorted(task_topics.items()):
        shared = sorted(topic_id for topic_id in topic_ids if len(topic_turns[topic_id]) > 1)
        split_neighbors = sorted(
            {
                other
                for topic_id in shared
                for other in topic_turns[topic_id]
                if other != task and len(task_topics[other]) > 1
            }
        )
        if not topic_ids:
            shape = "unassigned"
        elif shared and (len(topic_ids) > 1 or split_neighbors):
            shape = "mixed"
        elif shared:
            shape = "merge"
        elif len(topic_ids) > 1:
            shape = "split"
        else:
            shape = "one_to_one"

        omitted = not topic_ids
        passes = {
            "strict_one_to_one": shape == "one_to_one",
            "allow_split": shape in {"one_to_one", "split"},
            "allow_merge": shape in {"one_to_one", "merge"},
            "allow_split_or_merge": shape in {"one_to_one", "split", "merge"},
        }
        counts.update(rule for rule, passed in passes.items() if passed)
        if not any(row["memory_worthy"] for row in unassigned[task]):
            full.update(rule for rule, passed in passes.items() if passed)
        tasks[task] = {
            "complete": not unassigned[task],
            "omitted": omitted,
            "shape": shape,
            "passes": passes,
            "topic_ids": sorted(topic_ids),
            "shared_topic_ids": shared,
            "split_neighbors": split_neighbors,
            "unassigned_turns": unassigned[task],
        }

    total = len(tasks)

    def rates(passed: Counter[str]) -> dict[str, dict[str, Any]]:
        return {
            rule: {"correct": passed[rule], "total": total, "rate": _ratio(passed[rule], total)}
            for rule in _ATTRIBUTION_RULES
        }

    return {
        "rates": rates(counts),
        "rates_full_coverage": rates(full),
        "tasks": tasks,
        "topic_turn_ids": {
            topic_id: {task: sorted(ids) for task, ids in sorted(rows.items())}
            for topic_id, rows in sorted(topic_turns.items())
        },
    }


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
        "task_topic_attribution": _task_topic_attribution(turns, gold_field),
        "errors": errors,
    }


def _positions(topics: dict[str, dict]) -> dict[str, list[dict[str, Any]]]:
    """Every decision position by source message: which Topic, decision and role holds it."""
    found: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for topic_id, topic in topics.items():
        for decision in topic.get("decisions") or []:
            roles = [("current", decision.get("current"))]
            roles += [("conflict", m) for m in decision.get("conflicts") or []]
            roles += [("history", m) for m in decision.get("history") or []]
            for role, message in roles:
                if message:
                    found[message].append(
                        {"topic_id": topic_id, "decision_id": decision["decision_id"], "role": role}
                    )
    return found


def _conflict_outcome(conflict: dict, order: dict[str, int], positions: dict) -> str:
    """Classify how a labelled conflict ended up in the committed decisions."""
    turns = sorted(conflict["turn_ids"], key=order.__getitem__)
    held = {turn: positions.get(turn, []) for turn in turns}
    if any(not rows for rows in held.values()):
        return "position_missing"
    decisions = set.intersection(*({row["decision_id"] for row in rows} for rows in held.values()))
    if not decisions:
        topics = set.intersection(*({row["topic_id"] for row in rows} for rows in held.values()))
        return "separate_decisions" if topics else "separate_topics"
    roles = {
        turn: {row["role"] for row in rows if row["decision_id"] in decisions}
        for turn, rows in held.items()
    }
    if all(role & {"current", "conflict"} for role in roles.values()):
        return "conflict_kept"
    if "current" in roles[turns[-1]] and all("history" in roles[t] for t in turns[:-1]):
        return "revised_to_latest"
    return "overwritten_otherwise"


# Who may change a decision: a member revises their own; another member's view stays open.
_EXPECTED_CONFLICT = {"cross_user": "conflict_kept", "same_user": "revised_to_latest"}


def _score_conflicts(manifest: dict, turns: list[dict], topics: dict) -> dict[str, Any]:
    order = {turn["turn_id"]: index for index, turn in enumerate(turns)}
    positions = _positions(topics)
    rows = []
    for conflict in manifest.get("conflicts") or []:
        outcome = _conflict_outcome(conflict, order, positions)
        expected = _EXPECTED_CONFLICT[conflict["kind"]]
        rows.append(
            {
                "id": conflict["id"],
                "gold_work": conflict["gold_work"],
                "kind": conflict["kind"],
                "outcome": outcome,
                "correct": outcome == expected,
                # Both views survive in one Topic, as a conflict or as two decisions.
                "both_retained": outcome in {"conflict_kept", "separate_decisions"},
            }
        )
    summary = {}
    for kind in _EXPECTED_CONFLICT:
        group = [row for row in rows if row["kind"] == kind]
        summary[kind] = {
            "total": len(group),
            "correct": sum(row["correct"] for row in group),
            "both_retained": sum(row["both_retained"] for row in group),
            "outcomes": dict(sorted(Counter(row["outcome"] for row in group).items())),
        }
    return {"summary": summary, "conflicts": rows}


def _subset_rates(attribution: dict, tasks: set[str]) -> dict[str, dict[str, Any]]:
    rows = [row for task, row in attribution["tasks"].items() if task in tasks]
    out = {}
    for key, needs_complete in (("rates", False), ("rates_full_coverage", True)):
        out[key] = {
            rule: {
                "correct": (
                    correct := sum(
                        row["passes"][rule] and (row["complete"] or not needs_complete)
                        for row in rows
                    )
                ),
                "total": len(rows),
                "rate": _ratio(correct, len(rows)),
            }
            for rule in _ATTRIBUTION_RULES
        }
    return out


def score_replay(manifest: dict[str, Any], replay: dict[str, Any]) -> dict[str, Any]:
    """Score cross-user pairs on the same replay, treating absent Turn rows as uncovered."""
    topics = _index(replay, "topics", "topic_id")
    turns = _join_turns(manifest, replay, topics)
    pairs = _pair_records(turns)
    rubrics = {field: _score_rubric(turns, pairs, field) for field in _RUBRICS}
    conflicts = _score_conflicts(manifest, turns, topics)
    contested = {row["gold_work"] for row in conflicts["conflicts"]}
    attribution = rubrics["gold_work"]["task_topic_attribution"]
    attribution["by_conflict"] = {
        "with_conflict": _subset_rates(attribution, contested),
        "without_conflict": _subset_rates(attribution, set(attribution["tasks"]) - contested),
    }
    return {
        "turn_counts": _turn_counts(turns),
        "rubrics": rubrics,
        "conflicts": conflicts,
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
