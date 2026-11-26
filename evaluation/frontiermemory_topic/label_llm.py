"""Ask a labeling model for independent gold_work proposals and conflict candidates.

Both passes read a built manifest. ``propose`` hides the reviewed labels of non-frozen
Turns and asks for a label per Turn; ``conflicts`` sends each gold_work group's user
text and asks for incompatible requirements. Every request and its usage is appended to
a JSONL log; a human review of the output is still required before it becomes gold.
"""

from __future__ import annotations

import argparse
import json
import time

from collections import defaultdict
from hashlib import sha256
from pathlib import Path
from typing import Any


RETRY_SECONDS = 600

GRANULARITY = (
    "A gold_work is one concrete, independently deliverable piece of work (a feature, API, "
    "config option, rule, release step or document). Two Turns belong to different works "
    "only if each is independently deliverable AND neither changes the other's decisions; "
    "sub-settings, corrections and tests of one feature are the same work. The opening "
    "request and plan approvals belong to the work they define."
)
WORTHY = (
    "memory_worthy is false only when the Turn has nothing to remember: a pure "
    "acknowledgement such as 'ok, go ahead', 'ship it' or 'thanks' with no requirement, "
    "decision, correction or reported result (in user OR assistant text). Otherwise true."
)


def read_profile(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines without exposing values."""
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class LabelModel:
    """One OpenAI-compatible chat client that logs usage and retries outages."""

    def __init__(self, profile: Path, log: Path, prices: tuple[float, float] | None = None):
        from openai import OpenAI

        values = read_profile(profile)
        self.model = values["MODEL"]
        self.client = OpenAI(base_url=values["OPENAI_API_BASE"], api_key=values["OPENAI_API_KEY"])
        self.log = log
        self.prices = prices

    def ask(self, stage: str, key: str, system: str, prompt: str) -> dict[str, Any]:
        from openai import APIConnectionError, APIStatusError

        messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
        started, delay = time.monotonic(), 15
        while True:
            try:
                response = self.client.chat.completions.create(
                    model=self.model, messages=messages, max_completion_tokens=16000
                )
                break
            except (APIStatusError, APIConnectionError) as exc:
                status = getattr(exc, "status_code", None)
                if status is not None and status < 500 and status != 429:
                    raise
                if time.monotonic() - started + delay > RETRY_SECONDS:
                    self._write(stage, key, messages, error=f"{type(exc).__name__} {status}")
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 120)
        if response.model and not response.model.startswith(self.model):
            raise RuntimeError(f"Gateway answered with {response.model}, not {self.model}")
        text = response.choices[0].message.content or ""
        usage = response.usage
        self._write(stage, key, messages, text=text, usage=usage)
        return parse_json(text)

    def _write(self, stage, key, messages, *, text=None, usage=None, error=None) -> None:
        row = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "stage": stage,
            "key": key,
            "model": self.model,
            "prompt_sha256": sha256(json.dumps(messages).encode()).hexdigest(),
            "messages": messages,
            "response": text,
            "error": error,
        }
        if usage is not None:
            row["usage"] = {"input": usage.prompt_tokens, "output": usage.completion_tokens}
            details = getattr(usage, "completion_tokens_details", None)
            row["usage"]["reasoning"] = getattr(details, "reasoning_tokens", None)
            if self.prices is not None:
                row["usd"] = round(
                    (
                        usage.prompt_tokens * self.prices[0]
                        + usage.completion_tokens * self.prices[1]
                    )
                    / 1e6,
                    6,
                )
        with self.log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def parse_json(text: str) -> dict[str, Any]:
    """Read the first JSON object in a reply, tolerating a fenced block."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Reply contains no JSON object")
    return json.loads(text[start : end + 1])


def _assistant_digest(turn: dict[str, Any], limit: int = 500) -> str:
    replies = [message["content"] for message in turn["messages"][1:]]
    if not replies:
        return "(no assistant prose)"
    picked = replies if len(replies) < 3 else [replies[0], replies[-1]]
    return " ... ".join(" ".join(reply.split())[:limit] for reply in picked)


def propose_prompt(task: str, turns: list[dict[str, Any]], groups: dict[str, Any]) -> str:
    """List frozen labels as anchors and ask for labels of the other Turns."""
    frozen = sorted({turn["gold_work"] for turn in turns if turn["label_source"] == "codex-frozen"})
    lines = [
        f"Source task: {task}",
        "",
        "Existing gold_work labels (reuse when the Turn continues them):",
    ]
    lines += [f"- {work}: {groups.get(work, {}).get('why', '')}" for work in frozen] or ["- (none)"]
    by_trace: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for turn in turns:
        by_trace[turn["trace_url"]].append(turn)
    for number, (url, rows) in enumerate(sorted(by_trace.items()), 1):
        lines += ["", f"=== Trajectory {number} (one simulated user): {url}"]
        for turn in sorted(rows, key=lambda row: row["source_ordinal"]):
            label = (
                f"FROZEN gold_work={turn['gold_work']}"
                if turn["label_source"] == "codex-frozen"
                else "LABEL ME"
            )
            lines += [
                f"--- [{turn['turn_id']}] {label}",
                f"USER: {turn['messages'][0]['content']}",
                f"ASSISTANT (digest): {_assistant_digest(turn)}",
            ]
    lines += [
        "",
        "For every LABEL ME Turn return gold_work (an existing label, or a new slug "
        "'<task-prefix>-<work-slug>' reusing the existing prefix style), new_work_why for new "
        "slugs, memory_worthy, and a one-sentence reason. Keep labels consistent across the "
        "trajectories: the same work in two trajectories gets the same label.",
        'Reply with JSON only: {"labels": [{"turn_id": "...", "gold_work": "...", '
        '"new_work_why": "...", "memory_worthy": true, "reason": "..."}]}',
    ]
    return "\n".join(lines)


def conflicts_prompt(task: str, turns: list[dict[str, Any]]) -> str:
    """Show each multi-Turn gold_work group with user text and the simulated user."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for turn in turns:
        groups[turn["gold_work"]].append(turn)
    lines = [f"Source task: {task}"]
    for work, rows in sorted(groups.items()):
        if len(rows) < 2:
            continue
        lines += ["", f"=== gold_work {work}"]
        for turn in rows:
            lines += [
                f"--- [{turn['turn_id']}] user={turn['user_id']} order={turn['source_ordinal']}",
                turn["messages"][0]["content"],
            ]
    lines += [
        "",
        "Find conflicts: two or more Turns in the SAME gold_work whose user text states "
        "incompatible requirements or decisions on the same item (different default value, "
        "different API shape or names, opposite rule). A later Turn that only adds detail, "
        "fixes the assistant's implementation, or restates the same requirement is NOT a "
        "conflict. Quote each Turn verbatim and briefly.",
        'Reply with JSON only: {"conflicts": [{"gold_work": "...", "item": "...", '
        '"turn_ids": ["..."], "statements": {"turn_id": "quote"}, "why": "..."}]}',
    ]
    return "\n".join(lines)


def main() -> None:
    """Run one labeling pass over a built manifest and write its raw proposals."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("propose", "conflicts"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--profile", type=Path, default=Path.home() / ".openai.env")
    parser.add_argument(
        "--usd-per-mtok", type=float, nargs=2, metavar=("INPUT", "OUTPUT"), help="List prices"
    )
    parser.add_argument("--tasks", nargs="*", help="Limit the pass to these source tasks")
    args = parser.parse_args()
    if args.out.exists():
        parser.error(f"{args.out} already exists")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for turn in manifest["turns"]:
        by_task[turn["source_task"]].append(turn)
    if args.stage == "propose":
        tasks = {
            task
            for task, turns in by_task.items()
            if any(turn["label_source"] != "codex-frozen" for turn in turns)
        }
    else:
        tasks = {
            task
            for task, turns in by_task.items()
            if len({t["gold_work"] for t in turns}) < len(turns)
        }
    if args.tasks:
        tasks &= set(args.tasks)

    model = LabelModel(
        args.profile, args.log, tuple(args.usd_per_mtok) if args.usd_per_mtok else None
    )
    system = (
        "You label an evaluation set for project-memory Topic attribution. "
        f"{GRANULARITY} {WORTHY} Answer with strict JSON."
    )
    output: dict[str, Any] = {"stage": args.stage, "model": model.model, "tasks": {}}
    for task in sorted(tasks):
        turns = by_task[task]
        prompt = (
            propose_prompt(task, turns, manifest["work_groups"])
            if args.stage == "propose"
            else conflicts_prompt(task, turns)
        )
        output["tasks"][task] = model.ask(args.stage, task, system, prompt)
        args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
