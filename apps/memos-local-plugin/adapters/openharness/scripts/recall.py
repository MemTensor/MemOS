#!/usr/bin/env python3
"""Session-start hook: ensure daemon is running, recall recent memories,
and write them to the memory directory for system prompt injection.

Strategy: retrieve the most recent memories (chronological, not semantic search)
so the agent always has access to recent facts, preferences, and context.
OpenHarness's session_start payload does not contain the user's question,
so semantic search would require guessing — recent recall is more reliable.

Environment:
  OPENHARNESS_HOOK_EVENT   - "session_start"
  OPENHARNESS_HOOK_PAYLOAD - JSON with session info
  CWD of process           - the project working directory
"""

from __future__ import annotations

import logging
import sys

from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

from bridge_client import MemosCoreBridge
from config import get_project_memory_dir
from daemon_manager import ensure_daemon


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("memos-recall")

MAX_RECENT_MEMORIES = 30


def format_memories_section(memories: list[dict]) -> str:
    """Format recent memories into a prompt section."""
    if not memories:
        return ""
    lines = ["<recalled_memories>"]
    for m in memories:
        summary = m.get("summary", "")
        content = m.get("content", "")
        role = m.get("role", "unknown")
        display = summary or content[:300]
        if display:
            lines.append(f"- [{role}] {display}")
    lines.append("</recalled_memories>")
    return "\n".join(lines)


def write_recall_file(memory_dir: Path, section: str, count: int) -> None:
    """Write recalled memories to a markdown file in the memory directory."""
    recall_path = memory_dir / "memos-recall.md"

    if count == 0:
        if recall_path.exists():
            recall_path.unlink()
        return

    content = f"""---
title: MemTensor Recalled Memories
description: Recent memories from previous sessions (auto-recalled at session start)
---

{section}
"""
    recall_path.write_text(content, encoding="utf-8")
    logger.info("Wrote %d memories to %s", count, recall_path)


def main() -> None:
    cwd = Path.cwd()
    memory_dir = get_project_memory_dir(cwd)

    # Ensure daemon (bridge + viewer) is running
    try:
        info = ensure_daemon()
        viewer_url = info.get("viewerUrl", "")
        if info.get("already_running"):
            logger.info("Daemon already running (pid=%s)", info.get("pid"))
        else:
            logger.info("Daemon started (pid=%s)", info.get("pid"))
        if viewer_url:
            logger.info("Memory Viewer: %s", viewer_url)
    except Exception as e:
        logger.warning("Failed to start daemon, falling back to subprocess: %s", e)

    logger.info("Recalling recent memories (last %d)", MAX_RECENT_MEMORIES)

    bridge: MemosCoreBridge | None = None
    try:
        bridge = MemosCoreBridge()

        if not bridge.ping():
            logger.error("Bridge ping failed, aborting recall")
            return

        # Get recent memories chronologically
        result = bridge.recent(limit=MAX_RECENT_MEMORIES)
        memories = result.get("memories", [])

        # Deduplicate and reverse to chronological order (oldest first)
        seen = set()
        unique: list[dict] = []
        for m in memories:
            key = m.get("summary", "") or m.get("content", "")
            if key and key not in seen:
                seen.add(key)
                unique.append(m)
        unique.reverse()

        section = format_memories_section(unique)
        write_recall_file(memory_dir, section, len(unique))
        logger.info("Recall complete: %d unique memories", len(unique))

    except FileNotFoundError as e:
        logger.warning("Bridge not found: %s", e)
    except Exception as e:
        logger.error("Recall failed: %s", e)
    finally:
        if bridge:
            bridge.shutdown()


if __name__ == "__main__":
    main()
