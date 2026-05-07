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
| ``get_tool_schemas`` | expose memory, skill, and environment tools   |
| ``handle_tool_call`` | dispatch to MemOS JSON-RPC tool methods       |
| ``shutdown``         | close bridge                                  |

Threading: all JSON-RPC calls are synchronous. ``queue_prefetch`` runs on
a daemon thread the provider owns.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
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

from bridge_client import BridgeError, MemosBridgeClient  # noqa: E402
from daemon_manager import ensure_bridge_running  # noqa: E402


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

_HERMES_INTERNAL_REVIEW_PREFIXES = (
    "review the conversation above and consider saving to memory if appropriate.",
    "review the conversation above and update the skill library.",
    "review the conversation above and update two things:",
    "review the conversation above and consider saving or updating a skill if appropriate.",
    "review the conversation above and consider whether a skill should be saved or updated.",
)


def _is_hermes_internal_review_prompt(message: str) -> bool:
    """Return True for Hermes' own background memory/skill review turns."""
    normalized = " ".join((message or "").strip().lower().split())
    if not normalized:
        return False
    return any(normalized.startswith(prefix) for prefix in _HERMES_INTERNAL_REVIEW_PREFIXES)


def _is_explicit_delegation_request(message: str) -> bool:
    """Return True when the user explicitly asks Hermes to use a subagent."""
    text = " ".join((message or "").strip().lower().split())
    if not text:
        return False
    delegation_terms = (
        "subagent",
        "sub-agent",
        "sub agent",
        "delegate",
        "delegation",
        "子代理",
        "子任务",
        "派一个",
        "派发",
    )
    return any(term in text for term in delegation_terms)


def _is_verifier_feedback_prompt(message: str) -> bool:
    """Return True for explicit evaluator/verifier feedback turns."""
    text = " ".join((message or "").strip().lower().split())
    if not text:
        return False

    # Strong markers: formal verifier feedback
    strong_markers = (
        "本任务评为反例",
        "本任务评为正例",
        "verifier feedback",
        "verification feedback",
        "task rated as counterexample",
        "task is rated as counterexample",
        "r <= -0.5",
        "r≤-0.5",
        "r >= 0.5",
        "r≥0.5",
    )
    if any(marker in text for marker in strong_markers):
        return True
    if re.search(r"\br\s*(?:<=|>=|≤|≥)\s*-?\d+(?:\.\d+)?", text):
        return True

    # User correction markers: natural corrective feedback
    correction_markers = (
        "不对",
        "错了",
        "不是",
        "不行",
        "不对的",
        "写错了",
        "做错了",
        "理解错了",
        "wrong",
        "incorrect",
        "not right",
        "not correct",
        "that's wrong",
        "this is wrong",
    )
    if any(marker in text for marker in correction_markers):
        return True

    # Weak markers: require "feedback/反馈" + action keywords
    if "feedback" not in text and "反馈" not in text:
        return False
    feedback_markers = (
        "failed",
        "failure",
        "pass",
        "passed",
        "success",
        "succeeded",
        "should",
        "avoid",
        "next time",
        "失败",
        "成功",
        "应该",
        "不要",
        "下次",
    )
    return any(marker in text for marker in feedback_markers)


def _feedback_polarity(message: str) -> str:
    text = " ".join((message or "").strip().lower().split())
    if re.search(r"r\s*(?:<=|≤)\s*-?0\.5", text):
        return "negative"
    if "反例" in text:
        return "negative"
    if any(term in text for term in ("failed", "failure", "wrong", "incorrect", "not acceptable", "错误", "失败", "不对")):
        return "negative"
    if re.search(r"r\s*(?:>=|≥)\s*0\.5", text):
        return "positive"
    if "正例" in text:
        return "positive"
    if any(term in text for term in ("passed", "success", "succeeded", "correct", "great", "成功", "通过", "正确")):
        return "positive"
    return "neutral"


def _feedback_magnitude(message: str, polarity: str) -> float:
    text = " ".join((message or "").strip().lower().split())
    match = re.search(r"\br\s*(?:=|:|<=|>=|≤|≥)\s*(-?\d+(?:\.\d+)?)", text)
    if match:
        with contextlib.suppress(Exception):
            return max(0.0, min(1.0, abs(float(match.group(1)))))
    return 1.0 if polarity in {"positive", "negative"} else 0.6


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
        self._last_host_runtime: dict[str, str] = {}
        self._turn_number: int = 0
        # Last user turn text — used by `sync_turn` to compose `turn.end`.
        self._last_user_text: str = ""
        # Single-flight prefetch coordination.
        self._prefetch_lock = threading.Lock()
        self._prefetch_result: str = ""
        self._prefetch_thread: threading.Thread | None = None
        # Tool calls accumulated via the Hermes `post_tool_call` plugin
        # hook — flushed alongside user/assistant text in `sync_turn`.
        self._tool_calls: list[dict[str, Any]] = []
        # Reasoning text captured via the `post_llm_call` hook for the
        # current turn. Hermes' MemoryProvider.sync_turn signature only
        # carries the visible assistant text; reasoning lives on the
        # `assistant` message's `reasoning` field. We capture it from
        # `post_llm_call`'s `conversation_history` so the viewer can
        # show the model's thinking like OpenClaw does.
        self._turn_thinking: str = ""
        self._hook_registered = False
        self._bridge_keepalive_stop = threading.Event()
        self._bridge_keepalive_thread: threading.Thread | None = None
        # Hermes runs background memory/skill reviewers by forking an agent and
        # appending a synthetic user turn. That turn is instruction plumbing,
        # not a human utterance, so it must not become a MemOS trace.
        self._skip_current_turn = False
        # Track the last trace ID for feedback submission
        self._last_trace_id: str = ""

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

        We open the session here but NOT the episode — episode creation
        is deferred to ``_ensure_episode()`` (called from the first
        ``on_turn_start``), so the actual user message can be passed as
        the episode's initial text instead of a generic placeholder.
        """
        self._session_id = session_id or self._session_id
        self._hermes_home = str(kwargs.get("hermes_home") or "")
        self._platform = str(kwargs.get("platform") or "cli")
        self._agent_identity = str(kwargs.get("agent_identity") or "hermes")
        try:
            ensure_bridge_running()
        except Exception as err:
            logger.warning("MemOS: failed to start bridge — %s", err)
            return
        try:
            self._bridge = MemosBridgeClient()
            # Register the fallback LLM handler BEFORE we open the
            # session so it is available the very first time the
            # plugin's facade asks for help (e.g. on the first
            # `turn.start` retrieval call).
            self._bridge.register_host_handler(
                "host.llm.complete",
                self._handle_host_llm_complete,
            )
            self._open_session(session_id)
            logger.info(
                "MemOS: bridge ready session=%s platform=%s (episode deferred)",
                self._session_id,
                self._platform,
            )
        except Exception as err:
            logger.warning("MemOS: bridge init failed — %s", err)
            self._bridge = None
        # Register a Hermes plugin hook to capture tool calls as they
        # happen. The `post_tool_call` hook fires after every tool
        # dispatch (write_file, terminal, search_files, etc.) with the
        # tool name, arguments, and result. We accumulate them and
        # flush in `sync_turn`.
        self._register_tool_call_hook()
        self._start_bridge_keepalive()

    def system_prompt_block(self) -> str:  # type: ignore[override]
        return (
            "# MemOS Memory\n"
            "Persistent long-term memory is active. Call `memory_search`, "
            "`memory_get`, `memory_timeline`, `memory_environment`, "
            "`skill_list`, or `skill_get` when prior context or learned "
            "procedures would help. Relevant memories are automatically "
            "injected at the start of every turn."
        )

    # ─── Episode tracking ─────────────────────────────────────────────────
    #
    # We DON'T call `episode.open` ourselves. The core's `onTurnStart`
    # (RPC `turn.start`) automatically opens / reopens / boundary-cuts
    # an episode based on V7 §0.1 relation classification. Calling
    # `episode.open` from the adapter creates an orphan episode that
    # never receives any traces — and our `episode.close` then closes
    # that empty orphan, leaving the *real* episode (the one the
    # pipeline auto-created) without the close trigger that fires
    # reflect → reward → L2 / L3 / Skill.
    #
    # The real episode id surfaces in the `turn.start` response's
    # `query.episodeId` field; we stash it here so `on_session_end`
    # can close the right one.

    # ─── Tool call capture via Hermes plugin hook ──────────────────────────

    def _matches_session(self, session_id: str = "") -> bool:
        """Return True when a global Hermes hook belongs to this provider."""
        return not session_id or not self._session_id or session_id == self._session_id

    def _runtime_namespace(self) -> dict[str, Any]:
        profile_id = (self._agent_identity or "").strip() or "default"
        normalized_home = self._hermes_home.replace("\\", "/").rstrip("/")
        if normalized_home:
            marker = "/profiles/"
            if marker in normalized_home:
                profile_id = normalized_home.rsplit(marker, 1)[-1].split("/", 1)[0] or profile_id
            elif normalized_home.endswith("/.hermes") and profile_id in ("", "hermes"):
                profile_id = "default"
        return {
            "agentKind": "hermes",
            "profileId": profile_id,
            "profileLabel": profile_id,
        }

    def _register_tool_call_hook(self) -> None:
        if self._hook_registered:
            return
        try:
            from hermes_cli.plugins import (
                get_plugin_manager,  # pyright: ignore[reportMissingImports]
            )

            mgr = get_plugin_manager()
            mgr._hooks.setdefault("post_tool_call", []).append(self._on_post_tool_call)
            mgr._hooks.setdefault("post_llm_call", []).append(self._on_post_llm_call)
            self._hook_registered = True
            logger.debug("MemOS: registered post_tool_call + post_llm_call hooks")
        except Exception as err:
            logger.debug("MemOS: could not register tool hook — %s", err)

    def _on_post_tool_call(
        self,
        *,
        tool_name: str = "",
        args: dict | None = None,
        result: str = "",
        tool_call_id: str = "",
        session_id: str = "",
        **kw: Any,
    ) -> None:
        """Accumulate a tool call record for the current turn.

        We keep the host's ``tool_call_id`` on a private ``_id`` field so
        ``_on_post_llm_call`` can later attach the assistant message's
        ``reasoning`` (the model's "thinking before this tool") to the
        right entry. Hermes/OpenAI-compatible providers may surface the
        same call under ``id``, ``call_id``, or ``response_item_id``; keep
        all aliases so post-LLM and post-tool events can be merged even
        when a particular tool omits one field. Private fields are stripped
        before the JSON-RPC send.
        """
        if not self._matches_session(session_id):
            return
        ids = self._tool_call_ids(
            {
                "id": tool_call_id,
                "call_id": kw.get("call_id"),
                "response_item_id": kw.get("response_item_id"),
                "tool_call_id": kw.get("tool_call_id"),
            }
        )
        input_text = (
            json.dumps(args, ensure_ascii=False) if isinstance(args, dict) else str(args or "")
        )
        timing = self._coerce_tool_timing(kw)

        existing = self._find_tool_call(ids)
        if existing is not None:
            existing["name"] = tool_name or existing.get("name") or "unknown_tool"
            existing["input"] = input_text or existing.get("input", "")
            existing["output"] = (result or "")[:4000]
            existing["_ids"] = sorted(set((existing.get("_ids") or []) + ids))
            existing["_id"] = existing.get("_id") or (ids[0] if ids else "")
            if existing.get("_id"):
                existing["toolCallId"] = existing["_id"]
            if timing:
                existing.update(timing)
            return

        call = {
            "name": tool_name,
            "input": input_text,
            "output": (result or "")[:4000],
            "_id": ids[0] if ids else "",
            "_ids": ids,
            "toolCallId": ids[0] if ids else "",
        }
        if timing:
            call.update(timing)
        self._tool_calls.append(call)

    def _coerce_tool_timing(self, payload: dict[str, Any]) -> dict[str, int] | None:
        """Preserve real tool timing if Hermes exposes it in hook kwargs."""
        started = self._coerce_epoch_ms(
            payload.get("startedAt")
            or payload.get("started_at")
            or payload.get("startTime")
            or payload.get("start_time")
        )
        ended = self._coerce_epoch_ms(
            payload.get("endedAt")
            or payload.get("ended_at")
            or payload.get("endTime")
            or payload.get("end_time")
        )
        if started is not None and ended is not None and ended > started:
            return {"startedAt": started, "endedAt": ended}

        duration = self._coerce_duration_ms(
            payload.get("durationMs")
            or payload.get("duration_ms")
            or payload.get("elapsedMs")
            or payload.get("elapsed_ms")
            or payload.get("latencyMs")
            or payload.get("latency_ms")
        )
        if duration is not None and duration > 0:
            end_ms = int(time.time() * 1000)
            return {"startedAt": end_ms - duration, "endedAt": end_ms}

        return None

    @staticmethod
    def _coerce_epoch_ms(value: Any) -> int | None:
        if isinstance(value, (int, float)):
            numeric = float(value)
        elif isinstance(value, str):
            try:
                numeric = float(value)
            except ValueError:
                return None
        else:
            return None
        if numeric <= 0:
            return None
        # Accept seconds or milliseconds.
        if numeric < 10_000_000_000:
            numeric *= 1000
        return int(numeric)

    @staticmethod
    def _coerce_duration_ms(value: Any) -> int | None:
        if isinstance(value, (int, float)):
            numeric = float(value)
        elif isinstance(value, str):
            try:
                numeric = float(value)
            except ValueError:
                return None
        else:
            return None
        if numeric <= 0:
            return None
        return int(numeric)

    def _on_post_llm_call(
        self,
        *,
        conversation_history: list[dict[str, Any]] | None = None,
        user_message: str = "",
        session_id: str = "",
        **_kw: Any,
    ) -> None:
        """Capture reasoning content from assistant messages in this turn.

        Hermes' ``_build_assistant_message`` writes the model's reasoning
        text into ``msg["reasoning"]`` (extended thinking, OpenAI o1
        ``reasoning_content``, etc.). The default ``MemoryProvider.sync_turn``
        only carries plain ``user_content`` / ``assistant_content``, so we
        fish the reasoning out of the conversation history fired with the
        ``post_llm_call`` hook and stash it for the upcoming ``sync_turn``.

        We walk through assistant messages of the current turn (those
        after the most recent user message). For each message that
        contains ``tool_calls``, we attach two pieces of pre-tool context
        to each captured tool call:

        * ``thinkingBefore`` — private/model-native reasoning.
        * ``assistantTextBefore`` — visible assistant narration emitted in
          the same message before the tool call.

        The final reasoning (the message that produced the user-facing
        reply) becomes the turn-level ``agentThinking``.
        """
        if not self._matches_session(session_id):
            return
        if not conversation_history:
            return

        # Find the last user message and walk forward from there.
        last_user_idx = -1
        for i, msg in enumerate(conversation_history):
            if msg.get("role") == "user":
                last_user_idx = i

        # Build maps keyed by tool_call_id so post-tool events can be
        # merged with the canonical assistant message later.
        thinking_by_id: dict[str, str] = {}
        assistant_text_by_id: dict[str, str] = {}
        ordered_tool_calls: list[dict[str, Any]] = []
        ordered_object_ids: set[int] = set()
        # Reasoning of the message that produced the final reply (no
        # tool_calls in that message) becomes the turn-level thinking.
        final_reasoning = ""

        for msg in conversation_history[last_user_idx + 1 :]:
            if msg.get("role") != "assistant":
                continue
            r = msg.get("reasoning")
            r_str = r.strip() if isinstance(r, str) and r.strip() else ""
            content_str = self._assistant_text(msg.get("content"))
            tcs = msg.get("tool_calls")
            if isinstance(tcs, list) and tcs:
                # Reasoning preceded these tool calls.
                for tc in tcs:
                    if not isinstance(tc, dict):
                        continue
                    ids = self._tool_call_ids(tc)
                    if r_str:
                        for tc_id in ids:
                            thinking_by_id[tc_id] = r_str
                    if content_str:
                        for tc_id in ids:
                            assistant_text_by_id[tc_id] = content_str

                    existing = self._find_tool_call(ids)
                    # Some Hermes tools (for example planner/todo-style
                    # host tools) appear in the assistant message but do
                    # not fire `post_tool_call`. Add a placeholder so the
                    # trace still records the tool decision and reasoning;
                    # `post_tool_call` will merge real output later if it
                    # eventually arrives.
                    if existing is None:
                        existing = {
                            "name": self._tool_name(tc),
                            "input": self._tool_input(tc),
                            "output": "",
                            "thinkingBefore": r_str or "",
                            "assistantTextBefore": content_str or "",
                            "_id": ids[0] if ids else "",
                            "_ids": ids,
                            "toolCallId": ids[0] if ids else "",
                        }
                        self._tool_calls.append(existing)
                    else:
                        # Preserve output captured by post_tool_call, but
                        # let the LLM message supply canonical order,
                        # input/name aliases, and thinkingBefore.
                        existing["name"] = existing.get("name") or self._tool_name(tc)
                        existing["input"] = existing.get("input") or self._tool_input(tc)
                        existing["thinkingBefore"] = r_str or existing.get("thinkingBefore", "")
                        existing["assistantTextBefore"] = content_str or existing.get(
                            "assistantTextBefore", ""
                        )
                        existing["_ids"] = sorted(set((existing.get("_ids") or []) + ids))
                        existing["_id"] = existing.get("_id") or (ids[0] if ids else "")
                        if existing.get("_id"):
                            existing["toolCallId"] = existing["_id"]

                    marker = id(existing)
                    if marker not in ordered_object_ids:
                        ordered_tool_calls.append(existing)
                        ordered_object_ids.add(marker)
            else:
                # Plain assistant reply — overwrite final_reasoning so we
                # keep the LATEST one (mirrors Hermes' ``last_reasoning``).
                if r_str:
                    final_reasoning = r_str

        # Make the turn payload follow the LLM-declared tool order. This
        # matters when post_tool_call fires for later tools before
        # post_llm_call backfills earlier planner/todo calls.
        if ordered_tool_calls:
            remaining = [tc for tc in self._tool_calls if id(tc) not in ordered_object_ids]
            self._tool_calls = ordered_tool_calls + remaining

        # Attach thinkingBefore to matching captured tool calls.
        for tc in self._tool_calls:
            ids = tc.get("_ids") or ([tc.get("_id")] if tc.get("_id") else [])
            for tc_id in ids:
                if tc_id and tc_id in thinking_by_id:
                    tc["thinkingBefore"] = thinking_by_id[tc_id]
                    break
            for tc_id in ids:
                if tc_id and tc_id in assistant_text_by_id:
                    tc["assistantTextBefore"] = assistant_text_by_id[tc_id]
                    break

        self._turn_thinking = final_reasoning

    @staticmethod
    def _assistant_text(content: Any) -> str:
        """Extract visible assistant text from Hermes/OpenAI message content."""
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    text = block.strip()
                elif isinstance(block, dict):
                    raw = block.get("text") or block.get("content")
                    text = raw.strip() if isinstance(raw, str) else ""
                else:
                    text = ""
                if text:
                    parts.append(text)
            return "\n".join(parts).strip()
        return ""

    @staticmethod
    def _tool_call_ids(raw: dict[str, Any]) -> list[str]:
        ids: list[str] = []
        for key in ("id", "call_id", "response_item_id", "tool_call_id"):
            value = raw.get(key)
            if isinstance(value, str) and value and value not in ids:
                ids.append(value)
        return ids

    @staticmethod
    def _tool_name(raw: dict[str, Any]) -> str:
        fn = raw.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("name"), str):
            return fn["name"]
        name = raw.get("name")
        return name if isinstance(name, str) and name else "unknown_tool"

    @staticmethod
    def _tool_input(raw: dict[str, Any]) -> str:
        fn = raw.get("function")
        if isinstance(fn, dict):
            args = fn.get("arguments")
            if isinstance(args, str):
                return args
            if args is not None:
                return json.dumps(args, ensure_ascii=False)
        for key in ("arguments", "args", "input"):
            args = raw.get(key)
            if isinstance(args, str):
                return args
            if args is not None:
                return json.dumps(args, ensure_ascii=False)
        return ""

    def _find_tool_call(self, ids: list[str]) -> dict[str, Any] | None:
        if not ids:
            return None
        needle = set(ids)
        for tc in self._tool_calls:
            existing = set(tc.get("_ids") or [])
            if tc.get("_id"):
                existing.add(str(tc["_id"]))
            if existing & needle:
                return tc
        return None

    # ─── Turn-level hooks ─────────────────────────────────────────────────

    def on_turn_start(self, turn_number: int, message: str, **_kwargs: Any) -> None:  # type: ignore[override]
        self._turn_number = int(turn_number or 0)
        self._skip_current_turn = _is_hermes_internal_review_prompt(message)
        self._last_user_text = "" if self._skip_current_turn else (message or "").strip()
        # Reset per-turn buffers so reasoning / tool calls captured here
        # belong only to this turn.
        self._turn_thinking = ""
        self._tool_calls = []

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
        if self._skip_current_turn or _is_hermes_internal_review_prompt(query):
            self._skip_current_turn = True
            return ""
        suppress_injection = _is_explicit_delegation_request(query)
        if cached:
            return "" if suppress_injection else cached
        if not self._ensure_bridge(session_id or self._session_id, timeout=10.0):
            return ""
        try:
            context = self._turn_start(query, session_id=session_id)
            if suppress_injection:
                # Do not let remembered "do it directly" skills override an
                # explicit user request to dispatch work to a subagent.
                return ""
            return context
        except Exception as err:
            logger.debug("MemOS: prefetch failed — %s", err)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:  # type: ignore[override]
        """No-op for MemOS.

        Hermes calls this AFTER ``sync_turn`` to warm the cache for a
        hypothetical next turn. In the V7 architecture each ``turn.end``
        triggers async capture / reward / induction work — running another
        ``turn.start`` against the same (already-closed) episode just
        races and produces ``episode already closed`` noise in the
        viewer's logs page. ``prefetch()`` (called BEFORE the next
        turn's LLM call) handles real retrieval; this hook is moot.
        """
        return

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:  # type: ignore[override]
        """Persist a completed turn immediately.

        Tool calls are captured via the Hermes ``post_tool_call``
        plugin hook (registered in ``initialize``). By the time
        ``sync_turn`` is called the full list of tool calls for this
        turn has already been accumulated in ``self._tool_calls``.
        """
        user = user_content or self._last_user_text
        assistant = assistant_content or ""
        tool_calls = self._tool_calls
        thinking = self._turn_thinking
        self._tool_calls = []
        self._turn_thinking = ""
        if self._skip_current_turn or _is_hermes_internal_review_prompt(user):
            self._skip_current_turn = False
            self._last_user_text = ""
            return
        if not self._ensure_bridge(session_id or self._session_id, timeout=75.0):
            logger.warning("MemOS: sync_turn skipped because bridge is unavailable")
            return
        logger.info(
            "MemOS: sync_turn user=%d assistant=%d tools=%d thinking=%d",
            len(user),
            len(assistant),
            len(tool_calls),
            len(thinking),
        )
        ts_ms = int(time.time() * 1000)
        feedback_submitted = False
        try:
            if user and not self._episode_id:
                self._turn_start(user, session_id=session_id or self._session_id)
            self._turn_end(
                user,
                assistant,
                tool_calls,
                ts_ms,
                agent_thinking=thinking,
            )
            if _is_verifier_feedback_prompt(user):
                self._submit_verifier_feedback(user, assistant, ts_ms)
                feedback_submitted = True
        except Exception as err:
            if not self._is_transport_closed(err):
                logger.warning("MemOS: sync_turn turn.end failed — %s", err)
            else:
                logger.warning(
                    "MemOS: bridge transport closed during sync_turn; "
                    "reconnecting and retrying once — %s",
                    err,
                )
                try:
                    self._reconnect_bridge(session_id or self._session_id, timeout=75.0)
                    if user:
                        self._turn_start(user, session_id=session_id or self._session_id)
                    self._turn_end(
                        user,
                        assistant,
                        tool_calls,
                        ts_ms,
                        agent_thinking=thinking,
                    )
                    if _is_verifier_feedback_prompt(user) and not feedback_submitted:
                        self._submit_verifier_feedback(user, assistant, ts_ms)
                        feedback_submitted = True
                except Exception:
                    logger.exception(
                        "MemOS: sync_turn failed after bridge reconnect; "
                        "memory turn was not persisted"
                    )
        if user_content:
            self._last_user_text = user_content

    def on_delegation(
        self,
        task: str,
        result: str,
        *,
        child_session_id: str = "",
        **kwargs: Any,
    ) -> None:  # type: ignore[override]
        """Record a subagent outcome.

        Hermes invokes this on the **parent** when a subagent finishes.
        We write it as a synthetic trace so decision-repair can see
        failure bursts and so Tier 2 retrieval can surface past
        delegations.
        """
        if not self._ensure_bridge(self._session_id, timeout=30.0):
            return
        try:
            if not self._episode_id and self._last_user_text:
                self._turn_start(self._last_user_text, session_id=self._session_id)
            hook_meta = {
                "hookKwargs": kwargs,
            }
            self._bridge.request(
                "subagent.record",
                {
                    "sessionId": self._session_id,
                    "episodeId": self._episode_id or None,
                    "childSessionId": child_session_id or None,
                    "task": task,
                    "result": result,
                    "toolCalls": self._extract_child_tool_calls(child_session_id),
                    "ts": int(time.time() * 1000),
                    "meta": hook_meta,
                },
            )
        except Exception as err:
            logger.warning("MemOS: subagent.record failed — %s", err)

    def _extract_child_tool_calls(self, child_session_id: str = "") -> list[dict[str, Any]]:
        """Best-effort recovery of subagent tool calls from Hermes session JSON.

        Hermes invokes ``on_delegation`` on the parent and only passes the
        child task/result. The child transcript is still persisted under
        ``$HERMES_HOME/sessions/session_<id>.json``, so we read that file to
        preserve structured tool use in the MemOS child episode.
        """
        if not child_session_id:
            return []
        sessions_dir = (
            Path(self._hermes_home).expanduser() / "sessions"
            if self._hermes_home
            else Path.home() / ".hermes" / "sessions"
        )
        session_path = sessions_dir / f"session_{child_session_id}.json"
        try:
            payload = json.loads(session_path.read_text(encoding="utf-8"))
        except Exception as err:
            logger.debug("MemOS: child session tool extraction skipped — %s", err)
            return []

        messages = payload.get("messages")
        if not isinstance(messages, list):
            return []

        tool_outputs: dict[str, str] = {}
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            tool_call_id = str(message.get("tool_call_id") or "")
            if tool_call_id:
                tool_outputs[tool_call_id] = str(message.get("content") or "")[:4000]

        base_ts = int(time.time() * 1000)
        calls: list[dict[str, Any]] = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            raw_calls = message.get("tool_calls")
            if not isinstance(raw_calls, list):
                continue
            for raw_call in raw_calls:
                if not isinstance(raw_call, dict):
                    continue
                function = raw_call.get("function")
                if not isinstance(function, dict):
                    function = {}
                call_id = str(
                    raw_call.get("id")
                    or raw_call.get("call_id")
                    or raw_call.get("tool_call_id")
                    or ""
                )
                raw_args = function.get("arguments", raw_call.get("arguments", ""))
                output = tool_outputs.get(call_id, "")
                call: dict[str, Any] = {
                    "name": str(function.get("name") or raw_call.get("name") or "tool"),
                    "input": self._json_or_raw(raw_args),
                    "output": output,
                    "startedAt": base_ts + len(calls),
                    "endedAt": base_ts + len(calls),
                }
                parsed_output = self._json_or_raw(output)
                if isinstance(parsed_output, dict) and parsed_output.get("error"):
                    call["errorCode"] = "tool_error"
                calls.append(call)
        return calls

    @staticmethod
    def _json_or_raw(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        try:
            return json.loads(value)
        except Exception:
            return value

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

    @staticmethod
    def _clip(value: Any, limit: int = 1200) -> str:
        text = "" if value is None else str(value)
        return text if len(text) <= limit else text[:limit] + "..."

    @staticmethod
    def _int_arg(args: dict[str, Any], key: str, default: int, lower: int, upper: int) -> int:
        try:
            value = int(args.get(key, default))
        except Exception:
            value = default
        return max(lower, min(upper, value))

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
                        "sessionScope": {
                            "type": "boolean",
                            "default": False,
                            "description": "Restrict results to the current Hermes session only.",
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "memory_get",
                "description": (
                    "Fetch the full body of a memory item by id. `kind` can be "
                    '"trace" (default), "policy", or "world_model".'
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "kind": {
                            "type": "string",
                            "enum": ["trace", "policy", "world_model"],
                            "default": "trace",
                        },
                    },
                    "required": ["id"],
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
            {
                "name": "skill_list",
                "description": (
                    "List callable skills the agent can invoke. Filter by status "
                    "(candidate | active | archived)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["candidate", "active", "archived"],
                        },
                        "limit": {
                            "type": "integer",
                            "default": 10,
                            "minimum": 1,
                            "maximum": 50,
                        },
                    },
                },
            },
            {
                "name": "memory_environment",
                "description": (
                    "Return accumulated environment knowledge (L3 world models): "
                    "structural facts, behavioral rules, and project constraints."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Optional keyword query; omit to list recent world models.",
                        },
                        "limit": {
                            "type": "integer",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 30,
                        },
                    },
                },
            },
            {
                "name": "skill_get",
                "description": "Return the full invocation guide for a crystallized skill.",
                "parameters": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}},
                    "required": ["id"],
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
                max_results = self._int_arg(args, "maxResults", 10, 1, 50)
                params: dict[str, Any] = {
                    "agent": "hermes",
                    "namespace": self._runtime_namespace(),
                    "query": query,
                    "topK": {
                        "tier1": max_results,
                        "tier2": max_results,
                        "tier3": max_results,
                    },
                }
                if bool(args.get("sessionScope", False)):
                    params["sessionId"] = self._session_id
                resp = self._bridge.request(
                    "memory.search",
                    params,
                )
                return json.dumps({"hits": resp.get("hits", [])})
            if tool_name == "memory_get":
                item_id = (args.get("id") or "").strip()
                if not item_id:
                    return json.dumps({"error": "missing id"})
                kind = args.get("kind") or "trace"
                methods = {
                    "trace": "memory.get_trace",
                    "policy": "memory.get_policy",
                    "world_model": "memory.get_world",
                }
                method = methods.get(kind)
                if method is None:
                    return json.dumps({"error": f"unknown memory kind: {kind}"})
                item = self._bridge.request(
                    method, {"id": item_id, "namespace": self._runtime_namespace()}
                )
                if not item:
                    return json.dumps({"found": False, "kind": kind, "id": item_id})
                if kind == "trace":
                    body = self._clip(item.get("agentText") or item.get("body"))
                    meta = {
                        "episodeId": item.get("episodeId"),
                        "ts": item.get("ts"),
                        "value": item.get("value"),
                        "reflection": self._clip(item.get("reflection")),
                        "userText": self._clip(item.get("userText")),
                        "toolCalls": item.get("toolCalls") or [],
                    }
                elif kind == "policy":
                    body = self._clip(
                        "\n\n".join(
                            part for part in [item.get("title"), item.get("procedure")] if part
                        )
                    )
                    meta = {
                        "trigger": item.get("trigger"),
                        "verification": item.get("verification"),
                        "boundary": item.get("boundary"),
                        "gain": item.get("gain"),
                        "support": item.get("support"),
                        "status": item.get("status"),
                    }
                else:
                    body = self._clip(item.get("body"))
                    meta = {
                        "title": item.get("title"),
                        "policyIds": item.get("policyIds") or [],
                    }
                return json.dumps(
                    {
                        "found": True,
                        "kind": kind,
                        "id": item.get("id", item_id),
                        "body": body,
                        "meta": meta,
                    }
                )
            if tool_name == "memory_timeline":
                resp = self._bridge.request(
                    "memory.timeline",
                    {
                        "episodeId": args.get("episodeId", self._episode_id),
                        "namespace": self._runtime_namespace(),
                    },
                )
                limit = self._int_arg(args, "limit", 20, 1, 100)
                traces = resp.get("traces", [])[:limit]
                return json.dumps({"traces": traces})
            if tool_name == "skill_list":
                limit = self._int_arg(args, "limit", 10, 1, 50)
                params = {"limit": limit, "namespace": self._runtime_namespace()}
                if args.get("status"):
                    params["status"] = args["status"]
                return json.dumps(self._bridge.request("skill.list", params))
            if tool_name == "memory_environment":
                query = (args.get("query") or "").strip()
                limit = self._int_arg(args, "limit", 5, 1, 30)
                if not query:
                    resp = self._bridge.request(
                        "memory.list_world_models",
                        {"limit": limit, "offset": 0, "namespace": self._runtime_namespace()},
                    )
                    return json.dumps(
                        {
                            "worldModels": [
                                {
                                    **w,
                                    "body": self._clip(w.get("body")),
                                }
                                for w in resp.get("worldModels", [])
                            ],
                            "queried": False,
                        }
                    )
                resp = self._bridge.request(
                    "memory.search",
                    {
                        "agent": "hermes",
                        "namespace": self._runtime_namespace(),
                        "query": query,
                        "topK": {"tier1": 0, "tier2": 0, "tier3": limit},
                    },
                )
                hits = [
                    h
                    for h in resp.get("hits", [])
                    if h.get("tier") == 3 or h.get("refKind") == "world_model"
                ]
                return json.dumps(
                    {
                        "worldModels": [
                            {
                                "id": h.get("refId") or h.get("id"),
                                "title": self._clip((h.get("snippet") or "").split("\n")[0]),
                                "body": self._clip(h.get("snippet")),
                                "policyIds": [],
                                "score": h.get("score"),
                            }
                            for h in hits[:limit]
                        ],
                        "queried": True,
                    }
                )
            if tool_name == "skill_get":
                skill_id = (args.get("id") or "").strip()
                if not skill_id:
                    return json.dumps({"error": "missing id"})
                skill = self._bridge.request(
                    "skill.get",
                    {
                        "id": skill_id,
                        "namespace": self._runtime_namespace(),
                        "recordTrial": True,
                        "sessionId": self._session_id,
                        "episodeId": self._episode_id or None,
                    },
                )
                return json.dumps({"found": bool(skill), "skill": skill})
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
        # `sync_turn` already flushed completed turn data synchronously.
        # Closing the host session is not the same as ending the topic:
        # the core will pause or finalize the open episode according to
        # topic-boundary rules so interrupted Hermes sessions can resume
        # into the same task later.
        with contextlib.suppress(Exception):
            self._bridge.request("session.close", {"sessionId": self._session_id})

    def shutdown(self) -> None:  # type: ignore[override]
        self._bridge_keepalive_stop.set()
        if self._bridge_keepalive_thread and self._bridge_keepalive_thread.is_alive():
            self._bridge_keepalive_thread.join(timeout=2.0)
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)
        if self._bridge:
            with contextlib.suppress(Exception):
                self._bridge.close()
            self._bridge = None
        # DON'T call shutdown_bridge() — the bridge process stays alive
        # as a daemon if its viewer is running, so the memory panel
        # remains accessible between `hermes chat` sessions.

    # ─── Host LLM bridge (fallback for plugin-side model failures) ────────

    def _handle_host_llm_complete(self, params: dict[str, Any]) -> dict[str, Any]:
        """Run a fallback LLM call using the host (hermes) agent's models.

        Wired into the bridge's reverse-RPC channel under the
        ``host.llm.complete`` method. Triggered when the plugin's
        configured summary or skill-evolver model fails — instead of
        bubbling the error straight up (which would stall the V7
        capture / reflection / skill pipeline), we replay the prompt
        through ``agent.auxiliary_client.call_llm`` so hermes' own
        provider stack (including its OpenRouter / Codex / custom
        endpoint resolution) handles it.

        If the host LLM also fails this raises, the bridge converts
        that into a JSON-RPC error, the LlmClient ``markFail``s, and
        the Overview card flips red — exactly matching the spec
        "if the agent's main model is also down, stop falling back
        and surface red".
        """
        messages = params.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("host.llm.complete: missing messages")

        # Lazy imports — these pull in heavy deps (openai client,
        # credential pool, …) that we don't want to load until a
        # fallback is actually requested.
        try:
            from agent.auxiliary_client import call_llm  # type: ignore[import-not-found]
            from hermes_cli.runtime_provider import (  # type: ignore[import-not-found]
                resolve_runtime_provider,
            )
        except Exception as err:
            raise RuntimeError(f"host LLM bridge unavailable: {err}") from err

        # Resolve hermes' MAIN conversation provider so the fallback
        # uses exactly what the user configured for chat. Walking the
        # generic auxiliary auto-detect chain would otherwise depend
        # on env vars (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, …) that
        # often don't propagate into the bridge subprocess and would
        # leave us with no working credential. Pinning to the resolved
        # main runtime guarantees we hit the same endpoint the user
        # already authenticated for chat.
        try:
            runtime = resolve_runtime_provider()
        except Exception as err:
            raise RuntimeError(f"could not resolve hermes main runtime: {err}") from err

        main_runtime: dict[str, str] = {}
        for field in ("provider", "model", "base_url", "api_key", "api_mode"):
            value = runtime.get(field) if isinstance(runtime, dict) else None
            if isinstance(value, str) and value.strip():
                main_runtime[field] = value.strip()

        normalized = [
            {
                "role": str(m.get("role", "user")),
                "content": str(m.get("content", "")),
            }
            for m in messages
            if isinstance(m, dict)
        ]
        timeout_ms = params.get("timeoutMs")
        timeout_s: float | None = None
        if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
            timeout_s = float(timeout_ms) / 1000.0

        max_tokens = params.get("maxTokens")
        temperature = params.get("temperature")

        kwargs: dict[str, Any] = {
            "messages": normalized,
            # `main_runtime` makes `_resolve_auto` prefer the user's
            # main conversation provider + model over the generic auto
            # chain. If the user's main provider is also down,
            # `call_llm` raises — which is exactly the "agent's own
            # model is broken too, stop falling back" semantic we want
            # (red light on Overview).
            "main_runtime": main_runtime,
        }
        if isinstance(max_tokens, (int, float)) and max_tokens > 0:
            kwargs["max_tokens"] = int(max_tokens)
        if isinstance(temperature, (int, float)):
            kwargs["temperature"] = float(temperature)
        if timeout_s is not None:
            kwargs["timeout"] = timeout_s

        started = time.time()
        try:
            response = call_llm(**kwargs)
        except Exception as err:
            # Surface the original failure verbatim — the LlmClient
            # will tag this as a "host fallback failed" terminal error
            # and the Overview red-light path takes over.
            raise RuntimeError(f"host LLM call failed: {err}") from err

        # `call_llm` returns an OpenAI ChatCompletion-shaped object.
        # Pluck the assistant text + token usage defensively so a
        # non-standard host (e.g. Anthropic native) still produces a
        # populated response.
        text = ""
        model = ""
        usage_dict: dict[str, int] = {}
        try:
            choices = getattr(response, "choices", None) or response.get("choices", [])  # type: ignore[union-attr]
            if choices:
                first = choices[0]
                msg = getattr(first, "message", None) or first.get("message", {})  # type: ignore[union-attr]
                content = getattr(msg, "content", None) or msg.get("content", "")  # type: ignore[union-attr]
                text = str(content or "")
            model = (
                getattr(response, "model", None)
                or response.get("model", "")  # type: ignore[union-attr]
                or ""
            )
            u = getattr(response, "usage", None) or response.get("usage", None)  # type: ignore[union-attr]
            if u is not None:
                pt = getattr(u, "prompt_tokens", None)
                ct = getattr(u, "completion_tokens", None)
                tt = getattr(u, "total_tokens", None)
                if pt is None and isinstance(u, dict):
                    pt = u.get("prompt_tokens")
                    ct = u.get("completion_tokens")
                    tt = u.get("total_tokens")
                if isinstance(pt, int):
                    usage_dict["promptTokens"] = pt
                if isinstance(ct, int):
                    usage_dict["completionTokens"] = ct
                if isinstance(tt, int):
                    usage_dict["totalTokens"] = tt
        except Exception:
            logger.debug("host.llm.complete: shape parse failed", exc_info=True)

        result: dict[str, Any] = {
            "text": text,
            "model": str(model or ""),
            "durationMs": int((time.time() - started) * 1000),
        }
        if usage_dict:
            result["usage"] = usage_dict
        return result

    # ─── Internals ────────────────────────────────────────────────────────

    def _host_runtime_context(self) -> dict[str, str]:
        """Best-effort snapshot of Hermes' main conversation runtime."""
        try:
            from hermes_cli.runtime_provider import (  # type: ignore[import-not-found]
                resolve_runtime_provider,
            )

            runtime = resolve_runtime_provider()
        except Exception:
            return dict(self._last_host_runtime)

        out: dict[str, str] = {}
        if isinstance(runtime, dict):
            for source, target in (
                ("provider", "hostProvider"),
                ("model", "hostModel"),
                ("api_mode", "hostApiMode"),
                ("base_url", "hostBaseUrl"),
            ):
                value = runtime.get(source)
                if isinstance(value, str) and value.strip():
                    out[target] = value.strip()
        if out:
            self._last_host_runtime = dict(out)
        return out

    def _open_session(self, session_id: str = "", *, timeout: float = 30.0) -> None:
        assert self._bridge is not None
        requested_session = session_id or self._session_id or ""
        host_runtime = self._host_runtime_context()
        resp = self._bridge.request(
            "session.open",
            {
                "agent": "hermes",
                "sessionId": requested_session,
                "namespace": self._runtime_namespace(),
                "meta": {
                    "hermesHome": self._hermes_home,
                    "platform": self._platform,
                    "agentIdentity": self._agent_identity,
                    "profileId": self._runtime_namespace()["profileId"],
                    "namespace": self._runtime_namespace(),
                    **host_runtime,
                },
            },
            timeout=timeout,
        )
        self._session_id = resp.get("sessionId") or requested_session

    def _is_transport_closed(self, err: Exception) -> bool:
        if isinstance(err, BridgeError) and err.code == "transport_closed":
            return True
        msg = str(err).lower()
        return "broken pipe" in msg or "bridge closed" in msg or "transport_closed" in msg

    def _reconnect_bridge(self, session_id: str = "", *, timeout: float = 30.0) -> None:
        old_bridge = self._bridge
        if old_bridge:
            with contextlib.suppress(Exception):
                old_bridge.close()
        ensure_bridge_running()
        self._bridge = MemosBridgeClient()
        self._bridge.register_host_handler(
            "host.llm.complete",
            self._handle_host_llm_complete,
        )
        self._open_session(session_id, timeout=timeout)

    def _ensure_bridge(self, session_id: str = "", *, timeout: float = 30.0) -> bool:
        if self._bridge:
            return True
        try:
            self._reconnect_bridge(session_id or self._session_id, timeout=timeout)
            logger.info(
                "MemOS: bridge reconnected session=%s platform=%s",
                self._session_id,
                self._platform,
            )
            return True
        except Exception as err:
            logger.warning("MemOS: bridge reconnect failed — %s", err)
            self._bridge = None
            return False

    def _start_bridge_keepalive(self) -> None:
        if self._bridge_keepalive_thread and self._bridge_keepalive_thread.is_alive():
            return
        self._bridge_keepalive_stop.clear()

        def _run() -> None:
            while not self._bridge_keepalive_stop.wait(5.0):
                if not self._ensure_bridge(self._session_id, timeout=10.0):
                    continue
                try:
                    assert self._bridge is not None
                    self._bridge.request("core.health", {}, timeout=10.0)
                except Exception as err:
                    if self._is_transport_closed(err):
                        logger.info("MemOS: bridge keepalive reconnecting after transport close")
                        with contextlib.suppress(Exception):
                            self._reconnect_bridge(self._session_id, timeout=10.0)
                    else:
                        logger.debug("MemOS: bridge keepalive failed — %s", err)

        self._bridge_keepalive_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="memos-bridge-keepalive",
        )
        self._bridge_keepalive_thread.start()

    def _turn_start(self, query: str, *, session_id: str = "") -> str:
        assert self._bridge is not None
        host_runtime = self._host_runtime_context()
        resp = self._bridge.request(
            "turn.start",
            {
                "agent": "hermes",
                "namespace": self._runtime_namespace(),
                "sessionId": session_id or self._session_id,
                "userText": query,
                "contextHints": {
                    "agentIdentity": self._agent_identity,
                    "namespace": self._runtime_namespace(),
                    **host_runtime,
                },
                "ts": int(time.time() * 1000),
            },
        )
        # Stash the real episode id the pipeline auto-created (V7
        # §0.1 may have boundary-cut the previous episode and started
        # a new one). `on_session_end` uses it to close the right
        # episode — see the "Episode tracking" comment block above.
        new_eid = ((resp or {}).get("query") or {}).get("episodeId") or ""
        if new_eid and new_eid != self._episode_id:
            self._episode_id = new_eid
            logger.debug("MemOS: stashed episode %s from turn.start", new_eid)
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
        *,
        agent_thinking: str = "",
    ) -> None:
        if not self._bridge:
            return
        # Strip private book-keeping fields before sending.
        clean_tool_calls = [
            {k: v for k, v in tc.items() if k not in {"_id", "_ids"}} for tc in tool_calls
        ]
        payload: dict[str, Any] = {
            "agent": "hermes",
            "namespace": self._runtime_namespace(),
            "sessionId": self._session_id,
            "episodeId": self._episode_id,
            "agentText": assistant_content,
            "userText": user_content,
            "toolCalls": clean_tool_calls,
            "contextHints": {
                "agentIdentity": self._agent_identity,
                "namespace": self._runtime_namespace(),
                **self._host_runtime_context(),
            },
            "ts": ts_ms,
        }
        if agent_thinking:
            payload["agentThinking"] = agent_thinking
        result = self._bridge.request("turn.end", payload)
        # Capture the trace ID for feedback submission
        if result and isinstance(result, dict):
            trace_ids = result.get("traceIds", [])
            if trace_ids and len(trace_ids) > 0:
                self._last_trace_id = trace_ids[-1]  # Last trace is the current turn

    def _submit_verifier_feedback(
        self,
        user_content: str,
        assistant_content: str,
        ts_ms: int,
    ) -> None:
        if not self._bridge or not self._episode_id:
            return
        polarity = _feedback_polarity(user_content)
        magnitude = _feedback_magnitude(user_content, polarity)
        raw = {
            "source": "hermes.verifier_feedback",
            "userText": user_content,
            "assistantText": assistant_content,
            "polarity": polarity,
        }
        payload: dict[str, Any] = {
            "episodeId": self._episode_id,
            "channel": "explicit",
            "polarity": polarity,
            "magnitude": magnitude,
            "rationale": user_content,
            "raw": raw,
            "ts": ts_ms,
        }
        # Include the last trace ID if available
        if self._last_trace_id:
            payload["traceId"] = self._last_trace_id
        self._bridge.request("feedback.submit", payload)


# ─── Discovery entry points ───────────────────────────────────────────────


# Pattern 1: `register(ctx)` — preferred by `plugins/memory/__init__.py`.
def register(ctx: Any) -> None:
    """hermes-agent plugin entry point."""
    ctx.register_memory_provider(MemTensorProvider())


# Pattern 2: exported class — fallback via `issubclass(MemoryProvider)`.
__all__ = ["PLUGIN_ID", "PLUGIN_VERSION", "MemTensorProvider", "register"]
