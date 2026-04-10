#!/usr/bin/env python3
"""Session-end hook: capture conversation from OpenHarness session file and
ingest into the memory store.

OpenHarness saves session snapshots to ~/.openharness/data/sessions/{project}-{hash}/latest.json
BEFORE firing session_end hooks, so we read messages from that file.

Environment:
  OPENHARNESS_HOOK_EVENT   - "session_end"
  OPENHARNESS_HOOK_PAYLOAD - JSON with {cwd, event} (no messages)
  CWD of process           - the project working directory
"""

from __future__ import annotations

import json
import logging
import os
import sys

from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

from bridge_client import MemosCoreBridge
from config import get_project_session_dir


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("memos-capture")


def _extract_text(content: list | str) -> str:
    """Extract text from OpenHarness message content (list of blocks or string)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts)
    return ""


def load_messages_from_session(cwd: Path) -> tuple[list[dict], str]:
    """Read the latest session file and extract user/assistant messages."""
    session_dir = get_project_session_dir(cwd)
    latest = session_dir / "latest.json"

    if not latest.exists():
        logger.info("No session file at %s", latest)
        return [], "default"

    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read session file: %s", e)
        return [], "default"

    session_id = data.get("session_id", "default")
    messages: list[dict] = []

    for msg in data.get("messages", []):
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            continue
        text = _extract_text(msg.get("content", ""))
        if text and len(text.strip()) >= 5:
            messages.append({"role": role, "content": text.strip()})

    return messages, session_id


def extract_messages_from_payload() -> tuple[list[dict], str]:
    """Try to extract messages from hook payload (fallback)."""
    payload_raw = os.environ.get("OPENHARNESS_HOOK_PAYLOAD", "{}")
    try:
        payload = json.loads(payload_raw)
    except json.JSONDecodeError:
        payload = {}

    messages: list[dict] = []
    session_id = payload.get("session_id", "default")

    raw_messages = payload.get("messages", [])
    if isinstance(raw_messages, list):
        for msg in raw_messages:
            if isinstance(msg, dict) and "role" in msg and "content" in msg:
                messages.append(
                    {
                        "role": msg["role"],
                        "content": msg["content"],
                    }
                )

    return messages, session_id


def main() -> None:
    cwd = Path.cwd()

    # Primary: read from OpenHarness session file
    messages, session_id = load_messages_from_session(cwd)

    # Fallback: try hook payload
    if not messages:
        messages, session_id = extract_messages_from_payload()

    if not messages:
        logger.info("No messages to capture, skipping")
        return

    logger.info("Capturing %d messages for session %s", len(messages), session_id)

    bridge: MemosCoreBridge | None = None
    try:
        bridge = MemosCoreBridge()

        bridge.ingest(messages, session_id=session_id, owner="openharness")
        bridge.flush()

        logger.info("Capture complete")

    except FileNotFoundError as e:
        logger.warning("Bridge not found: %s", e)
    except Exception as e:
        logger.error("Capture failed: %s", e)
    finally:
        if bridge:
            bridge.shutdown()


if __name__ == "__main__":
    main()
