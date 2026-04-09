"""MemTensor memory provider for hermes-agent.

Persistent semantic memory with hybrid search (vector + FTS + recency),
powered by memos-core via a shared bridge daemon.

Activation: set ``memory.provider: memtensor`` in ~/.hermes/config.yaml
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List

# Add this directory to sys.path so sibling modules (config, bridge_client, …) resolve
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

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


class MemTensorProvider(MemoryProvider):
    """MemTensor semantic memory — recall across sessions via bridge daemon."""

    def __init__(self) -> None:
        self._bridge = None
        self._session_id = ""
        self._prefetch_result = ""
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: threading.Thread | None = None
        self._sync_thread: threading.Thread | None = None

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
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)

        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""

        if not result:
            if not self._bridge:
                return ""
            try:
                result = self._do_recall(query)
            except Exception as e:
                logger.debug("MemTensor prefetch fallback failed: %s", e)
                return ""

        if not result:
            return ""
        return f"## Recalled Memories\n{result}"

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        def _run():
            try:
                text = self._do_recall(query)
                if text:
                    with self._prefetch_lock:
                        self._prefetch_result = text
            except Exception as e:
                logger.debug("MemTensor queue_prefetch failed: %s", e)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="memtensor-prefetch"
        )
        self._prefetch_thread.start()

    def _do_recall(self, query: str) -> str:
        if not self._bridge:
            return ""

        from config import OWNER

        parts: list[str] = []

        try:
            search_resp = self._bridge.search(
                query, max_results=5, min_score=0.4, owner=OWNER
            )
            hits = search_resp.get("hits") or search_resp.get("memories") or []
            for h in hits:
                text = h.get("original_excerpt") or h.get("content") or h.get("summary", "")
                if text:
                    parts.append(f"- {text[:500]}")
        except Exception as e:
            logger.debug("MemTensor search in prefetch failed: %s", e)

        if not parts:
            try:
                recent_resp = self._bridge.recent(limit=10, owner=OWNER)
                memories = recent_resp.get("memories") or []
                for m in memories:
                    text = m.get("content") or m.get("summary", "")
                    if text:
                        parts.append(f"- {text[:500]}")
            except Exception as e:
                logger.debug("MemTensor recent in prefetch failed: %s", e)

        return "\n".join(parts)

    def sync_turn(
        self, user_content: str, assistant_content: str, *, session_id: str = ""
    ) -> None:
        if not self._bridge:
            return

        sid = session_id or self._session_id or "default"
        messages = [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]

        def _sync():
            try:
                from config import OWNER
                self._bridge.ingest(messages, session_id=sid, owner=OWNER)
                self._bridge.flush()
            except Exception as e:
                logger.warning("MemTensor sync_turn failed: %s", e)

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)

        self._sync_thread = threading.Thread(
            target=_sync, daemon=True, name="memtensor-sync"
        )
        self._sync_thread.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [MEMORY_SEARCH_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
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
                lines.append(f"{i}. {text[:500]}")
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
                logger.info("MemTensor on_memory_write: %s %s (%d chars)", action, target, len(content))
            except Exception as e:
                logger.warning("MemTensor on_memory_write failed: %s", e)

        t = threading.Thread(target=_write, daemon=True, name="memtensor-memory-write")
        t.start()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if not self._bridge:
            return
        try:
            self._bridge.flush()
        except Exception as e:
            logger.debug("MemTensor flush on session end failed: %s", e)

    def shutdown(self) -> None:
        for t in (self._prefetch_thread, self._sync_thread):
            if t and t.is_alive():
                t.join(timeout=5.0)
        if self._bridge:
            try:
                self._bridge.shutdown()
            except Exception:
                pass
            self._bridge = None


def register(ctx) -> None:
    """Register MemTensor as a memory provider plugin."""
    ctx.register_memory_provider(MemTensorProvider())
