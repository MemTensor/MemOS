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

    def test_post_llm_call_backfills_tool_calls_without_post_tool_hook(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")
            provider.on_turn_start(1, "东京房产投资分析")
            provider.prefetch("东京房产投资分析")

            provider._on_post_llm_call(
                conversation_history=[
                    {"role": "user", "content": "东京房产投资分析"},
                    {
                        "role": "assistant",
                        "content": "好的，我来逐步完成这个分析。",
                        "reasoning": "先列计划，再查汇率和房源。",
                        "tool_calls": [
                            {
                                "id": "call_todo_1",
                                "call_id": "call_todo_1",
                                "response_item_id": "fc_todo_1",
                                "type": "function",
                                "function": {
                                    "name": "todo",
                                    "arguments": "{\"todos\": [{\"id\": \"1\"}]}",
                                },
                            }
                        ],
                    },
                ]
            )
            provider.sync_turn("东京房产投资分析", "好的，我来逐步完成这个分析。")

        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        self.assertEqual(turn_end["toolCalls"][0]["name"], "todo")
        self.assertIn('"todos"', turn_end["toolCalls"][0]["input"])
        self.assertEqual(turn_end["toolCalls"][0]["thinkingBefore"], "先列计划，再查汇率和房源。")

    def test_post_tool_call_merges_with_llm_tool_aliases(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")
            provider.on_turn_start(1, "查汇率")
            provider.prefetch("查汇率")
            provider._on_post_llm_call(
                conversation_history=[
                    {"role": "user", "content": "查汇率"},
                    {
                        "role": "assistant",
                        "reasoning": "用 terminal 调 API。",
                        "tool_calls": [
                            {
                                "id": "call_terminal_1",
                                "call_id": "call_terminal_1",
                                "response_item_id": "fc_terminal_1",
                                "type": "function",
                                "function": {
                                    "name": "terminal",
                                    "arguments": "{\"command\": \"curl example\"}",
                                },
                            }
                        ],
                    },
                ]
            )
            provider._on_post_tool_call(
                tool_name="terminal",
                args={"command": "curl example"},
                result="1 JPY = 0.006 USD",
                tool_call_id="call_terminal_1",
            )
            provider.sync_turn("查汇率", "查到了。")

        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        self.assertEqual(len(turn_end["toolCalls"]), 1)
        self.assertEqual(turn_end["toolCalls"][0]["name"], "terminal")
        self.assertIn("0.006 USD", turn_end["toolCalls"][0]["output"])
        self.assertEqual(turn_end["toolCalls"][0]["thinkingBefore"], "用 terminal 调 API。")

    def test_post_llm_call_orders_backfilled_tools_before_later_tool_results(self) -> None:
        bridge = FakeBridge()
        with patch("memos_provider.ensure_bridge_running", return_value=True), patch(
            "memos_provider.MemosBridgeClient", return_value=bridge
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")
            provider.on_turn_start(1, "规划北欧旅行")
            provider.prefetch("规划北欧旅行")

            # A later executed tool may be reported before post_llm_call
            # backfills planner/todo calls from conversation_history.
            provider._on_post_tool_call(
                tool_name="terminal",
                args={"command": "search flights"},
                result="PVG-CPH 4200 RMB",
                tool_call_id="call_terminal_1",
            )
            provider._on_post_llm_call(
                conversation_history=[
                    {"role": "user", "content": "规划北欧旅行"},
                    {
                        "role": "assistant",
                        "reasoning": "先列计划，再查机票。",
                        "tool_calls": [
                            {
                                "id": "call_todo_1",
                                "call_id": "call_todo_1",
                                "type": "function",
                                "function": {
                                    "name": "todo",
                                    "arguments": "{\"todos\": [{\"id\": \"1\"}]}",
                                },
                            },
                            {
                                "id": "call_terminal_1",
                                "call_id": "call_terminal_1",
                                "type": "function",
                                "function": {
                                    "name": "terminal",
                                    "arguments": "{\"command\": \"search flights\"}",
                                },
                            },
                        ],
                    },
                ]
            )
            provider.sync_turn("规划北欧旅行", "路线和预算整理好了。")

        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        self.assertEqual([tc["name"] for tc in turn_end["toolCalls"]], ["todo", "terminal"])
        self.assertIn('"todos"', turn_end["toolCalls"][0]["input"])
        self.assertEqual(turn_end["toolCalls"][0]["thinkingBefore"], "先列计划，再查机票。")
        self.assertIn("PVG-CPH", turn_end["toolCalls"][1]["output"])
        self.assertEqual(turn_end["toolCalls"][1]["thinkingBefore"], "先列计划，再查机票。")


if __name__ == "__main__":
    unittest.main()
