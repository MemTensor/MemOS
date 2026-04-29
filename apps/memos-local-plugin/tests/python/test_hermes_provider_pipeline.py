"""Hermes provider lifecycle tests.

These tests exercise the Python provider the way the Hermes host calls it,
but with a fake JSON-RPC bridge so they stay deterministic and do not spawn
Node, Hermes, or the HTTP viewer.
"""

from __future__ import annotations

import sys
import json
import tempfile
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
        self.host_handlers: dict[str, object] = {}

    def register_host_handler(self, method: str, handler: object) -> None:
        self.host_handlers[method] = handler

    def request(self, method: str, params: dict | None = None, **_kwargs: object) -> dict:
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


class FailingSessionOpenBridge(FakeBridge):
    def request(self, method: str, params: dict | None = None, **_kwargs: object) -> dict:
        if method == "session.open":
            self.closed = True
            raise RuntimeError("session.open did not respond")
        return super().request(method, params, **_kwargs)


class HermesProviderPipelineTests(unittest.TestCase):
    def test_lifecycle_persists_turn_and_closes_real_episode(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
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

        episode_close = next(params for method, params in bridge.calls if method == "episode.close")
        self.assertEqual(episode_close["episodeId"], "episode-from-turn-start")
        self.assertTrue(bridge.closed)

    def test_sync_turn_recovers_when_initial_bridge_open_timed_out(self) -> None:
        failed_bridge = FailingSessionOpenBridge()
        recovered_bridge = FakeBridge()
        bridge_attempts = [failed_bridge, recovered_bridge]

        def bridge_factory() -> FakeBridge:
            return bridge_attempts.pop(0)

        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.MemosBridgeClient", side_effect=bridge_factory),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("slow-start-session")
            self.assertIsNone(provider._bridge)
            self.assertTrue(failed_bridge.closed)

            provider.on_turn_start(1, "检查 package.json")
            provider._on_post_tool_call(
                tool_name="read_file",
                args={"path": "package.json"},
                result='{"content":"{}"}',
                tool_call_id="tool-1",
            )
            provider.sync_turn("检查 package.json", "检查完成")

        methods = [method for method, _params in recovered_bridge.calls]
        self.assertEqual(methods, ["session.open", "turn.start", "turn.end"])
        turn_end = next(params for method, params in recovered_bridge.calls if method == "turn.end")
        self.assertEqual(turn_end["sessionId"], "slow-start-session")
        self.assertEqual(turn_end["episodeId"], "episode-from-turn-start")
        self.assertEqual(turn_end["toolCalls"][0]["name"], "read_file")

    def test_delegation_recovers_when_initial_bridge_open_timed_out(self) -> None:
        recovered_bridge = FakeBridge()
        bridge_attempts = [FailingSessionOpenBridge(), recovered_bridge]

        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.MemosBridgeClient", side_effect=lambda: bridge_attempts.pop(0)),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("slow-parent-session")
            provider.on_turn_start(1, "请派一个子代理检查 package.json")
            provider.on_delegation(
                "检查 package.json scripts",
                "当前目录没有 package.json",
                child_session_id="child-session",
            )

        methods = [method for method, _params in recovered_bridge.calls]
        self.assertEqual(methods, ["session.open", "turn.start", "subagent.record"])
        record = next(params for method, params in recovered_bridge.calls if method == "subagent.record")
        self.assertEqual(record["sessionId"], "slow-parent-session")
        self.assertEqual(record["episodeId"], "episode-from-turn-start")
        self.assertEqual(record["childSessionId"], "child-session")

    def test_internal_hermes_review_prompt_is_not_persisted_as_user_turn(self) -> None:
        bridge = FakeBridge()
        review_prompt = (
            "Review the conversation above and consider saving or updating a skill if appropriate."
        )
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")

            provider.on_turn_start(10, review_prompt)
            self.assertEqual(provider.prefetch(review_prompt), "")
            provider._on_post_tool_call(
                tool_name="memory_search",
                args={"query": "conversation"},
                result="[]",
                tool_call_id="tool-1",
            )
            provider.sync_turn(review_prompt, "Nothing to save.")
            provider.on_session_end([])

        methods = [method for method, _params in bridge.calls]
        self.assertEqual(methods, ["session.open", "session.close"])
        self.assertFalse(any(method == "turn.start" for method, _ in bridge.calls))
        self.assertFalse(any(method == "turn.end" for method, _ in bridge.calls))

    def test_on_pre_compress_reuses_last_user_text_for_snapshot(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("compress-session")
            provider.on_turn_start(2, "compress HERMES_MEMOS_E2E_0428 context")

            snapshot = provider.on_pre_compress([{"role": "user", "content": "x"}])

        self.assertIn("MemOS memory snapshot", snapshot)
        self.assertIn("remembered HERMES_MEMOS_E2E_0428", snapshot)
        self.assertEqual(bridge.calls[-1][0], "turn.start")
        self.assertIn("HERMES_MEMOS_E2E_0428", bridge.calls[-1][1]["userText"])

    def test_prefetch_suppresses_memory_injection_for_explicit_delegation(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("parent-session")
            provider.on_turn_start(1, "请派一个子代理检查 package.json")

            prefetch = provider.prefetch("请派一个子代理检查 package.json")

        self.assertEqual(prefetch, "")
        self.assertEqual(provider._episode_id, "episode-from-turn-start")
        self.assertEqual(bridge.calls[-1][0], "turn.start")
        self.assertIn("子代理", bridge.calls[-1][1]["userText"])

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

    def test_on_delegation_backfills_child_session_tool_calls(self) -> None:
        bridge = FakeBridge()
        with tempfile.TemporaryDirectory() as tmp:
            sessions_dir = Path(tmp) / "sessions"
            sessions_dir.mkdir()
            (sessions_dir / "session_child-session.json").write_text(
                json.dumps(
                    {
                        "messages": [
                            {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "id": "tool-1",
                                        "type": "function",
                                        "function": {
                                            "name": "read_file",
                                            "arguments": json.dumps(
                                                {"path": "package.json", "limit": 20}
                                            ),
                                        },
                                    }
                                ],
                            },
                            {
                                "role": "tool",
                                "tool_call_id": "tool-1",
                                "content": json.dumps({"content": "1|{}", "total_lines": 1}),
                            },
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
                "memos_provider.MemosBridgeClient", return_value=bridge
            ):
                provider = memos_provider.MemTensorProvider()
                provider.initialize("parent-session", hermes_home=tmp)
                provider.on_turn_start(1, "delegate task")
                provider.prefetch("delegate task")
                provider.on_delegation(
                    "check package",
                    "package exists",
                    child_session_id="child-session",
                )

        method, params = bridge.calls[-1]
        self.assertEqual(method, "subagent.record")
        self.assertEqual(params["toolCalls"][0]["name"], "read_file")
        self.assertEqual(params["toolCalls"][0]["input"]["path"], "package.json")
        self.assertIn("total_lines", params["toolCalls"][0]["output"])


if __name__ == "__main__":
    unittest.main()
