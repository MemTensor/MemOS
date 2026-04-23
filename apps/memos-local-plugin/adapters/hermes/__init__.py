"""MemTensor memory provider for hermes-agent.

Persistent semantic memory with hybrid search (vector + FTS + recency),
powered by memos-core via a shared bridge daemon.

Activation: set ``memory.provider: memtensor`` in ~/.hermes/config.yaml
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sys
import threading

from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Add this directory to sys.path so sibling modules (config, bridge_client, …) resolve
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from agent.memory_provider import MemoryProvider  # noqa: E402
from tools.registry import tool_error  # noqa: E402


logger = logging.getLogger(__name__)

MEMORY_SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": (
        "Search long-term memory for relevant information. Uses hybrid "
        "retrieval combining semantic vector search, full-text search, "
        "and recency scoring."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to search for in memory.",
            },
        },
        "required": ["query"],
    },
}


_TRIVIAL_PATTERNS = [
    re.compile(r'^\s*\{["\']?ok["\']?\s*:\s*true\s*\}\s*$', re.IGNORECASE),
    re.compile(r'^\s*\{["\']?success["\']?\s*:\s*true\s*\}\s*$', re.IGNORECASE),
    re.compile(r'^\s*\{["\']?status["\']?\s*:\s*["\']?ok["\']?\s*\}\s*$', re.IGNORECASE),
    re.compile(r"^Operation interrupted:", re.IGNORECASE),
    re.compile(r"^Error:", re.IGNORECASE),
    re.compile(r"waiting for model response.*elapsed", re.IGNORECASE),
    re.compile(r"^\s*$"),
]

_MIN_CONTENT_LENGTH = 6


_ROLE_LABEL = {"user": "User", "assistant": "Assistant", "system": "System", "tool": "Tool"}


def _format_ts(ts: int | float | None) -> str:
    """Convert a millisecond-epoch timestamp to a readable local-time string."""
    if not ts:
        return ""
    try:
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone()
        return dt.strftime("%Y-%m-%d %H:%M")
    except (OSError, ValueError, OverflowError):
        return ""


def _format_memory_entry(text: str, role: str = "", ts: int | float | None = None, max_len: int = 500) -> str:
    """Build a single formatted memory line with role and time metadata."""
    role_label = _ROLE_LABEL.get(role, "")
    time_label = _format_ts(ts)
    meta_parts = [p for p in (role_label, time_label) if p]
    prefix = f"[{' | '.join(meta_parts)}] " if meta_parts else ""
    return f"- {prefix}{text[:max_len]}"


def _is_trivial(text: str) -> bool:
    """Return True if *text* carries no meaningful information for long-term memory."""
    if not text or len(text.strip()) < _MIN_CONTENT_LENGTH:
        return True
    stripped = text.strip()
    for pat in _TRIVIAL_PATTERNS:
        if pat.search(stripped):
            return True
    try:
        obj = json.loads(stripped)
        if isinstance(obj, dict) and len(obj) <= 2:
            keys = {k.lower() for k in obj}
            if keys <= {"ok", "success", "status", "result", "error", "message"}:
                vals = list(obj.values())
                if all(
                    isinstance(v, bool | type(None)) or (isinstance(v, str) and len(v) < 20)
                    for v in vals
                ):
                    return True
    except (json.JSONDecodeError, TypeError):
        pass
    return False


class MemTensorProvider(MemoryProvider):
    """MemTensor semantic memory — recall across sessions via bridge daemon."""

    def __init__(self) -> None:
        self._bridge = None
        self._session_id = ""
        self._prefetch_thread: threading.Thread | None = None
        self._sync_thread: threading.Thread | None = None
        self._pending_ingest: tuple | None = None

    @property
    def name(self) -> str:
        return "memtensor"

    def is_available(self) -> bool:
        try:
            from config import find_bridge_script

            find_bridge_script()
            return True
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id

        from daemon_manager import ensure_daemon

        try:
            info = ensure_daemon()
            logger.info(
                "MemTensor daemon ready: port=%s, viewer=%s, new=%s",
                info.get("daemonPort"),
                info.get("viewerUrl"),
                not info.get("already_running"),
            )
        except Exception as e:
            logger.warning("Failed to start MemTensor daemon: %s", e)

        from bridge_client import MemosCoreBridge

        try:
            self._bridge = MemosCoreBridge()
            logger.info("MemTensor bridge connected")
        except Exception as e:
            logger.warning("MemTensor bridge connection failed: %s", e)
            self._bridge = None

    def system_prompt_block(self) -> str:
        return (
            "# MemTensor Memory\n"
            "Persistent long-term memory is active. Relevant memories are "
            "automatically injected into context each turn. Use the "
            "`memory_search` tool when you need to search memory explicitly."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Synchronously retrieve memories for the current user query.

        This ensures recalled memories are available in the same turn they
        are requested, rather than being deferred to the next turn.
        """
        if not self._bridge:
            return ""
        try:
            result = self._do_recall(query)
        except Exception as e:
            logger.debug("MemTensor prefetch failed: %s", e)
            return ""

        if not result:
            return ""
        return f"## Recalled Memories\n{result}"

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Flush deferred ingest in the background.

        Memory retrieval is now handled synchronously in prefetch(), so this
        method only takes care of writing the previous turn's data into the
        store — ensuring it doesn't pollute the current turn's search results.
        """
        pending = self._pending_ingest
        self._pending_ingest = None

        if not pending or not self._bridge:
            return

        def _run():
            try:
                from config import OWNER

                user_content, assistant_content, sid = pending
                messages = []
                if user_content:
                    messages.append({"role": "user", "content": user_content})
                if assistant_content:
                    messages.append({"role": "assistant", "content": assistant_content})
                if messages:
                    self._bridge.ingest(messages, session_id=sid, owner=OWNER)
                    self._bridge.flush()
            except Exception as e:
                logger.warning("MemTensor deferred sync_turn failed: %s", e)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="memtensor-ingest"
        )
        self._prefetch_thread.start()

    def _do_recall(self, query: str) -> str:
        if not self._bridge:
            return ""

        from config import OWNER

        parts: list[str] = []

        try:
            search_resp = self._bridge.search(query, max_results=5, min_score=0.4, owner=OWNER)
            hits = search_resp.get("hits") or search_resp.get("memories") or []
            for h in hits:
                text = h.get("original_excerpt") or h.get("content") or h.get("summary", "")
                if not text:
                    continue
                source = h.get("source") or {}
                role = source.get("role") or h.get("role", "")
                ts = source.get("ts") or h.get("createdAt")
                parts.append(_format_memory_entry(text, role=role, ts=ts))
        except Exception as e:
            logger.debug("MemTensor search in prefetch failed: %s", e)

        if not parts:
            try:
                recent_resp = self._bridge.recent(limit=10, owner=OWNER)
                memories = recent_resp.get("memories") or []
                for m in memories:
                    text = m.get("content") or m.get("summary", "")
                    if not text:
                        continue
                    role = m.get("role", "")
                    ts = m.get("createdAt")
                    parts.append(_format_memory_entry(text, role=role, ts=ts))
            except Exception as e:
                logger.debug("MemTensor recent in prefetch failed: %s", e)

        return "\n".join(parts)

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Queue turn data for deferred ingest.

        Hermes calls sync_all() BEFORE queue_prefetch_all(), so ingesting
        immediately would let the next prefetch retrieve the just-added turn.
        Instead we stash the data and let queue_prefetch() flush it AFTER
        the search completes — ensuring search results never contain the
        current turn's content.
        """
        if not self._bridge:
            return
        if _is_trivial(user_content) and _is_trivial(assistant_content):
            logger.debug(
                "sync_turn: skipping trivial turn (user=%r, assistant=%r)",
                user_content[:80] if user_content else "",
                assistant_content[:80] if assistant_content else "",
            )
            return
        if _is_trivial(user_content):
            user_content = ""
        if _is_trivial(assistant_content):
            assistant_content = ""
        sid = session_id or self._session_id or "default"
        self._pending_ingest = (user_content, assistant_content, sid)

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [MEMORY_SEARCH_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        if tool_name != "memory_search":
            return tool_error(f"Unknown tool: {tool_name}")

        query = args.get("query", "")
        if not query:
            return tool_error("Missing required parameter: query")

        if not self._bridge:
            return tool_error("MemTensor bridge not connected")

        try:
            from config import OWNER

            resp = self._bridge.search(query, max_results=8, owner=OWNER)
            hits = resp.get("hits") or resp.get("memories") or []
            if not hits:
                return json.dumps({"result": "No relevant memories found."})
            lines = []
            for i, h in enumerate(hits, 1):
                text = h.get("original_excerpt") or h.get("content") or h.get("summary", "")
                source = h.get("source") or {}
                role = source.get("role") or h.get("role", "")
                ts = source.get("ts") or h.get("createdAt")
                role_label = _ROLE_LABEL.get(role, "")
                time_label = _format_ts(ts)
                meta_parts = [p for p in (role_label, time_label) if p]
                meta = f" [{' | '.join(meta_parts)}]" if meta_parts else ""
                lines.append(f"{i}.{meta} {text[:500]}")
            return json.dumps({"result": "\n".join(lines)})
        except Exception as e:
            logger.warning("memory_search failed: %s", e)
            return tool_error(f"Memory search failed: {e}")

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        if not self._bridge or not content:
            return
        if action not in ("add", "replace"):
            return

        from config import OWNER

        label = "user_profile" if target == "user" else "memory"
        messages = [
            {"role": "system", "content": f"[{label}] {content}"},
        ]

        def _write():
            try:
                self._bridge.ingest(
                    messages,
                    session_id=self._session_id or "memory-write",
                    owner=OWNER,
                )
                self._bridge.flush()
                logger.info(
                    "MemTensor on_memory_write: %s %s (%d chars)", action, target, len(content)
                )
            except Exception as e:
                logger.warning("MemTensor on_memory_write failed: %s", e)

        t = threading.Thread(target=_write, daemon=True, name="memtensor-memory-write")
        t.start()

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        if not self._bridge:
            return
        # Flush any deferred ingest that hasn't been picked up by queue_prefetch
        pending = self._pending_ingest
        self._pending_ingest = None
        if pending:
            try:
                from config import OWNER

                user_content, assistant_content, sid = pending
                msgs = []
                if user_content:
                    msgs.append({"role": "user", "content": user_content})
                if assistant_content:
                    msgs.append({"role": "assistant", "content": assistant_content})
                if msgs:
                    self._bridge.ingest(msgs, session_id=sid, owner=OWNER)
            except Exception as e:
                logger.debug("MemTensor deferred ingest on session end failed: %s", e)
        try:
            self._bridge.flush()
        except Exception as e:
            logger.debug("MemTensor flush on session end failed: %s", e)

    def shutdown(self) -> None:
        for t in (self._prefetch_thread, self._sync_thread):
            if t and t.is_alive():
                t.join(timeout=5.0)
        if self._bridge:
            with contextlib.suppress(Exception):
                self._bridge.shutdown()
            self._bridge = None


def register(ctx) -> None:
    """Register MemTensor as a memory provider plugin."""
    ctx.register_memory_provider(MemTensorProvider())
