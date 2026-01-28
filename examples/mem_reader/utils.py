"""Utility functions for MemReader examples."""

import json
import pprint

from typing import Any

from memos.memories.textual.item import TextualMemoryItem


def _truncate(s: str, max_len: int | None) -> str:
    if max_len is None or len(s) <= max_len:
        return s
    return s[:max_len] + "..."


def sanitize_for_print(obj: Any, *, max_str_len: int | None = 500) -> Any:
    """
    Recursively sanitize data for pretty printing:
    - Long strings are truncated
    - Strings keep real newlines (so box printer can render multi-line)
    """
    if isinstance(obj, str):
        return _truncate(obj, max_str_len)
    if isinstance(obj, dict):
        return {k: sanitize_for_print(v, max_str_len=max_str_len) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_for_print(v, max_str_len=max_str_len) for v in obj]
    if isinstance(obj, tuple):
        return tuple(sanitize_for_print(v, max_str_len=max_str_len) for v in obj)
    return obj


def pretty_print_dict(d: dict, *, max_str_len: int | None = 500):
    """Print a dictionary in a pretty bordered box (handles multiline strings)."""
    d2 = sanitize_for_print(d, max_str_len=max_str_len)

    # Prefer JSON formatting if possible, fallback to pprint
    try:
        text = json.dumps(d2, indent=2, ensure_ascii=False)
    except (TypeError, ValueError):
        text = pprint.pformat(d2, indent=2, width=120)

    # Expand the JSON/pprint output into lines
    lines: list[str] = []
    for line in text.splitlines():
        # If a line itself contains literal "\n" sequences (rare), leave it;
        # real newlines are already split by splitlines().
        lines.append(line)

    # Prevent extremely wide boxes (optional safety)
    max_len = max(len(line) for line in lines) if lines else 0
    border = "═" * (max_len + 4)

    print(f"╔{border}╗")
    for line in lines:
        print(f"║  {line.ljust(max_len)}  ║")
    print(f"╚{border}╝")


def print_memory_item(
    item: TextualMemoryItem,
    indent: int = 0,
    max_memory_length: int | None = 300,  # None = 不截断
):
    """Print a TextualMemoryItem in a structured format."""
    prefix = " " * indent
    print(f"{prefix}--- Memory Item ---")
    print(f"{prefix}Type: {item.metadata.memory_type}")

    mem = item.memory or ""
    mem_preview = mem if max_memory_length is None else _truncate(mem, max_memory_length)
    print(f"{prefix}Memory: {mem_preview}")

    if item.metadata.tags:
        print(f"{prefix}Tags: {item.metadata.tags}")

    if item.metadata.confidence is not None:
        print(f"{prefix}Confidence: {item.metadata.confidence}")

    if hasattr(item.metadata, "sources") and item.metadata.sources:
        print(f"{prefix}Sources ({len(item.metadata.sources)}):")
        for source in item.metadata.sources:
            print(f"{prefix}  - {source.type} (role: {getattr(source, 'role', 'N/A')})")
