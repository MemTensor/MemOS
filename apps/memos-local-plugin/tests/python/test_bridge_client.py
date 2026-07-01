"""Unit tests for the Python JSON-RPC bridge client.

These tests do NOT boot the real Node bridge — they stub out the
subprocess layer and inject synthetic JSON-RPC responses via pipes,
exercising the client state machine end-to-end.

Run:
    python3 -m unittest tests.python.test_bridge_client
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest

from pathlib import Path
from unittest.mock import patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import bridge_client as bridge_client_mod  # noqa: E402
import daemon_manager as daemon_manager_mod  # noqa: E402

from bridge_client import BridgeError, MemosBridgeClient  # noqa: E402


class FakePopen:
    """In-memory stand-in for `subprocess.Popen`.

    Wires up stdin/stdout/stderr as pipes so we can script server-side
    responses from the test without touching a real process.
    """

    def __init__(self, *_args, **_kwargs) -> None:
        self.cmd = list(_args[0]) if _args else []
        self.pid = 12345
        self.stdin = io.StringIO()
        self._stdin_lines: list[str] = []
        self.stdout = _ServerStream()
        self.stderr = io.StringIO()

        # Patch the write path so writes accumulate in `_stdin_lines`
        # and the server can peek at incoming requests.
        orig_write = self.stdin.write

        def _write(s: str) -> int:
            self._stdin_lines.append(s)
            self.stdout.on_request(s)
            return orig_write(s)

        self.stdin.write = _write  # type: ignore[assignment]

    # The client just needs wait/kill to exist; they are no-ops here.
    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        pass

    # ``request()`` short-circuits on a dead subprocess by consulting
    # ``poll()``. The default fake process is "alive" (returns None); a
    # specific test can monkeypatch this to simulate an exit.
    def poll(self) -> int | None:
        return None


class _ServerStream(io.StringIO):
    """Script bridge responses as if coming from the Node subprocess."""

    def __init__(self) -> None:
        super().__init__()
        self._queue: list[str] = []
        self._event = threading.Event()
        self._pos = 0

    def on_request(self, raw: str) -> None:
        raw = raw.strip()
        if not raw:
            return
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            return
        method = req.get("method")
        rpc_id = req.get("id")
        if rpc_id is None:
            return  # notification
        if method == "core.health":
            self._enqueue(
                {"jsonrpc": "2.0", "id": rpc_id, "result": {"ok": True, "version": "test"}}
            )
        elif method == "memory.search":
            q = (req.get("params") or {}).get("query", "")
            self._enqueue(
                {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {"hits": [{"id": "t1", "excerpt": f"hit for {q}"}]},
                }
            )
        elif method == "session.open":
            self._enqueue(
                {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {"sessionId": "hermes:session:1"},
                }
            )
        elif method == "turn.start":
            q = (req.get("params") or {}).get("userText", "")
            self._enqueue(
                {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {
                        "query": {
                            "sessionId": "hermes:session:1",
                            "episodeId": "ep-1",
                        },
                        "injectedContext": f"- remembered context for {q}",
                    },
                }
            )
        elif method == "boom":
            self._enqueue(
                {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": {
                        "code": -32000,
                        "message": "boom",
                        "data": {"code": "internal", "message": "boom"},
                    },
                }
            )

    def _enqueue(self, msg: dict) -> None:
        self.write(json.dumps(msg) + "\n")
        self._event.set()

    def __iter__(self):  # what the reader thread iterates over
        while True:
            val = self.getvalue()
            if self._pos < len(val):
                remainder = val[self._pos :]
                if "\n" in remainder:
                    line, _, _ = remainder.partition("\n")
                    self._pos += len(line) + 1
                    yield line + "\n"
                    continue
            self._event.wait(timeout=0.05)
            self._event.clear()
            if self._pos >= len(self.getvalue()) and hasattr(self, "_done") and self._done:
                return


class RecordingBridge:
    """Small fake for MemTensorProvider.handle_tool_call tests."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def request(self, method: str, params: dict | None = None) -> dict | None:
        payload = params or {}
        self.calls.append((method, payload))
        if method == "memory.search":
            return {
                "hits": [
                    {
                        "tier": 2,
                        "refKind": "trace",
                        "refId": "tr-1",
                        "score": 0.9,
                        "snippet": f"hit for {payload.get('query')}",
                    }
                ]
            }
        if method == "memory.get_trace":
            return {
                "id": payload["id"],
                "episodeId": "ep-1",
                "ts": 123,
                "value": 0.5,
                "userText": "remember HERMES_MEMOS_E2E_0428",
                "agentText": "recorded",
                "reflection": "useful",
                "toolCalls": [{"name": "terminal"}],
            }
        if method == "memory.get_policy":
            return {
                "id": payload["id"],
                "title": "Hermes validation",
                "procedure": "Check source and ~/.hermes/memos-plugin.",
                "trigger": "memos test",
                "verification": "six tools exposed",
                "boundary": "",
                "gain": 0.2,
                "support": 1,
                "status": "candidate",
            }
        if method == "memory.get_world":
            return {
                "id": payload["id"],
                "title": "Hermes MemOS environment",
                "body": "Hermes viewer runs on 18800.",
                "policyIds": ["p-1"],
            }
        if method == "memory.timeline":
            return {"traces": [{"id": "tr-1"}, {"id": "tr-2"}]}
        if method == "skill.list":
            return {
                "skills": [
                    {
                        "id": "sk-1",
                        "name": "verify-hermes-memos",
                        "status": payload.get("status", "active"),
                    }
                ]
            }
        if method == "skill.get":
            return {
                "id": payload["id"],
                "name": "verify-hermes-memos",
                "invocationGuide": "Run the Hermes MemOS checklist.",
            }
        if method == "memory.list_world_models":
            return {
                "worldModels": [
                    {
                        "id": "wm-1",
                        "title": "Hermes install",
                        "body": "Install path is ~/.hermes/memos-plugin.",
                        "policyIds": [],
                    }
                ]
            }
        return {}


class BridgeClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self._fake: FakePopen | None = None

        def _factory(*args, **kwargs):
            self._fake = FakePopen(*args, **kwargs)
            return self._fake

        self._popen_patch = patch.object(bridge_client_mod.subprocess, "Popen", _factory)
        self._which_patch = patch.object(
            bridge_client_mod.shutil, "which", return_value="/usr/bin/node"
        )
        self._popen_patch.start()
        self._which_patch.start()

    def tearDown(self) -> None:
        if self._fake is not None:
            self._fake.stdout._done = True
        self._popen_patch.stop()
        self._which_patch.stop()

    def test_request_returns_result_on_success(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        res = client.request("core.health")
        self.assertEqual(res, {"ok": True, "version": "test"})
        client.close()

    def test_request_surfaces_error_on_rpc_error(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        with self.assertRaises(BridgeError) as ctx:
            client.request("boom")
        self.assertEqual(ctx.exception.code, "internal")
        self.assertIn("boom", ctx.exception.message)
        client.close()

    def test_memos_search_roundtrip(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        res = client.request("memory.search", {"query": "yesterday"})
        self.assertEqual(len(res["hits"]), 1)
        self.assertIn("yesterday", res["hits"][0]["excerpt"])
        client.close()

    def test_session_open_returns_session_id(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        res = client.request("session.open", {"agent": "hermes"})
        self.assertEqual(res["sessionId"], "hermes:session:1")
        client.close()

    def test_close_is_idempotent(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        client.close()
        client.close()  # second call must not raise

    def test_stdio_bridge_starts_without_viewer_by_default(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        assert self._fake is not None
        cmd = getattr(self._fake, "cmd", [])
        self.assertIn("--no-viewer", cmd)
        client.close()

    def test_reverse_request_waits_for_late_host_handler_registration(self) -> None:
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        assert self._fake is not None

        self._fake.stdout._enqueue(
            {
                "jsonrpc": "2.0",
                "id": "srv-1",
                "method": "host.llm.complete",
                "params": {"messages": [{"role": "user", "content": "ping"}]},
            }
        )
        time.sleep(0.1)

        client.register_host_handler(
            "host.llm.complete",
            lambda params: {
                "text": f"host:{params['messages'][-1]['content']}",
                "model": "host-test",
            },
        )

        response = self._wait_for_client_write(lambda msg: msg.get("id") == "srv-1")
        self.assertEqual(response["result"]["text"], "host:ping")
        self.assertNotIn("error", response)
        client.close()

    def _wait_for_client_write(self, predicate, timeout: float = 2.0) -> dict:
        assert self._fake is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for raw in self._fake._stdin_lines:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if predicate(msg):
                    return msg
            time.sleep(0.01)
        self.fail("timed out waiting for client write")

    def test_reader_exit_marks_pending_as_transport_closed(self) -> None:
        """When the reader loop exits (subprocess died), pending waiters
        must be released immediately with ``transport_closed`` instead of
        parking on the caller's ``timeout``."""
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        assert self._fake is not None

        # Enqueue a request the server will NEVER answer, then simulate
        # subprocess exit by draining the stdout stream and marking it
        # done. The reader thread must observe EOF and abort every
        # pending request.
        results: dict[str, Exception | None] = {"err": None}

        def _call() -> None:
            try:
                client.request("core.health", timeout=30.0)
            except BridgeError as err:
                results["err"] = err

        # Craft a request whose response the fake server won't produce.
        # We do that by temporarily swapping the fake's on_request so no
        # answer is enqueued.
        self._fake.stdout.on_request = lambda _raw: None  # type: ignore[assignment]

        thread = threading.Thread(target=_call, daemon=True)
        thread.start()

        # Give the writer + reader a moment to register the pending id.
        time.sleep(0.05)

        # Simulate subprocess exit: no more bytes ever, iterator returns.
        self._fake.stdout._done = True
        # Nudge the reader thread out of its 50 ms wait.
        self._fake.stdout._event.set()

        thread.join(timeout=2.0)
        self.assertFalse(thread.is_alive(), "waiter never released after EOF")

        err = results["err"]
        self.assertIsInstance(err, BridgeError)
        assert isinstance(err, BridgeError)
        self.assertEqual(err.code, "transport_closed")
        client.close()

    def test_request_fast_fails_when_subprocess_already_dead(self) -> None:
        """A dead subprocess (``poll()`` non-None) must raise
        ``transport_closed`` before we write to a broken pipe."""
        client = MemosBridgeClient(bridge_path="/tmp/bridge.cts")
        assert self._fake is not None

        # Simulate subprocess exit (exit code 137 = OOM kill).
        self._fake.poll = lambda: 137  # type: ignore[assignment]

        with self.assertRaises(BridgeError) as ctx:
            client.request("core.health", timeout=1.0)
        self.assertEqual(ctx.exception.code, "transport_closed")
        self.assertIn("137", str(ctx.exception))
        # We must not have written anything to the dead stdin pipe.
        stdin_writes = [line for line in self._fake._stdin_lines if line]
        self.assertEqual(stdin_writes, [])
        client.close()


class MemTensorProviderTests(unittest.TestCase):
    """Exercise `MemTensorProvider` against a mocked bridge."""

    def setUp(self) -> None:
        # Stub ensure_bridge_running so provider instantiation doesn't
        # spawn a real subprocess.
        import memos_provider

        self._provider_mod = memos_provider

        self._patches = [
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()

    def test_is_available_returns_true_when_bridge_ok(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        self.assertTrue(p.is_available())

    def test_system_prompt_block_mentions_memory(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        self.assertIn("Memory", p.system_prompt_block())

    def test_get_tool_schemas_lists_memory_tools(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        schemas = p.get_tool_schemas()
        names = {s["name"] for s in schemas}
        self.assertSetEqual(
            names,
            {
                "memos_search",
                "memos_get",
                "memos_timeline",
                "memos_skill_list",
                "memos_environment",
                "memos_skill_get",
            },
        )

    def test_handle_tool_call_fails_gracefully_without_bridge(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        # bridge is None — should not crash, returns error JSON
        res = p.handle_tool_call("memos_search", {"query": "x"})
        parsed = json.loads(res)
        self.assertIn("error", parsed)

    def test_handle_tool_call_routes_all_exposed_tools(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        bridge = RecordingBridge()
        p._bridge = bridge
        p._session_id = "hermes:session:1"
        p._episode_id = "ep-1"

        search = json.loads(
            p.handle_tool_call(
                "memos_search",
                {"query": "HERMES_MEMOS_E2E_0428", "maxResults": 7, "sessionScope": True},
            )
        )
        self.assertEqual(search["hits"][0]["refId"], "tr-1")
        self.assertEqual(bridge.calls[-1][0], "memory.search")
        self.assertEqual(bridge.calls[-1][1]["sessionId"], "hermes:session:1")
        self.assertEqual(bridge.calls[-1][1]["topK"]["tier1"], 7)

        got_trace = json.loads(p.handle_tool_call("memos_get", {"id": "tr-1"}))
        self.assertTrue(got_trace["found"])
        self.assertEqual(got_trace["kind"], "trace")
        self.assertIn("HERMES_MEMOS_E2E_0428", got_trace["meta"]["userText"])
        self.assertEqual(bridge.calls[-1][0], "memory.get_trace")

        got_policy = json.loads(p.handle_tool_call("memos_get", {"id": "p-1", "kind": "policy"}))
        self.assertEqual(got_policy["kind"], "policy")
        self.assertIn("Hermes validation", got_policy["body"])
        self.assertEqual(bridge.calls[-1][0], "memory.get_policy")

        got_world = json.loads(
            p.handle_tool_call("memos_get", {"id": "wm-1", "kind": "world_model"})
        )
        self.assertEqual(got_world["kind"], "world_model")
        self.assertEqual(got_world["meta"]["policyIds"], ["p-1"])
        self.assertEqual(bridge.calls[-1][0], "memory.get_world")

        timeline = json.loads(p.handle_tool_call("memos_timeline", {"episodeId": "ep-1"}))
        self.assertEqual(len(timeline["traces"]), 2)
        self.assertEqual(bridge.calls[-1][0], "memory.timeline")

        skills = json.loads(
            p.handle_tool_call("memos_skill_list", {"status": "active", "limit": 3})
        )
        self.assertEqual(skills["skills"][0]["id"], "sk-1")
        self.assertEqual(bridge.calls[-1][0], "skill.list")
        self.assertEqual(bridge.calls[-1][1]["limit"], 3)
        self.assertEqual(bridge.calls[-1][1]["status"], "active")
        self.assertEqual(bridge.calls[-1][1]["namespace"]["agentKind"], "hermes")

        env = json.loads(p.handle_tool_call("memos_environment", {"limit": 2}))
        self.assertFalse(env["queried"])
        self.assertEqual(env["worldModels"][0]["id"], "wm-1")
        self.assertEqual(bridge.calls[-1][0], "memory.list_world_models")

        env_query = json.loads(
            p.handle_tool_call("memos_environment", {"query": "Hermes install", "limit": 2})
        )
        self.assertTrue(env_query["queried"])
        self.assertEqual(bridge.calls[-1][0], "memory.search")
        self.assertEqual(bridge.calls[-1][1]["topK"], {"tier1": 0, "tier2": 0, "tier3": 2})

        skill = json.loads(p.handle_tool_call("memos_skill_get", {"id": "sk-1"}))
        self.assertTrue(skill["found"])
        self.assertEqual(skill["skill"]["id"], "sk-1")
        self.assertEqual(bridge.calls[-1][0], "skill.get")
        self.assertEqual(bridge.calls[-1][1]["id"], "sk-1")
        self.assertTrue(bridge.calls[-1][1]["recordTrial"])

    def test_handle_tool_call_validates_required_arguments(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        p._bridge = RecordingBridge()

        self.assertIn("missing query", p.handle_tool_call("memos_search", {}))
        self.assertIn("missing id", p.handle_tool_call("memos_get", {}))
        self.assertIn(
            "unknown memory kind",
            p.handle_tool_call("memos_get", {"id": "x", "kind": "bad"}),
        )
        self.assertIn("missing id", p.handle_tool_call("memos_skill_get", {}))
        self.assertIn("unknown tool", p.handle_tool_call("not_a_tool", {}))

    def test_prefetch_lazily_reconnects_when_bridge_is_missing(self) -> None:
        class PrefetchBridge:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []

            def register_host_handler(self, *_args, **_kwargs) -> None:
                pass

            def request(self, method: str, params: dict | None = None, **_kwargs) -> dict:
                payload = params or {}
                self.calls.append((method, payload))
                if method == "session.open":
                    return {"sessionId": "hermes:session:1"}
                if method == "turn.start":
                    return {
                        "query": {"episodeId": "ep-1"},
                        "injectedContext": "- remembered context for anything",
                    }
                return {}

        p = self._provider_mod.MemTensorProvider()
        bridge = PrefetchBridge()
        with patch("memos_provider.MemosBridgeClient", return_value=bridge):
            self.assertIn("Recalled Memories", p.prefetch("anything"))
        self.assertIsNotNone(p._bridge)
        self.assertEqual([c[0] for c in bridge.calls], ["session.open", "turn.start"])

    def test_on_turn_start_stashes_message(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        p.on_turn_start(3, "what was yesterday's output?")
        # Private attrs are fine to assert in tests — they drive the
        # `sync_turn` / `on_pre_compress` code paths.
        self.assertEqual(p._turn_number, 3)
        self.assertIn("yesterday", p._last_user_text)

    def test_on_delegation_is_noop_without_bridge(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        p.on_delegation("run tests", "all green")  # must not raise

    def test_on_pre_compress_without_bridge_returns_empty(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        p.on_turn_start(1, "earlier user text")
        self.assertEqual(p.on_pre_compress([{"role": "user", "content": "x"}]), "")

    def test_sync_turn_transport_closed_logs_error_if_retry_fails(self) -> None:
        """Retry failures are surfaced explicitly instead of silent loss."""

        class BrokenBridge:
            def close(self):
                pass

            def request(self, method, params=None, **_kwargs):
                if method == "turn.end":
                    raise BridgeError("transport_closed", "[Errno 32] Broken pipe")
                return {}

        class RetryFailBridge:
            def request(self, method, params=None):
                if method == "session.open":
                    return {"sessionId": (params or {}).get("sessionId", "sess")}
                if method == "turn.start":
                    return {"query": {"episodeId": "ep_after_reconnect"}}
                if method == "turn.end":
                    raise BridgeError("internal", "still down")
                return {}

        p = self._provider_mod.MemTensorProvider()
        p._bridge = BrokenBridge()
        p._session_id = "sess_tui_long_running"
        p._episode_id = "ep_tui_long_running"

        with (
            patch("memos_provider.MemosBridgeClient", return_value=RetryFailBridge()),
            self.assertLogs("memos_provider", level="ERROR") as logs,
        ):
            p.sync_turn(
                "帮我检索一下最近关于中东的事件，以及分析下局势",
                "最近有关中东的事件和局势如下...",
            )

        joined = "\n".join(logs.output)
        self.assertIn("failed after bridge reconnect", joined)
        self.assertIn("memory turn was not persisted", joined)

    def test_sync_turn_reconnects_and_retries_after_transport_closed(self) -> None:
        """Reconnect and retry once after a stale bridge pipe."""

        class BrokenBridge:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

            def request(self, method, params=None):
                if method == "turn.end":
                    raise BridgeError("transport_closed", "[Errno 32] Broken pipe")
                return {}

        class HealthyBridge:
            def __init__(self):
                self.calls = []

            def register_host_handler(self, _method, _handler):
                return None

            def request(self, method, params=None, **_kwargs):
                self.calls.append((method, params or {}))
                if method == "session.open":
                    return {"sessionId": (params or {}).get("sessionId", "sess")}
                if method == "turn.start":
                    return {"query": {"episodeId": "ep_after_reconnect"}}
                if method == "turn.end":
                    return {"traceId": "tr_after_reconnect"}
                return {}

        broken = BrokenBridge()
        replacement = HealthyBridge()
        p = self._provider_mod.MemTensorProvider()
        p._bridge = broken
        p._session_id = "sess_tui_long_running"
        p._episode_id = "ep_tui_long_running"
        p._hermes_home = "/tmp/hermes-home"
        p._platform = "tui"
        p._agent_identity = "hermes-test"
        p._tool_calls = [{"name": "search_files", "input": "{}", "output": "ok"}]

        with patch("memos_provider.MemosBridgeClient", return_value=replacement):
            p.sync_turn(
                "帮我检索一下最近关于中东的事件，以及分析下局势",
                "最近有关中东的事件和局势如下...",
            )

        methods = [method for method, _params in replacement.calls]
        self.assertEqual(methods, ["session.open", "turn.start", "turn.end"])
        self.assertTrue(broken.closed)
        self.assertEqual(p._episode_id, "ep_after_reconnect")

        session_params = replacement.calls[0][1]
        self.assertEqual(session_params["sessionId"], "sess_tui_long_running")
        self.assertEqual(session_params["meta"]["platform"], "tui")
        self.assertEqual(session_params["meta"]["agentIdentity"], "hermes-test")

        retry_payload = replacement.calls[-1][1]
        self.assertEqual(retry_payload["sessionId"], "sess_tui_long_running")
        self.assertEqual(retry_payload["episodeId"], "ep_after_reconnect")
        self.assertIn("中东", retry_payload["userText"])
        self.assertIn("局势", retry_payload["agentText"])
        self.assertEqual(retry_payload["toolCalls"][0]["name"], "search_files")

    # ─── Regression tests for #1722 ──────────────────────────────────
    #
    # A hung / dead bridge subprocess used to make every memory tool
    # block for the full 30 s per-request timeout without ever
    # recovering. The three layers below cover:
    #
    #   1. keepalive detects a hung bridge (timeout / dead subprocess)
    #      and triggers a reconnect;
    #   2. keepalive stays quiet for a live subprocess with a transient
    #      parse error (no reconnect storms);
    #   3. read-path tools reconnect and retry once on a stale bridge,
    #      mirroring the write-path behaviour already covered above.

    def test_keepalive_reconnects_on_health_timeout(self) -> None:
        """``BridgeError('timeout', …)`` must count as reconnect-worthy."""

        class TimingOutBridge:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def close(self) -> None:
                pass

            def request(self, method: str, params: dict | None = None, **_kw) -> dict:
                self.calls.append(method)
                if method == "core.health":
                    raise BridgeError("timeout", "core.health did not respond within 10.0s")
                return {}

        p = self._provider_mod.MemTensorProvider()
        # The helper is the sole decision point the keepalive consults;
        # exercising it directly keeps this test hermetic.
        err = BridgeError("timeout", "core.health did not respond within 10.0s")
        p._bridge = TimingOutBridge()
        self.assertTrue(p._should_reconnect_after_keepalive_failure(err))

    def test_keepalive_reconnects_when_subprocess_is_dead(self) -> None:
        """Any error whose subprocess reports ``poll() != None`` triggers reconnect."""

        class DeadBridge:
            def __init__(self) -> None:
                class _Proc:
                    def poll(self_inner) -> int:  # noqa: N805
                        return 1

                self._proc = _Proc()

            def close(self) -> None:
                pass

            def request(self, method: str, params: dict | None = None, **_kw) -> dict:
                raise BridgeError("internal", "shape parse failed")

        p = self._provider_mod.MemTensorProvider()
        p._bridge = DeadBridge()
        err = BridgeError("internal", "shape parse failed")
        self.assertTrue(p._should_reconnect_after_keepalive_failure(err))

    def test_keepalive_does_not_reconnect_on_transient_generic_error(self) -> None:
        """A live subprocess + generic error must NOT trigger reconnect
        (avoids reconnect storms on transient parse noise)."""

        class LiveNoisyBridge:
            def __init__(self) -> None:
                class _Proc:
                    def poll(self_inner) -> None:  # noqa: N805
                        return None

                self._proc = _Proc()

            def close(self) -> None:
                pass

        p = self._provider_mod.MemTensorProvider()
        p._bridge = LiveNoisyBridge()
        err = BridgeError("internal", "malformed response")
        self.assertFalse(p._should_reconnect_after_keepalive_failure(err))

    def test_handle_tool_call_retries_memos_search_after_transport_closed(self) -> None:
        """Read-path memory tools must reconnect + retry once on stale bridge."""

        class StaleBridge:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def close(self) -> None:
                pass

            def request(self, method: str, params: dict | None = None, **_kw) -> dict:
                self.calls.append(method)
                raise BridgeError("transport_closed", "[Errno 32] Broken pipe")

        class HealthyBridge:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []

            def register_host_handler(self, *_a, **_k) -> None:
                return None

            def request(self, method: str, params: dict | None = None, **_kw) -> dict:
                payload = params or {}
                self.calls.append((method, payload))
                if method == "session.open":
                    return {"sessionId": payload.get("sessionId", "sess")}
                if method == "memory.search":
                    return {"hits": [{"refId": "tr-after", "score": 0.9}]}
                return {}

        stale = StaleBridge()
        healthy = HealthyBridge()
        p = self._provider_mod.MemTensorProvider()
        p._bridge = stale
        p._session_id = "sess_search"
        p._episode_id = "ep_search"

        with patch("memos_provider.MemosBridgeClient", return_value=healthy):
            raw = p.handle_tool_call("memos_search", {"query": "yesterday"})

        parsed = json.loads(raw)
        self.assertNotIn("error", parsed)
        self.assertEqual(parsed["hits"][0]["refId"], "tr-after")
        # First call went to the stale bridge; the retry hit the healthy one.
        self.assertEqual(stale.calls, ["memory.search"])
        self.assertIn("memory.search", [m for m, _ in healthy.calls])

    def test_handle_tool_call_surfaces_second_transport_failure(self) -> None:
        """If the retry ALSO fails, the tool must surface an error verbatim."""

        class AlwaysStaleBridge:
            def __init__(self) -> None:
                self.calls = 0

            def close(self) -> None:
                pass

            def request(self, method: str, params: dict | None = None, **_kw) -> dict:
                self.calls += 1
                raise BridgeError("transport_closed", "[Errno 32] Broken pipe")

        class ReplacementBridge:
            def register_host_handler(self, *_a, **_k) -> None:
                return None

            def request(self, method: str, params: dict | None = None, **_kw) -> dict:
                if method == "session.open":
                    return {"sessionId": (params or {}).get("sessionId", "sess")}
                # Retry still hits transport_closed.
                raise BridgeError("transport_closed", "[Errno 32] Broken pipe again")

        p = self._provider_mod.MemTensorProvider()
        p._bridge = AlwaysStaleBridge()
        p._session_id = "sess_search"
        p._episode_id = "ep_search"

        with patch("memos_provider.MemosBridgeClient", return_value=ReplacementBridge()):
            raw = p.handle_tool_call("memos_search", {"query": "yesterday"})

        parsed = json.loads(raw)
        self.assertIn("error", parsed)
        self.assertIn("Broken pipe", parsed["error"])

    def test_get_config_schema_describes_known_fields(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        schema = p.get_config_schema()
        keys = {item["key"] for item in schema}
        self.assertIn("llm_provider", keys)
        self.assertIn("embedding_provider", keys)

    def test_save_config_writes_yaml_with_correct_mode(self) -> None:
        import tempfile

        import yaml

        p = self._provider_mod.MemTensorProvider()
        with tempfile.TemporaryDirectory() as tmp:
            p.save_config(
                {
                    "viewer_port": 18920,
                    "llm_provider": "openai_compatible",
                    "embedding_provider": "local",
                },
                tmp,
            )
            cfg_path = Path(tmp) / "memos-plugin" / "config.yaml"
            self.assertTrue(cfg_path.exists())
            mode = cfg_path.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)
            loaded = yaml.safe_load(cfg_path.read_text())
            self.assertEqual(loaded["viewer"]["port"], 18920)
            self.assertEqual(loaded["llm"]["provider"], "openai_compatible")


class ViewerDaemonTests(unittest.TestCase):
    def tearDown(self) -> None:
        daemon_manager_mod._viewer_status = None
        daemon_manager_mod._viewer_last_probe_at = 0.0
        daemon_manager_mod._viewer_process = None

    def test_existing_memos_viewer_is_reused(self) -> None:
        with (
            patch.object(daemon_manager_mod, "_probe_viewer", return_value="running_memos"),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()

    def test_non_memos_port_occupant_blocks_daemon_start(self) -> None:
        with (
            patch.object(daemon_manager_mod, "_probe_viewer", return_value="blocked"),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertFalse(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()

    def test_free_port_starts_daemon_once(self) -> None:
        class FakeDaemon:
            returncode = None

            def poll(self):
                return None

        with tempfile.TemporaryDirectory() as tmp:
            bridge_path = Path(tmp) / "bridge.cts"
            bridge_path.write_text("", encoding="utf-8")
            with (
                patch.object(
                    daemon_manager_mod,
                    "_probe_viewer",
                    side_effect=["free", "free", "running_memos"],
                ),
                patch.object(daemon_manager_mod, "_bridge_script", return_value=bridge_path),
                patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
                patch.object(
                    daemon_manager_mod,
                    "_bridge_command",
                    return_value=["node", "bridge.cts", "--agent=hermes", "--daemon"],
                ),
                patch.object(
                    daemon_manager_mod.subprocess,
                    "Popen",
                    return_value=FakeDaemon(),
                ) as popen,
            ):
                self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
                popen.assert_called_once()

    def test_start_lock_reprobes_before_spawning_daemon(self) -> None:
        @contextlib.contextmanager
        def acquired_lock():
            yield True

        with (
            patch.object(
                daemon_manager_mod,
                "_probe_viewer",
                side_effect=["free", "running_memos"],
            ),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()

    def test_start_lock_timeout_does_not_spawn_daemon(self) -> None:
        @contextlib.contextmanager
        def busy_lock():
            yield False

        with (
            patch.object(daemon_manager_mod, "_probe_viewer", side_effect=["free", "free"]),
            patch.object(daemon_manager_mod, "_viewer_start_lock", busy_lock),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertFalse(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
