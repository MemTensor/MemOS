"""Grow a frozen expanded manifest with the rest of its trajectories and reviewed labels.

The base manifest stays byte-for-byte intact apart from added annotation fields. New Turns
reuse their trajectory's simulated user, conversation and Turn ID prefix, and are slotted
into waves without reordering any existing Turn.
"""

from __future__ import annotations

import argparse
import json
import random

from collections import defaultdict
from hashlib import sha256
from pathlib import Path
from typing import Any

from .dataset import SourceMessage, _content_sha256, fetch_trace, parse_trace
from .replay import request_for_turn, validate_work_limit
from .score import score_replay


SEED = 20261124
TRACE_ROOT = "https://frontiermemory.com/traces/"
MAX_TURNS = 190
ADDED_FIELDS = ("memory_worthy", "label_source", "label_note", "conflict_ids")


def page_path(pages_dir: Path, url: str) -> Path:
    """Store each public trace page as ``<task>_<trace>.html``."""
    if not url.startswith(TRACE_ROOT) or not url.endswith("/"):
        raise ValueError(f"Expected an official public trace URL, got {url}")
    parent, leaf = url[len(TRACE_ROOT) : -1].split("/")
    if "_" in parent:
        raise ValueError(f"Trace task directory cannot be stored unambiguously: {parent}")
    return pages_dir / f"{parent}_{leaf}.html"


def load_pages(pages_dir: Path, urls: list[str], *, fetch: bool = False) -> dict[str, bytes]:
    """Read frozen pages, optionally downloading the ones that are missing."""
    pages = {}
    for url in urls:
        path = page_path(pages_dir, url)
        if not path.exists():
            if not fetch:
                raise FileNotFoundError(f"Missing frozen page for {url}: {path}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(fetch_trace(url))
        pages[url] = path.read_bytes()
    return pages


def trajectories(turns: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Describe each trajectory of the base manifest by its stable identities."""
    output: dict[str, dict[str, Any]] = {}
    for turn in turns:
        index = turn["turn_id"].split("-m")[0]
        info = output.setdefault(
            turn["trace_url"],
            {
                "prefix": index,
                "user_id": turn["user_id"],
                "conversation_id": turn["conversation_id"],
                "source_task": turn["source_task"],
                "trace_content_sha256": turn["trace_content_sha256"],
                "waves": {},
            },
        )
        for key in ("prefix", "user_id", "conversation_id", "source_task"):
            if info[key] != (index if key == "prefix" else turn[key]):
                raise ValueError(f"Trajectory {turn['trace_url']} has inconsistent {key}")
        info["waves"][turn["source_ordinal"]] = turn["wave"]
    return output


def missing_ordinals(base_turns: list[dict[str, Any]], url: str, html: bytes) -> list[int]:
    """Return parsed user Turn ordinals of a base trajectory that were not replayed."""
    selected = {turn["source_ordinal"] for turn in base_turns if turn["trace_url"] == url}
    return sorted(set(parse_trace(html)) - selected)


def assign_waves(existing: dict[int, int], ordinals: list[int]) -> dict[int, int]:
    """Give new ordinals waves so the trajectory order holds and old waves never move.

    Turns before the first existing Turn join its wave; a gap between two existing Turns
    is split between their waves; Turns after the last one get one new wave each.
    """
    anchors = sorted(existing.items())
    if [wave for _, wave in anchors] != sorted(wave for _, wave in anchors):
        raise ValueError("Existing waves must increase with source order")
    waves = dict(existing)
    new = sorted(set(ordinals) - existing.keys())
    if not anchors:
        waves.update({ordinal: number for number, ordinal in enumerate(new, 1)})
        return waves
    gaps: dict[int, list[int]] = defaultdict(list)
    for ordinal in new:
        gaps[sum(anchor < ordinal for anchor, _ in anchors)].append(ordinal)
    for position, gap in gaps.items():
        if position == 0:
            waves.update(dict.fromkeys(gap, anchors[0][1]))
        elif position == len(anchors):
            last = anchors[-1][1]
            waves.update({ordinal: last + offset for offset, ordinal in enumerate(gap, 1)})
        else:
            split = len(gap) // 2
            waves.update(dict.fromkeys(gap[:split], anchors[position - 1][1]))
            waves.update(dict.fromkeys(gap[split:], anchors[position][1]))
    return waves


def build_turn(
    url: str, html: bytes, ordinal: int, identity: dict[str, Any], label: dict[str, Any]
) -> dict[str, Any]:
    """Freeze one parsed Turn with the trajectory's identities and its reviewed label."""
    trace = parse_trace(html)
    dialogue = trace.get(ordinal)
    if not dialogue:
        raise ValueError(f"Source trace has no user Turn at {url} {ordinal}")
    trace_hash = _content_sha256([message for group in trace.values() for message in group])
    if identity.get("trace_content_sha256", trace_hash) != trace_hash:
        raise ValueError(f"Dialogue drifted since the base manifest was frozen: {url}")
    messages = [
        {
            "role": message.role,
            "content": message.content,
            "message_id": f"{identity['prefix']}-m{message.ordinal:03}",
        }
        for message in dialogue
    ]
    turn = {
        "turn_id": messages[0]["message_id"],
        "conversation_id": identity["conversation_id"],
        "user_id": identity["user_id"],
        "wave": label["wave"],
        "source_task": identity["source_task"],
        "gold_work": label["gold_work"],
        "trace_url": url,
        "trace_sha256": sha256(html).hexdigest(),
        "trace_content_sha256": trace_hash,
        "content_sha256": _content_sha256(dialogue),
        "source_ordinal": ordinal,
        "source_message_ordinals": [message.ordinal for message in dialogue],
        "messages": messages,
        "memory_worthy": label["memory_worthy"],
        "label_source": label.get("label_source", "haiku+review"),
    }
    if label.get("label_note"):
        turn["label_note"] = label["label_note"]
    return turn


def order_turns(
    base_turns: list[dict[str, Any]], new_turns: list[dict[str, Any]], *, seed: int = SEED
) -> list[dict[str, Any]]:
    """Merge new Turns into wave blocks, keeping existing Turns in their relative order."""
    by_slot: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for turn in [*base_turns, *new_turns]:
        by_slot[(turn["wave"], turn["trace_url"])].append(turn)
    for slot in by_slot.values():
        slot.sort(key=lambda turn: turn["source_ordinal"])
    ordered = []
    for wave in sorted({turn["wave"] for turn in [*base_turns, *new_turns]}):
        anchored = [turn["trace_url"] for turn in base_turns if turn["wave"] == wave]
        if len(anchored) != len(set(anchored)):
            raise ValueError(f"Wave {wave} holds two base Turns of one trajectory")
        rest = sorted(
            {url for (number, url) in by_slot if number == wave} - set(anchored),
        )
        random.Random(seed + wave).shuffle(rest)
        for url in [*anchored, *rest]:
            ordered.extend(by_slot[(wave, url)])
    return ordered


def annotate_base(turn: dict[str, Any], memory_worthy: bool) -> dict[str, Any]:
    """Append annotation fields to a frozen Turn without touching its existing keys."""
    return {**turn, "memory_worthy": memory_worthy, "label_source": "codex-frozen"}


def attach_conflicts(turns: list[dict[str, Any]], conflicts: list[dict[str, Any]]) -> None:
    """Classify conflicts by distinct users and record their IDs on member Turns."""
    by_id = {turn["turn_id"]: turn for turn in turns}
    for turn in turns:
        turn["conflict_ids"] = []
    for conflict in conflicts:
        members = [by_id[turn_id] for turn_id in conflict["turn_ids"]]
        if {turn["gold_work"] for turn in members} != {conflict["gold_work"]}:
            raise ValueError(f"Conflict {conflict['id']} spans other gold work")
        if set(conflict["statements"]) != set(conflict["turn_ids"]) or len(members) < 2:
            raise ValueError(f"Conflict {conflict['id']} needs one statement per Turn")
        users = {turn["user_id"] for turn in members}
        conflict["kind"] = "cross_user" if len(users) > 1 else "same_user"
        for turn in members:
            turn["conflict_ids"].append(conflict["id"])


def build_manifest(
    base: dict[str, Any], labels: dict[str, Any], pages: dict[str, bytes]
) -> dict[str, Any]:
    """Return the grown manifest: annotated base Turns, labelled new Turns and conflicts."""
    base_turns = base["turns"]
    identities = trajectories(base_turns)
    worthy = labels.get("base_memory_worthy", {})
    unknown = set(worthy) - {turn["turn_id"] for turn in base_turns}
    if unknown:
        raise ValueError(f"Unknown base Turns in memory_worthy overrides: {sorted(unknown)}")

    next_index = max(int(info["prefix"].split("-x")[1]) for info in identities.values())
    for trace in labels.get("new_traces", []):
        next_index += 1
        identities[trace["trace_url"]] = {
            "prefix": f"fm-x{next_index:02}",
            "user_id": f"fm-expanded-user-{next_index:02}",
            "conversation_id": f"fm-expanded-conversation-{next_index:02}",
            "source_task": trace["source_task"],
            "waves": {},
        }

    by_url: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for label in labels["turns"]:
        by_url[label["trace_url"]].append(label)
    new_turns = []
    for url, rows in by_url.items():
        info = identities[url]
        ordinals = [row["source_ordinal"] for row in rows]
        if set(ordinals) & info["waves"].keys() or len(set(ordinals)) != len(ordinals):
            raise ValueError(f"New labels repeat a selected Turn of {url}")
        waves = assign_waves(info["waves"], ordinals)
        for row in rows:
            row = {**row, "wave": waves[row["source_ordinal"]]}
            new_turns.append(build_turn(url, pages[url], row["source_ordinal"], info, row))

    annotated = [annotate_base(turn, worthy.get(turn["turn_id"], True)) for turn in base_turns]
    turns = order_turns(annotated, new_turns)
    conflicts = [dict(conflict) for conflict in labels.get("conflicts", [])]
    attach_conflicts(turns, conflicts)
    work_groups = dict(base["work_groups"])
    for work, metadata in labels.get("work_groups", {}).items():
        if work in work_groups:
            raise ValueError(f"Work group {work} already exists")
        work_groups[work] = metadata
    return {
        "frontiermemory_revision": base["frontiermemory_revision"],
        "seed": base["seed"],
        "expansion_seed": SEED,
        "base_manifest_sha256": labels["base_manifest_sha256"],
        "work_groups": work_groups,
        "turns": turns,
        "conflicts": conflicts,
    }


def same_user_variant(manifest: dict[str, Any]) -> dict[str, Any]:
    """Give every source task the user of its first trajectory, keeping conversations."""
    first_user: dict[str, str] = {}
    for turn in manifest["turns"]:
        first_user.setdefault(turn["source_task"], turn["user_id"])
    variant = json.loads(json.dumps(manifest))
    for turn in variant["turns"]:
        turn["user_id"] = first_user[turn["source_task"]]
    for conflict in variant["conflicts"]:
        conflict["kind"] = "same_user"
    variant["user_mapping"] = "one simulated user per source_task"
    return variant


def validate(base: dict[str, Any], manifest: dict[str, Any], *, same_user: bool = False) -> None:
    """Check replay and scoring contracts plus the integrity of every base Turn."""
    turns = manifest["turns"]
    if len(turns) > MAX_TURNS:
        raise ValueError(f"Manifest has {len(turns)} Turns, above {MAX_TURNS}")
    validate_work_limit(turns)
    requests = [request_for_turn(turn) for turn in turns]
    if len({request.task_id for request in requests}) != len(turns):
        raise ValueError("Turn IDs must be unique")
    waves = [turn["wave"] for turn in turns]
    if waves != sorted(waves):
        raise ValueError("Waves must not decrease in manifest order")
    last: dict[str, int] = {}
    for turn in turns:
        if turn["source_ordinal"] <= last.get(turn["trace_url"], 0):
            raise ValueError(f"Trajectory order broken at {turn['turn_id']}")
        last[turn["trace_url"]] = turn["source_ordinal"]
        if not isinstance(turn.get("memory_worthy"), bool):
            raise ValueError(f"Turn {turn['turn_id']} needs memory_worthy")
        expected = _content_sha256(
            [SourceMessage(0, message["role"], message["content"]) for message in turn["messages"]]
        )
        if expected != turn["content_sha256"]:
            raise ValueError(f"Turn {turn['turn_id']} content hash does not match")

    current = {turn["turn_id"]: turn for turn in turns}
    for old in base["turns"]:
        new = current.get(old["turn_id"])
        if new is None:
            raise ValueError(f"Base Turn {old['turn_id']} is missing")
        kept = {key: value for key, value in new.items() if key not in ADDED_FIELDS}
        if same_user:
            kept["user_id"] = old["user_id"]
        if json.dumps(kept, ensure_ascii=False) != json.dumps(old, ensure_ascii=False):
            raise ValueError(f"Base Turn {old['turn_id']} changed")

    conflict_ids = {conflict["id"] for conflict in manifest["conflicts"]}
    for conflict in manifest["conflicts"]:
        users = {current[turn_id]["user_id"] for turn_id in conflict["turn_ids"]}
        expected_kind = "cross_user" if len(users) > 1 else "same_user"
        if conflict["kind"] != expected_kind:
            raise ValueError(f"Conflict {conflict['id']} kind disagrees with its users")
    for turn in turns:
        if not set(turn["conflict_ids"]) <= conflict_ids:
            raise ValueError(f"Turn {turn['turn_id']} references an unknown conflict")

    dummy = {
        "turns": [
            {
                "turn_id": turn["turn_id"],
                "status": "unassigned",
                "topic_ids": [],
                "witness_topic_ids": [],
            }
            for turn in turns
        ],
        "topics": [],
    }
    report = score_replay(manifest, dummy)
    if report["turn_counts"]["total"] != len(turns):
        raise ValueError("Scoring did not count every Turn")


def main() -> None:
    """Build both grown manifests from the reviewed labels and frozen trace pages."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--same-user-out", type=Path, required=True)
    parser.add_argument("--fetch", action="store_true", help="Download missing pages")
    args = parser.parse_args()
    if args.out.exists() or args.same_user_out.exists():
        parser.error("Output manifest already exists")

    base_bytes = args.base.read_bytes()
    base = json.loads(base_bytes)
    labels = json.loads(args.labels.read_text(encoding="utf-8"))
    if labels["base_manifest_sha256"] != sha256(base_bytes).hexdigest():
        parser.error("Labels were reviewed against a different base manifest")
    urls = sorted({row["trace_url"] for row in labels["turns"]})
    manifest = build_manifest(base, labels, load_pages(args.pages, urls, fetch=args.fetch))
    variant = same_user_variant(manifest)
    validate(base, manifest)
    validate(base, variant, same_user=True)
    for path, data in ((args.out, manifest), (args.same_user_out, variant)):
        with path.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")


if __name__ == "__main__":
    main()
