"""MemOS Local — Hermes memory provider (Reflect2Evolve V7 core).

Implements the ``agent.memory_provider.MemoryProvider`` interface exposed
by the hermes-agent host (see
``hermes-agent/agent/memory_provider.py``). All heavy lifting lives in the
Node.js ``memos-local-plugin`` core; this adapter is a thin Python client
that speaks JSON-RPC 2.0 over stdio to ``bridge.cts``.

Discovery
---------
The hermes-agent host discovers memory providers via
``plugins/memory/__init__.py::load_memory_provider`` which:

  1. Looks for a ``register(ctx)`` function and calls it with a
     ``_ProviderCollector`` that has ``register_memory_provider(provider)``.
  2. Falls back to finding a ``MemoryProvider`` subclass in the module.

We support **both** entry points.

Activation
----------
Set ``memory.provider: memtensor`` in ``~/.hermes/config.yaml`` (or the
relevant `$HERMES_HOME`).

Lifecycle mapping (V7 §0.2)
---------------------------

| Hermes hook          | Our action                                    |
| -------------------- | --------------------------------------------- |
| ``initialize``       | spawn bridge; open session + episode          |
| ``on_turn_start``    | record turn count; stash message              |
| ``prefetch``         | ``turn.start`` RPC → Tier 1+2+3 retrieval     |
| ``queue_prefetch``   | background thread: prefetch + flush pending   |
| ``sync_turn``        | queue a deferred ``turn.end`` RPC             |
| ``on_session_end``   | flush pending + close episode + close session |
| ``on_pre_compress``  | extract a short memory summary               |
| ``on_delegation``    | record a subagent outcome as a trace         |
| ``get_tool_schemas`` | expose ``memory_search`` + ``memory_timeline``|
| ``handle_tool_call`` | dispatch to ``memory.search`` / ``.timeline`` |
| ``shutdown``         | close bridge                                  |

Threading: all JSON-RPC calls are synchronous. ``queue_prefetch`` runs on
a daemon thread the provider owns.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sys
import threading
import time

from pathlib import Path
from typing import Any


# Add our own directory to sys.path so the submodule imports below work
# whether hermes-agent loaded us bundled or via the user-plugin namespace.
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from bridge_client import MemosBridgeClient  # noqa: E402
from daemon_manager import ensure_bridge_running, shutdown_bridge  # noqa: E402


try:  # pragma: no cover — host-provided base class, absent in unit tests
    from agent.memory_provider import MemoryProvider  # type: ignore
except Exception:  # pragma: no cover

    class MemoryProvider:  # type: ignore[no-redef]
        """Fallback base class used when running outside hermes-agent host.

        Defines only the attributes the adapter reads so ``pyright`` and
        ``pytest`` stay happy in standalone test runs.
        """


logger = logging.getLogger(__name__)

PLUGIN_ID = "memos-local-hermes"
PLUGIN_VERSION = "2.0.0-beta.1"


class MemTensorProvider(MemoryProvider):
    """MemOS Reflect2Evolve memory for hermes-agent.

    Wraps a JSON-RPC client around the shared ``memos-local-plugin`` core.

    Only methods that Hermes actually calls are overridden here; every
    optional hook stays default so future versions of the base class can
    grow without breaking us.
    """

    def __init__(self) -> None:
        self._bridge: MemosBridgeClient | None = None
        self._session_id: str = ""
        self._episode_id: str = ""
        self._hermes_home: str = ""
        self._agent_identity: str = "hermes"
        self._platform: str = "cli"
        self._turn_number: int = 0
        # Last user turn text — used by `sync_turn` to compose `turn.end`.
        self._last_user_text: str = ""
        # Single-flight prefetch coordination.
        self._prefetch_lock = threading.Lock()
        self._prefetch_result: str = ""
        self._prefetch_thread: threading.Thread | None = None
        # Deferred turn-end payload set by `sync_turn`, flushed by
        # `queue_prefetch` / `on_session_end`.
        self._pending_turn: tuple[str, str, list[dict[str, Any]], int] | None = None

    # ─── Identity ─────────────────────────────────────────────────────────

    @property
    def name(self) -> str:  # type: ignore[override]
        return "memtensor"

    def is_available(self) -> bool:  # type: ignore[override]
        try:
            return ensure_bridge_running(probe_only=True)
        except Exception:
            return False

    # ─── Lifecycle ────────────────────────────────────────────────────────

    def initialize(self, session_id: str, **kwargs: Any) -> None:  # type: ignore[override]
        """Called once at agent startup.

        kwargs always include ``hermes_home`` and ``platform``. We stash
        them so the bridge can resolve the right `~/.hermes/memos-plugin/`
        and log the originating channel.
        """
        self._hermes_home = str(kwargs.get("hermes_home") or "")
        self._platform = str(kwargs.get("platform") or "cli")
        self._agent_identity = str(kwargs.get("agent_identity") or "hermes")
        try:
            ensure_bridge_running()
        except Exception as err:
            logger.warning("MemOS: failed to start bridge — %s", err)
            return
        try:
            self._bridge = MemosBridgeClient(tcp_host="127.0.0.1", tcp_port=18911)
            resp = self._bridge.request(
                "session.open",
                {
                    "agent": "hermes",
                    "sessionId": session_id or "",
                    "meta": {
                        "hermesHome": self._hermes_home,
                        "platform": self._platform,
                        "agentIdentity": self._agent_identity,
                    },
                },
            )
            self._session_id = resp.get("sessionId") or session_id
            ep = self._bridge.request("episode.open", {"sessionId": self._session_id})
            self._episode_id = ep.get("episodeId", "")
            logger.info(
                "MemOS: bridge ready session=%s episode=%s platform=%s",
                self._session_id,
                self._episode_id,
                self._platform,
            )
        except Exception as err:
            logger.warning("MemOS: bridge init failed — %s", err)
            self._bridge = None

    def system_prompt_block(self) -> str:  # type: ignore[override]
        return (
            "# MemOS Memory\n"
            "Persistent long-term memory is active. Call `memory_search` to "
            "fetch prior context or `memory_timeline` to inspect a past "
            "episode. Relevant memories are automatically injected at the "
            "start of every turn."
        )

    # ─── Turn-level hooks ─────────────────────────────────────────────────

    def on_turn_start(self, turn_number: int, message: str, **_kwargs: Any) -> None:  # type: ignore[override]
        self._turn_number = int(turn_number or 0)
        self._last_user_text = (message or "").strip()

    def prefetch(self, query: str, *, session_id: str = "") -> str:  # type: ignore[override]
        """Inject relevant memories ahead of the next model call.

        If ``queue_prefetch`` already ran for this turn, return the
        cached result immediately. Otherwise synchronously run
        ``turn.start`` against the bridge (small overhead).
        """
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)
        with self._prefetch_lock:
            cached = self._prefetch_result
            self._prefetch_result = ""
        if cached:
            return cached
        if not self._bridge:
            return ""
        try:
            return self._turn_start(query, session_id=session_id)
        except Exception as err:
            logger.debug("MemOS: prefetch failed — %s", err)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:  # type: ignore[override]
        """Background prefetch + flush the previous turn's pending write."""
        pending = self._pending_turn
        self._pending_turn = None

        def _run() -> None:
            try:
                result = self._turn_start(query, session_id=session_id) if self._bridge else ""
                if result:
                    with self._prefetch_lock:
                        self._prefetch_result = result
            except Exception as err:
                logger.debug("MemOS: queue_prefetch failed — %s", err)

            if pending and self._bridge:
                try:
                    self._turn_end(*pending)
                except Exception as err:
                    logger.warning("MemOS: deferred turn.end failed — %s", err)

        t = threading.Thread(target=_run, daemon=True, name="memos-prefetch")
        self._prefetch_thread = t
        t.start()

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:  # type: ignore[override]
        """Persist a completed turn.

        Hermes' base class only passes text. Tool calls are **not** in
        this signature — we extract them from the bridge's own
        ``on_delegation`` pipeline or from the assistant text when it
        embeds JSON blocks. To avoid blocking the agent loop we defer
        the ``turn.end`` RPC to the next prefetch cycle.
        """
        if not self._bridge:
            return
        self._pending_turn = (
            user_content or self._last_user_text,
            assistant_content or "",
            [],  # tool_calls — filled by on_delegation or via bridge hooks
            int(time.time() * 1000),
        )
        # Update last_user_text for the next turn.
        if user_content:
            self._last_user_text = user_content

    def on_delegation(
        self,
        task: str,
        result: str,
        *,
        child_session_id: str = "",
        **_kwargs: Any,
    ) -> None:  # type: ignore[override]
        """Record a subagent outcome.

        Hermes invokes this on the **parent** when a subagent finishes.
        We write it as a synthetic trace so decision-repair can see
        failure bursts and so Tier 2 retrieval can surface past
        delegations.
        """
        if not self._bridge:
            return
        with contextlib.suppress(Exception):
            self._bridge.request(
                "subagent.record",
                {
                    "sessionId": self._session_id,
                    "childSessionId": child_session_id or None,
                    "task": task,
                    "result": result,
                    "ts": int(time.time() * 1000),
                },
            )

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:  # type: ignore[override]
        """Extract a compression-time memory summary.

        Hermes calls this right before discarding old messages; we
        surface a tight summary of the relevant retrieval packet so
        the compressor can preserve it alongside its own summary.
        """
        if not self._bridge or not self._last_user_text:
            return ""
        with contextlib.suppress(Exception):
            packet = self._turn_start(self._last_user_text, session_id=self._session_id)
            if packet:
                return f"MemOS memory snapshot (preserved across compression):\n{packet}"
        return ""

    # ─── Tool surface ─────────────────────────────────────────────────────

    def get_tool_schemas(self) -> list[dict[str, Any]]:  # type: ignore[override]
        return [
            {
                "name": "memory_search",
                "description": (
                    "Search the local MemOS memory (traces, policies, world models, skills). "
                    "Prefer this before claiming prior context is unavailable."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Short natural-language query (2–5 key words).",
                        },
                        "maxResults": {
                            "type": "integer",
                            "default": 10,
                            "minimum": 1,
                            "maximum": 50,
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "memory_timeline",
                "description": "Return the ordered traces for an episode id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "episodeId": {"type": "string"},
                        "limit": {"type": "integer", "default": 20, "maximum": 100},
                    },
                    "required": ["episodeId"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **_kwargs: Any) -> str:  # type: ignore[override]
        if not self._bridge:
            return json.dumps({"error": "bridge not connected"})
        try:
            if tool_name == "memory_search":
                query = (args.get("query") or "").strip()
                if not query:
                    return json.dumps({"error": "missing query"})
                max_results = int(args.get("maxResults", 10))
                resp = self._bridge.request(
                    "memory.search",
                    {
                        "agent": "hermes",
                        "query": query,
                        "sessionId": self._session_id,
                        "topK": {
                            "tier1": max_results,
                            "tier2": max_results,
                            "tier3": max_results,
                        },
                    },
                )
                return json.dumps({"hits": resp.get("hits", [])})
            if tool_name == "memory_timeline":
                resp = self._bridge.request(
                    "memory.timeline",
                    {"episodeId": args.get("episodeId", self._episode_id)},
                )
                limit = int(args.get("limit", 20))
                traces = resp.get("traces", [])[:limit]
                return json.dumps({"traces": traces})
        except Exception as err:
            return json.dumps({"error": str(err)})
        return json.dumps({"error": f"unknown tool: {tool_name}"})

    # ─── Config schema (for `hermes memory setup`) ────────────────────────

    def get_config_schema(self) -> list[dict[str, Any]]:  # type: ignore[override]
        """Fields the host's `hermes memory setup` wizard will collect.

        Secrets go to .env; everything else to the provider config file
        written by ``save_config``.
        """
        return [
            {
                "key": "viewer_port",
                "description": "Local HTTP port for the MemOS viewer.",
                "default": 18910,
                "required": False,
            },
            {
                "key": "llm_provider",
                "description": "LLM for V7 reward / l2.induction / l3.abstraction.",
                "choices": ["openai_compatible", "anthropic", "gemini", "host", "local_only"],
                "default": "openai_compatible",
                "required": False,
            },
            {
                "key": "llm_api_key",
                "description": "API key for the chosen LLM provider.",
                "secret": True,
                "env_var": "MEMOS_LLM_API_KEY",
                "required": False,
            },
            {
                "key": "embedding_provider",
                "description": "Embedding provider (local = MiniLM on-device).",
                "choices": [
                    "local",
                    "openai_compatible",
                    "gemini",
                    "cohere",
                    "voyage",
                    "mistral",
                ],
                "default": "local",
                "required": False,
            },
        ]

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:  # type: ignore[override]
        """Write non-secret config to `<hermes_home>/memos-plugin/config.yaml`."""
        if not hermes_home:
            return
        import yaml  # lazy import — hermes already ships pyyaml

        target_dir = Path(hermes_home) / "memos-plugin"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "config.yaml"

        payload: dict[str, Any] = {"version": 1}
        if "viewer_port" in values:
            payload["viewer"] = {"port": int(values["viewer_port"])}
        if "llm_provider" in values:
            llm: dict[str, Any] = {"provider": values["llm_provider"]}
            if values.get("llm_provider") != "local_only":
                llm["apiKey"] = ""
            payload["llm"] = llm
        if "embedding_provider" in values:
            payload["embedding"] = {"provider": values["embedding_provider"]}

        target.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
        target.chmod(0o600)

    # ─── Session-end ──────────────────────────────────────────────────────

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:  # type: ignore[override]
        if not self._bridge:
            return
        pending = self._pending_turn
        self._pending_turn = None
        if pending:
            with contextlib.suppress(Exception):
                self._turn_end(*pending)
        # In TCP mode the daemon bridge owns the session — don't close it.
        # The pipeline will finalize the episode naturally on the daemon side.
        if not self._bridge._tcp_mode:
            with contextlib.suppress(Exception):
                self._bridge.request("episode.close", {"episodeId": self._episode_id})
            with contextlib.suppress(Exception):
                self._bridge.request("session.close", {"sessionId": self._session_id})

    def shutdown(self) -> None:  # type: ignore[override]
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)
        if self._bridge:
            with contextlib.suppress(Exception):
                self._bridge.close()
            self._bridge = None
        with contextlib.suppress(Exception):
            shutdown_bridge()

    # ─── Internals ────────────────────────────────────────────────────────

    def _turn_start(self, query: str, *, session_id: str = "") -> str:
        assert self._bridge is not None
        resp = self._bridge.request(
            "turn.start",
            {
                "agent": "hermes",
                "sessionId": session_id or self._session_id,
                "userText": query,
                "ts": int(time.time() * 1000),
            },
        )
        context = (resp or {}).get("injectedContext") or ""
        if not context:
            return ""
        return f"## Recalled Memories\n{context}"

    def _turn_end(
        self,
        user_content: str,
        assistant_content: str,
        tool_calls: list[dict[str, Any]],
        ts_ms: int,
    ) -> None:
        if not self._bridge:
            return
        self._bridge.request(
            "turn.end",
            {
                "agent": "hermes",
                "sessionId": self._session_id,
                "episodeId": self._episode_id,
                "agentText": assistant_content,
                "userText": user_content,
                "toolCalls": tool_calls,
                "ts": ts_ms,
            },
        )


# ─── Discovery entry points ───────────────────────────────────────────────


# Pattern 1: `register(ctx)` — preferred by `plugins/memory/__init__.py`.
def register(ctx: Any) -> None:
    """hermes-agent plugin entry point."""
    ctx.register_memory_provider(MemTensorProvider())


# Pattern 2: exported class — fallback via `issubclass(MemoryProvider)`.
__all__ = ["PLUGIN_ID", "PLUGIN_VERSION", "MemTensorProvider", "register"]
