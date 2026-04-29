"""Hermes provider lifecycle tests.

These tests exercise the Python provider the way the Hermes host calls it,
but with a fake JSON-RPC bridge so they stay deterministic and do not spawn
Node, Hermes, or the HTTP viewer.
"""

from __future__ import annotations

import sys
import unittest

from pathlib import Path
from unittest.mock import patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import memos_provider  # noqa: E402


class FakeBridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.closed = False

    def request(self, method: str, params: dict | None = None) -> dict:
        payload = params or {}
        self.calls.append((method, payload))
        if method == "session.open":
            return {"sessionId": payload.get("sessionId") or "hermes:test-session"}
        if method == "turn.start":
            return {
                "query": {
                    "sessionId": payload.get("sessionId") or "hermes:test-session",
                    "episodeId": "episode-from-turn-start",
                },
                "injectedContext": "remembered HERMES_MEMOS_E2E_0428",
            }
        if method == "turn.end":
            return {"traceId": "trace-1", "episodeId": payload.get("episodeId")}
        if method in {"episode.close", "session.close", "subagent.record"}:
            return {"ok": True}
        raise AssertionError(f"unexpected bridge method: {method}")

    def close(self) -> None:
        self.closed = True


class HermesProviderPipelineTests(unittest.TestCase):
    def test_lifecycle_persists_turn_and_closes_real_episode(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize(
                "host-session",
                hermes_home="/tmp/hermes-test-home",
                platform="cli",
                agent_identity="hermes-test",
            )

            provider.on_turn_start(1, "Remember project HERMES_MEMOS_E2E_0428")
            prefetch = provider.prefetch("HERMES_MEMOS_E2E_0428")
            self.assertIn("remembered HERMES_MEMOS_E2E_0428", prefetch)
            self.assertEqual(provider._episode_id, "episode-from-turn-start")

            provider._on_post_tool_call(
                tool_name="terminal",
                args={"cmd": "npm test"},
                result="all green",
                tool_call_id="tool-1",
            )
            provider.sync_turn(
                "Remember project HERMES_MEMOS_E2E_0428",
                "Recorded the Hermes MemOS test fact.",
            )
            provider.on_session_end([])
            provider.shutdown()

        methods = [method for method, _params in bridge.calls]
        self.assertEqual(
            methods,
            [
                "session.open",
                "turn.start",
                "turn.end",
                "episode.close",
                "session.close",
            ],
        )

        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        self.assertEqual(turn_end["agent"], "hermes")
        self.assertEqual(turn_end["sessionId"], "host-session")
        self.assertEqual(turn_end["episodeId"], "episode-from-turn-start")
        self.assertIn("HERMES_MEMOS_E2E_0428", turn_end["userText"])
        self.assertIn("Recorded", turn_end["agentText"])
        self.assertEqual(turn_end["toolCalls"][0]["name"], "terminal")
        self.assertIn("npm test", turn_end["toolCalls"][0]["input"])

        episode_close = next(
            params for method, params in bridge.calls if method == "episode.close"
        )
        self.assertEqual(episode_close["episodeId"], "episode-from-turn-start")
        self.assertTrue(bridge.closed)

    def test_on_pre_compress_reuses_last_user_text_for_snapshot(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("compress-session")
            provider.on_turn_start(2, "compress HERMES_MEMOS_E2E_0428 context")

            snapshot = provider.on_pre_compress([{"role": "user", "content": "x"}])

        self.assertIn("MemOS memory snapshot", snapshot)
        self.assertIn("remembered HERMES_MEMOS_E2E_0428", snapshot)
        self.assertEqual(bridge.calls[-1][0], "turn.start")
        self.assertIn("HERMES_MEMOS_E2E_0428", bridge.calls[-1][1]["userText"])

    def test_tool_hook_ignores_other_sessions(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("parent-session")
            provider.on_turn_start(1, "parent task")
            provider.prefetch("parent task")

            provider._on_post_tool_call(
                tool_name="read_file",
                args={"path": "child-only.txt"},
                result="child output",
                tool_call_id="child-tool",
                session_id="child-session",
            )
            provider._on_post_tool_call(
                tool_name="terminal",
                args={"cmd": "npm test"},
                result="parent output",
                tool_call_id="parent-tool",
                session_id="parent-session",
            )
            provider.sync_turn("parent task", "parent done")

        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        self.assertEqual([tc["name"] for tc in turn_end["toolCalls"]], ["terminal"])

    def test_on_delegation_targets_parent_episode(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("parent-session")
            provider.on_turn_start(1, "delegate task")
            provider.prefetch("delegate task")
            provider.on_delegation("check package", "no package.json", child_session_id="child-session")

        method, params = bridge.calls[-1]
        self.assertEqual(method, "subagent.record")
        self.assertEqual(params["sessionId"], "parent-session")
        self.assertEqual(params["episodeId"], "episode-from-turn-start")
        self.assertEqual(params["childSessionId"], "child-session")


if __name__ == "__main__":
    unittest.main()
