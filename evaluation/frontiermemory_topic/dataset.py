"""Freeze the selected public FrontierMemory source dialogue and both Topic gold labels."""

from __future__ import annotations

import argparse
import json
import re

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict
from urllib.request import Request, urlopen


if TYPE_CHECKING:
    from collections.abc import Mapping


FRONTIER_REVISION = "9af28c2f8210779f442aa36a1d73553630441af5"
TRACE_BASE = "https://frontiermemory.com/traces"


@dataclass(frozen=True)
class TraceSelection:
    source_task: str
    parent: str
    path: str
    turns: tuple[tuple[int, str], ...]

    @property
    def url(self) -> str:
        return f"{TRACE_BASE}/awilix-release-tier-{self.parent}/{self.path}/"


TRACE_SELECTIONS = (
    TraceSelection(
        "tomlkit",
        "explicit",
        "02__tomlkit-tier-5",
        ((5, "tomlkit-conversion-api"), (14, "tomlkit-conversion-api"), (105, "tomlkit-release")),
    ),
    TraceSelection(
        "returns",
        "implicit",
        "03__returns-tier-6",
        ((6, "returns-validated"), (83, "returns-validated")),
    ),
    TraceSelection(
        "vitest",
        "explicit",
        "04__vitest-tier-8",
        ((6, "vitest-sharding"), (112, "vitest-sharding"), (220, "vitest-file-sorting")),
    ),
    TraceSelection(
        "tomlkit",
        "implicit",
        "02__tomlkit-tier-5",
        ((6, "tomlkit-conversion-api"), (59, "tomlkit-conversion-api"), (152, "tomlkit-release")),
    ),
    TraceSelection(
        "returns",
        "explicit",
        "03__returns-tier-6",
        ((5, "returns-validated"), (144, "returns-validated")),
    ),
    TraceSelection(
        "vitest",
        "implicit",
        "04__vitest-tier-8",
        ((6, "vitest-sharding"), (86, "vitest-sharding"), (198, "vitest-file-sorting")),
    ),
)

_USER_WRAPPERS = (
    "you're working in the repository",
    "# agents.md",
    "# verifier result",
)
_TOOL_PLACEHOLDER = re.compile(r"^Executed (?:[\w.:-]+ )?(?:call_|toolu_)\w+\.?$")


@dataclass(frozen=True)
class SourceMessage:
    ordinal: int
    role: str
    content: str


class InputMessage(TypedDict):
    role: str
    content: str
    message_id: str


class PilotTurn(TypedDict):
    turn_id: str
    conversation_id: str
    user_id: str
    wave: int
    source_task: str
    gold_work: str
    trace_url: str
    trace_sha256: str
    trace_content_sha256: str
    content_sha256: str
    source_ordinal: int
    source_message_ordinals: list[int]
    messages: list[InputMessage]


class PilotManifest(TypedDict):
    frontiermemory_revision: str
    case_notes: dict[str, str]
    turns: list[PilotTurn]


def parse_trace(html: bytes) -> dict[int, list[SourceMessage]]:
    """Read user and assistant dialogue from the full-view transcript in native order."""
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:
        raise ImportError("FrontierMemory trace parsing requires beautifulsoup4") from exc

    soup = BeautifulSoup(html.decode("utf-8"), "html.parser")
    turns: dict[int, list[SourceMessage]] = {}
    current: list[SourceMessage] | None = None
    for step in soup.select(".trace-full-view article.trace-step"):
        classes = step.get("class", [])
        if "role-user" in classes:
            role = "user"
            current = None
        elif "role-assistant" in classes:
            role = "assistant"
        else:
            continue
        index_node = step.select_one(".trace-role .index")
        body = step.select_one(".trace-step-body > section:not(.trace-tool) > pre")
        if index_node is None or body is None:
            continue
        ordinal = int(index_node.get_text(strip=True))
        content = body.get_text().strip()
        if not content or _TOOL_PLACEHOLDER.fullmatch(content):
            continue
        message = SourceMessage(ordinal, role, content)
        if role == "user" and not content.casefold().startswith(_USER_WRAPPERS):
            if ordinal in turns:
                raise ValueError(f"Duplicate user ordinal {ordinal} in FrontierMemory trace")
            current = [message]
            turns[ordinal] = current
        elif role == "assistant" and current is not None:
            current.append(message)
    return turns


def _content_sha256(messages: list[SourceMessage]) -> str:
    roles_and_text = [(message.role, message.content) for message in messages]
    canonical = json.dumps(roles_and_text, ensure_ascii=False, separators=(",", ":"))
    return sha256(canonical.encode()).hexdigest()


def build_pilot(pages: Mapping[str, bytes]) -> PilotManifest:
    """Validate the six selected traces and assign stable evaluation-only identities."""
    turns: list[PilotTurn] = []
    seen_traces: set[str] = set()
    for number, source in enumerate(TRACE_SELECTIONS, 1):
        html = pages[source.url]
        trace = parse_trace(html)
        trace_hash = sha256(html).hexdigest()
        dialogue_hash = _content_sha256([message for group in trace.values() for message in group])
        if dialogue_hash in seen_traces:
            raise ValueError(f"{source.url} contains duplicate dialogue from another sample")
        seen_traces.add(dialogue_hash)

        for wave, (ordinal, gold_work) in enumerate(source.turns, 1):
            group = trace.get(ordinal)
            if not group or len(group) < 2:
                raise ValueError(
                    f"{source.url} lacks complete dialogue for selected ordinal {ordinal}"
                )
            messages: list[InputMessage] = [
                {
                    "role": message.role,
                    "content": message.content,
                    "message_id": f"fm-s{number:02}-m{message.ordinal:03}",
                }
                for message in group
            ]
            turns.append(
                {
                    "turn_id": messages[0]["message_id"],
                    "conversation_id": f"fm-conversation-{number:02}",
                    "user_id": f"fm-user-{number:02}",
                    "wave": wave,
                    "source_task": source.source_task,
                    "gold_work": gold_work,
                    "trace_url": source.url,
                    "trace_sha256": trace_hash,
                    "trace_content_sha256": dialogue_hash,
                    "content_sha256": _content_sha256(group),
                    "source_ordinal": ordinal,
                    "source_message_ordinals": [message.ordinal for message in group],
                    "messages": messages,
                }
            )
    turns.sort(key=lambda turn: turn["wave"])
    return {
        "frontiermemory_revision": FRONTIER_REVISION,
        "case_notes": {
            "tomlkit-release": "The selected version bumps are separate work from the conversion API.",
            "vitest-file-sorting": "Sorting test files is separable from allocating files to shards.",
        },
        "turns": turns,
    }


def fetch_trace(url: str) -> bytes:
    """Download a publicly served trace without credentials."""
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (FrontierMemory Topic Evaluation)"})
    with urlopen(request, timeout=25) as response:
        return response.read()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", required=True, type=Path, help="Path for the frozen local manifest"
    )
    args = parser.parse_args()
    if args.out.exists():
        parser.error(f"Frozen manifest already exists at {args.out}")

    urls = [source.url for source in TRACE_SELECTIONS]
    with ThreadPoolExecutor(max_workers=len(urls)) as workers:
        manifest = build_pilot(dict(zip(urls, workers.map(fetch_trace, urls), strict=True)))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
