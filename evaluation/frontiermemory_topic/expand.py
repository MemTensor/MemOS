"""Freeze manually paired, public FrontierMemory source Turns for an expanded replay."""

from __future__ import annotations

import argparse
import json
import random

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .dataset import (
    FRONTIER_REVISION,
    InputMessage,
    PilotTurn,
    _content_sha256,
    fetch_trace,
    parse_trace,
)


SEED = 20261123


def selected_urls(groups: list[dict[str, Any]]) -> list[str]:
    """Return the allowed official public trace URLs in reproducible order."""
    urls = sorted({turn["trace_url"] for group in groups for turn in group["turns"]})
    for url in urls:
        parts = urlsplit(url)
        if (
            parts.scheme != "https"
            or parts.netloc != "frontiermemory.com"
            or not parts.path.startswith("/traces/")
            or parts.query
            or parts.fragment
        ):
            raise ValueError(f"Expected an official public trace URL, got {url}")
    return urls


def build_expansion(
    groups: list[dict[str, Any]], pages: dict[str, bytes], *, seed: int = SEED
) -> dict[str, Any]:
    """Build a frozen replay manifest with one simulated user per distinct source trajectory."""
    selections: dict[str, dict[int, tuple[str, str]]] = defaultdict(dict)
    work_groups: dict[str, dict[str, Any]] = {}
    for group in groups:
        task, work = group["source_task"], group["gold_work"]
        if work in work_groups:
            raise ValueError(f"Duplicate concrete work group {work}")
        if len({turn["trace_url"] for turn in group["turns"]}) < 2:
            raise ValueError(f"Concrete work group {work} needs two independent sources")
        work_groups[work] = {"source_task": task, "why": group["why"]}
        for ref in group["turns"]:
            url, ordinal = ref["trace_url"], ref["source_ordinal"]
            if ordinal in selections[url]:
                raise ValueError(f"Turn is selected twice: {url} at {ordinal}")
            selections[url][ordinal] = (task, work)
    if not 1 <= len(work_groups) <= 50:
        raise ValueError("Expected between 1 and 50 concrete work groups")

    users_by_trace_hash: dict[str, str] = {}
    seen_turns: set[str] = set()
    waves: dict[int, list[PilotTurn]] = defaultdict(list)
    prompts: dict[str, set[str]] = defaultdict(set)
    for index, url in enumerate(selected_urls(groups), 1):
        html = pages[url]
        trace = parse_trace(html)
        trace_hash = _content_sha256([message for turns in trace.values() for message in turns])
        if trace_hash in users_by_trace_hash:
            raise ValueError(
                f"Found duplicate dialogue at {url} and {users_by_trace_hash[trace_hash]}"
            )
        users_by_trace_hash[trace_hash] = url
        tasks = {task for task, _ in selections[url].values()}
        if len(tasks) != 1:
            raise ValueError(f"Source trace belongs to multiple task labels: {url}")

        for wave, (ordinal, (task, work)) in enumerate(sorted(selections[url].items()), 1):
            dialogue = trace.get(ordinal)
            if not dialogue or len(dialogue) < 2:
                raise ValueError(
                    f"Source trace has no full user and assistant Turn: {url} at {ordinal}"
                )
            turn_hash = _content_sha256(dialogue)
            if turn_hash in seen_turns:
                raise ValueError(f"Selected full Turn is duplicated: {url} at {ordinal}")
            seen_turns.add(turn_hash)
            prompts[work].add(" ".join(dialogue[0].content.split()))
            messages: list[InputMessage] = [
                {
                    "role": message.role,
                    "content": message.content,
                    "message_id": f"fm-x{index:02}-m{message.ordinal:03}",
                }
                for message in dialogue
            ]
            waves[wave].append(
                {
                    "turn_id": messages[0]["message_id"],
                    "conversation_id": f"fm-expanded-conversation-{index:02}",
                    "user_id": f"fm-expanded-user-{index:02}",
                    "wave": wave,
                    "source_task": task,
                    "gold_work": work,
                    "trace_url": url,
                    "trace_sha256": sha256(html).hexdigest(),
                    "trace_content_sha256": trace_hash,
                    "content_sha256": turn_hash,
                    "source_ordinal": ordinal,
                    "source_message_ordinals": [message.ordinal for message in dialogue],
                    "messages": messages,
                }
            )

    replay_order = random.Random(seed)
    turns: list[PilotTurn] = []
    for wave in sorted(waves):
        replay_order.shuffle(waves[wave])
        turns.extend(waves[wave])
    for work, metadata in work_groups.items():
        metadata["repeat_prompt"] = len(prompts[work]) == 1
    return {
        "frontiermemory_revision": FRONTIER_REVISION,
        "seed": seed,
        "work_groups": work_groups,
        "turns": turns,
    }


def main() -> None:
    """Download selected trace pages and write one versioned local manifest."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error(f"Frozen manifest already exists at {args.out}")
    groups = json.loads(args.selection.read_text(encoding="utf-8"))
    urls = selected_urls(groups)
    with ThreadPoolExecutor(max_workers=8) as workers:
        pages = dict(zip(urls, workers.map(fetch_trace, urls), strict=True))
    output = build_expansion(groups, pages)
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(output, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
