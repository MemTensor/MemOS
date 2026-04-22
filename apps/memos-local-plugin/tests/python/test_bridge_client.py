"""Unit tests for the Python JSON-RPC bridge client.

These tests do NOT boot the real Node bridge — they stub out the
subprocess layer and inject synthetic JSON-RPC responses via pipes,
exercising the client state machine end-to-end.

Run:
    python3 -m unittest tests.python.test_bridge_client
"""

from __future__ import annotations

import io
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import bridge_client as bridge_client_mod  # noqa: E402
from bridge_client import BridgeError, MemosBridgeClient  # noqa: E402


class FakePopen:
    """In-memory stand-in for `subprocess.Popen`.

    Wires up stdin/stdout/stderr as pipes so we can script server-side
    responses from the test without touching a real process.
    """

    def __init__(self, *_args, **_kwargs) -> None:
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
    def wait(self, timeout: float | None = None) -> int:  # noqa: ARG002
        return 0

    def kill(self) -> None:
        pass


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
            self._enqueue({"jsonrpc": "2.0", "id": rpc_id, "result": {"ok": True, "version": "test"}})
        elif method == "memory.search":
            q = (req.get("params") or {}).get("query", "")
            self._enqueue({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"hits": [{"id": "t1", "excerpt": f"hit for {q}"}]},
            })
        elif method == "session.open":
            self._enqueue({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"sessionId": "hermes:session:1"},
            })
        elif method == "boom":
            self._enqueue({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": {
                    "code": -32000,
                    "message": "boom",
                    "data": {"code": "internal", "message": "boom"},
                },
            })

    def _enqueue(self, msg: dict) -> None:
        self.write(json.dumps(msg) + "\n")
        self._event.set()

    def __iter__(self):  # what the reader thread iterates over
        while True:
            val = self.getvalue()
            if self._pos < len(val):
                remainder = val[self._pos:]
                if "\n" in remainder:
                    line, _, _ = remainder.partition("\n")
                    self._pos += len(line) + 1
                    yield line + "\n"
                    continue
            self._event.wait(timeout=0.05)
            self._event.clear()
            if self._pos >= len(self.getvalue()):
                # sleep briefly, allow the test to finish
                if hasattr(self, "_done") and self._done:
                    return


class BridgeClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self._fake: FakePopen | None = None

        def _factory(*args, **kwargs):
            self._fake = FakePopen(*args, **kwargs)
            return self._fake

        self._popen_patch = patch.object(bridge_client_mod.subprocess, "Popen", _factory)
        self._which_patch = patch.object(bridge_client_mod.shutil, "which", return_value="/usr/bin/node")
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

    def test_memory_search_roundtrip(self) -> None:
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


class MemTensorProviderTests(unittest.TestCase):
    """Exercise `MemTensorProvider` against a mocked bridge."""

    def setUp(self) -> None:
        # Stub ensure_bridge_running so provider instantiation doesn't
        # spawn a real subprocess.
        import memos_provider  # noqa: F401 — import after path adjust
        self._provider_mod = memos_provider

        self._patches = [
            patch("memos_provider.ensure_bridge_running", return_value=True),
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
        self.assertIn("memory_search", names)
        self.assertIn("memory_timeline", names)

    def test_handle_tool_call_fails_gracefully_without_bridge(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        # bridge is None — should not crash, returns error JSON
        res = p.handle_tool_call("memory_search", {"query": "x"})
        parsed = json.loads(res)
        self.assertIn("error", parsed)

    def test_prefetch_returns_empty_without_bridge(self) -> None:
        p = self._provider_mod.MemTensorProvider()
        self.assertEqual(p.prefetch("anything"), "")

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


if __name__ == "__main__":
    unittest.main()
