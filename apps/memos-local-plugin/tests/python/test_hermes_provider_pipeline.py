"""Hermes provider lifecycle tests.

These tests exercise the Python provider the way the Hermes host calls it,
but with a fake JSON-RPC bridge so they stay deterministic and do not spawn
Node, Hermes, or the HTTP viewer.
"""

from __future__ import annotations

import json
import sys
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
        if method == "core.health":
            return {"ok": True}
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
    def setUp(self) -> None:
        memos_provider.SHARED_BRIDGE_REGISTRY.close_all()
        self._mode_patch = patch.dict(
            "os.environ",
            {"MEMOS_HERMES_BRIDGE_MODE": "legacy"},
        )
        self._mode_patch.start()

    def tearDown(self) -> None:
        memos_provider.SHARED_BRIDGE_REGISTRY.close_all()
        self._mode_patch.stop()

    def test_plugin_version_matches_package_version(self) -> None:
        package_json = _ADAPTER_ROOT.parent.parent / "package.json"
        package_version = json.loads(package_json.read_text(encoding="utf-8"))["version"]

        self.assertEqual(memos_provider.PLUGIN_VERSION, package_version)

    def test_module_imports_cleanly(self) -> None:
        """Regression guard for #2096: asserts that ``MemosHttpClient`` is
        NOT present in ``memos_provider``, since the class was referenced
        before it was ever committed (see issue #2096).

        Note: the import itself is already validated at collection time —
        the ``import memos_provider`` at the top of this file will raise
        ``ImportError`` if a dangling reference is reintroduced, causing
        the entire test file to fail to load. This test body only adds:

        * the explicit negative guard on ``MemosHttpClient`` below (unique
          to this test), which covers both the ``memos_provider``
          re-export surface *and* ``bridge_client`` itself so a partial
          re-add of the class only in ``bridge_client`` (with no
          matching re-export) still fails the guard, and
        * positive checks on ``MemTensorProvider`` (the class the Hermes
          host actually instantiates) and on ``bridge_client``'s real
          contract (``MemosBridgeClient`` / ``BridgeError``), rather than
          on their incidental re-exports through ``memos_provider`` — the
          latter only appear on the package namespace because
          ``__init__.py`` uses a bare ``from bridge_client import ...``,
          which is an implementation detail we don't want the test to
          lock in.
        """
        import importlib

        # MemTensorProvider is the class hermes-agent host instantiates.
        self.assertTrue(hasattr(memos_provider, "MemTensorProvider"))

        # Assert the actual contract on bridge_client directly rather
        # than on its re-exports through memos_provider.
        bc = importlib.import_module("bridge_client")
        self.assertTrue(hasattr(bc, "MemosBridgeClient"))
        self.assertTrue(hasattr(bc, "BridgeError"))

        # ``MemosHttpClient`` was referenced by name in a half-merged HTTP
        # bridge feature (see #2096). It must not reappear until the class
        # itself is committed in ``bridge_client``. Guard both the
        # ``memos_provider`` re-export (which is what the original
        # ImportError travelled through) and ``bridge_client`` itself —
        # otherwise a partial re-add of the class in ``bridge_client``
        # without a matching re-export would slip past this test.
        self.assertFalse(hasattr(memos_provider, "MemosHttpClient"))
        self.assertFalse(hasattr(bc, "MemosHttpClient"))

    def test_lifecycle_persists_turn_and_closes_real_episode(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
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

        self.assertTrue(bridge.closed)

    def test_initialize_closes_previous_bridge_before_spawning_new_one(self) -> None:
        """Regression for #1927: re-calling ``initialize()`` must close the
        previously-spawned bridge instead of leaking it.

        Hermes calls ``initialize()`` on every reconnect / new session.
        Before the fix, each call replaced ``self._bridge`` with a fresh
        ``MemosBridgeClient`` (and thus a new ``--no-viewer`` Node
        subprocess) without closing the old one, leaking ~93 MB per call.
        """
        first_bridge = FakeBridge()
        second_bridge = FakeBridge()
        bridge_attempts = [first_bridge, second_bridge]

        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch(
                "memos_provider.MemosBridgeClient",
                side_effect=lambda **_kwargs: bridge_attempts.pop(0),
            ),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("session-1")
            self.assertIs(provider._bridge, first_bridge)
            self.assertFalse(first_bridge.closed)

            # Second initialize (e.g. reconnect / new Hermes session) must
            # close the previous bridge before allocating a new one.
            provider.initialize("session-2")
            self.assertTrue(
                first_bridge.closed,
                "previous bridge was not closed — leak (#1927)",
            )
            self.assertIs(provider._bridge, second_bridge)
            self.assertFalse(second_bridge.closed)

            provider.shutdown()

        # And the second bridge must be cleaned up by shutdown(), so we
        # know we did not somehow drop the new reference along the way.
        self.assertTrue(second_bridge.closed)

    def test_initialize_when_no_previous_bridge_does_not_call_close(self) -> None:
        """First-ever ``initialize()`` must not blow up on the missing
        previous bridge — it should just spawn one."""
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            self.assertIsNone(provider._bridge)

            provider.initialize("fresh-session")
            self.assertIs(provider._bridge, bridge)
            self.assertFalse(bridge.closed)

            provider.shutdown()

        self.assertTrue(bridge.closed)

    def test_initialize_swallows_exception_from_old_bridge_close(self) -> None:
        """If the previous bridge's ``close()`` raises (e.g. stuck Node
        subprocess), ``initialize()`` must still allocate the new bridge
        and proceed — never leak just because cleanup is flaky."""

        class StuckCloseBridge(FakeBridge):
            def close(self) -> None:
                # Mark closed so we can still assert it was attempted,
                # but raise to mimic a misbehaving subprocess teardown.
                self.closed = True
                raise RuntimeError("simulated stuck bridge close")

        stuck_bridge = StuckCloseBridge()
        healthy_bridge = FakeBridge()
        bridge_attempts = [stuck_bridge, healthy_bridge]

        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch(
                "memos_provider.MemosBridgeClient",
                side_effect=lambda **_kwargs: bridge_attempts.pop(0),
            ),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("session-1")
            self.assertIs(provider._bridge, stuck_bridge)

            # Must not propagate the close() failure to the caller.
            provider.initialize("session-2")
            self.assertTrue(stuck_bridge.closed)
            self.assertIs(provider._bridge, healthy_bridge)

            provider.shutdown()

        self.assertTrue(healthy_bridge.closed)

    def test_sync_turn_recovers_when_initial_bridge_open_timed_out(self) -> None:
        failed_bridge = FailingSessionOpenBridge()
        recovered_bridge = FakeBridge()
        bridge_attempts = [failed_bridge, recovered_bridge]

        def bridge_factory(**_kwargs: object) -> FakeBridge:
            return bridge_attempts.pop(0)

        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
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
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch(
                "memos_provider.MemosBridgeClient",
                side_effect=lambda **_kwargs: bridge_attempts.pop(0),
            ),
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
        record = next(
            params for method, params in recovered_bridge.calls if method == "subagent.record"
        )
        self.assertEqual(record["sessionId"], "slow-parent-session")
        self.assertEqual(record["episodeId"], "episode-from-turn-start")
        self.assertEqual(record["childSessionId"], "child-session")

    def test_sync_turn_lazily_starts_turn_when_prefetch_was_skipped(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")

            provider.on_turn_start(1, "继续处理 Hermes viewer 端口")
            provider.sync_turn(
                "继续处理 Hermes viewer 端口",
                "已继续检查 viewer 端口配置。",
            )

        methods = [method for method, _params in bridge.calls]
        self.assertEqual(methods, ["session.open", "turn.start", "turn.end"])
        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        self.assertEqual(turn_end["episodeId"], "episode-from-turn-start")

    def test_internal_hermes_review_prompt_is_not_persisted_as_user_turn(self) -> None:
        bridge = FakeBridge()
        review_prompt = (
            "Review the conversation above and consider whether a skill should be "
            "saved or updated.  Work in this order -- do not skip."
        )
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")

            provider.on_turn_start(10, review_prompt)
            self.assertEqual(provider.prefetch(review_prompt), "")
            provider._on_post_tool_call(
                tool_name="memos_search",
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

    def test_on_pre_compress_reuses_cached_prefetch_without_starting_turn(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("compress-session")
            provider.on_turn_start(2, "compress HERMES_MEMOS_E2E_0428 context")
            provider.prefetch("compress HERMES_MEMOS_E2E_0428 context")
            episode_id = provider._episode_id
            turn_starts_before = sum(method == "turn.start" for method, _ in bridge.calls)

            snapshot = provider.on_pre_compress([{"role": "user", "content": "x"}])
            repeated = provider.on_pre_compress([{"role": "user", "content": "x"}])

        self.assertIn("MemOS memory snapshot", snapshot)
        self.assertIn("remembered HERMES_MEMOS_E2E_0428", snapshot)
        self.assertEqual(repeated, snapshot)
        self.assertEqual(provider._episode_id, episode_id)
        self.assertEqual(
            sum(method == "turn.start" for method, _ in bridge.calls),
            turn_starts_before,
        )

    def test_on_pre_compress_without_cached_prefetch_is_read_only(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("compress-session")
            provider.on_turn_start(1, "first turn")

            snapshot = provider.on_pre_compress([{"role": "user", "content": "first turn"}])

        self.assertEqual(snapshot, "")
        self.assertFalse(any(method == "turn.start" for method, _ in bridge.calls))

    def test_compression_boundary_is_forwarded_to_next_turn_retrieval(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
            patch("memos_provider.time.time", return_value=1_700_000_123.456),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("compress-session")
            provider.on_pre_compress([{"role": "user", "content": "old visible turn"}])
            provider.on_turn_start(3, "what did we discuss before compression?")
            provider.prefetch("what did we discuss before compression?")

        turn_start = next(
            payload for method, payload in reversed(bridge.calls) if method == "turn.start"
        )
        self.assertEqual(
            turn_start["contextHints"]["visibleContextStartTs"],
            1_700_000_123_456,
        )
        self.assertTrue(turn_start["contextHints"]["visibleContextKnown"])

    def test_prefetch_passes_stable_turn_key_to_bridge(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("turn-key-session")
            provider.on_turn_start(7, "continue the task")
            provider.prefetch("continue the task")

        turn_start = next(params for method, params in bridge.calls if method == "turn.start")
        self.assertEqual(turn_start["turnKey"], "turn-key-session:7")

    def test_prefetch_uses_a_dedicated_budget_and_forwards_absolute_deadline(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
            patch("memos_provider._PREFETCH_RPC_TIMEOUT", 6.0),
            patch("memos_provider.time.time", return_value=1_700_000_000.0),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("budget-session")
            provider.on_turn_start(1, "recall the build decision")
            with patch.object(
                provider,
                "_bridge_request_with_retry",
                wraps=provider._bridge_request_with_retry,
            ) as request:
                provider.prefetch("recall the build decision")

        turn_start = next(params for method, params in bridge.calls if method == "turn.start")
        self.assertEqual(turn_start["deadlineAt"], 1_700_000_005_750)
        request.assert_called_once()
        self.assertLessEqual(request.call_args.kwargs["timeout"], 6.0)
        self.assertIn("deadline_monotonic", request.call_args.kwargs)

    def test_prefetch_budget_includes_bridge_ensure_time(self) -> None:
        bridge = FakeBridge()
        monotonic_now = [100.0]

        def ensure_bridge(_session_id: str, *, timeout: float) -> bool:
            self.assertAlmostEqual(timeout, 6.0, places=3)
            monotonic_now[0] += 2.5
            return True

        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
            patch("memos_provider._PREFETCH_RPC_TIMEOUT", 6.0),
            patch("memos_provider.time.time", return_value=1_700_000_000.0),
            patch("memos_provider.time.monotonic", side_effect=lambda: monotonic_now[0]),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("budget-session")
            provider.on_turn_start(1, "recall the build decision")
            with (
                patch.object(provider, "_ensure_bridge", side_effect=ensure_bridge),
                patch.object(
                    provider,
                    "_bridge_request_with_retry",
                    wraps=provider._bridge_request_with_retry,
                ) as request,
            ):
                provider.prefetch("recall the build decision")

        self.assertLessEqual(request.call_args.kwargs["timeout"], 3.5)
        turn_start = next(params for method, params in bridge.calls if method == "turn.start")
        self.assertEqual(turn_start["deadlineAt"], 1_700_000_005_750)

    def test_prefetch_timeout_config_rejects_non_positive_values(self) -> None:
        with patch.dict("os.environ", {"MEMOS_HERMES_PREFETCH_RPC_TIMEOUT": "0"}):
            self.assertEqual(memos_provider._prefetch_rpc_timeout_default(), 6.0)
        with patch.dict("os.environ", {"MEMOS_HERMES_PREFETCH_RPC_TIMEOUT": "nan"}):
            self.assertEqual(memos_provider._prefetch_rpc_timeout_default(), 6.0)
        with patch.dict("os.environ", {"MEMOS_HERMES_PREFETCH_RPC_TIMEOUT": "4.5"}):
            self.assertEqual(memos_provider._prefetch_rpc_timeout_default(), 4.5)
        with patch.dict("os.environ", {"MEMOS_HERMES_PREFETCH_RPC_TIMEOUT": "30"}):
            self.assertEqual(memos_provider._prefetch_rpc_timeout_default(), 7.0)

    def test_prefetch_suppresses_memory_injection_for_explicit_delegation(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
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
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
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
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("parent-session")
            provider.on_turn_start(1, "delegate task")
            provider.prefetch("delegate task")
            provider.on_delegation(
                "check package", "no package.json", child_session_id="child-session"
            )

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
            with (
                patch("memos_provider.ensure_bridge_running", return_value=True),
                patch("memos_provider.ensure_viewer_daemon", return_value=True),
                patch("memos_provider.MemosBridgeClient", return_value=bridge),
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

    def test_post_llm_call_backfills_tool_calls_without_post_tool_hook(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
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
                                    "arguments": '{"todos": [{"id": "1"}]}',
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
        self.assertEqual(
            turn_end["toolCalls"][0]["assistantTextBefore"],
            "好的，我来逐步完成这个分析。",
        )

    def test_post_tool_call_merges_with_llm_tool_aliases(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
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
                                    "arguments": '{"command": "curl example"}',
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

    def test_post_llm_call_preserves_visible_text_before_tool_call(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("host-session")
            provider.on_turn_start(1, "分析房价数据集")
            provider.prefetch("分析房价数据集")
            provider._on_post_llm_call(
                conversation_history=[
                    {"role": "user", "content": "分析房价数据集"},
                    {
                        "role": "assistant",
                        "content": "好的，这是经典的 Kaggle 房价预测数据集。先创建计划。",
                        "reasoning": "用户要元数据清单，先列 todo。",
                        "tool_calls": [
                            {
                                "id": "call_todo_1",
                                "call_id": "call_todo_1",
                                "type": "function",
                                "function": {
                                    "name": "todo",
                                    "arguments": '{"todos": [{"id": "step0"}]}',
                                },
                            }
                        ],
                    },
                ]
            )
            provider.sync_turn("分析房价数据集", "计划已创建。")

        turn_end = next(params for method, params in bridge.calls if method == "turn.end")
        tool = turn_end["toolCalls"][0]
        self.assertEqual(tool["name"], "todo")
        self.assertEqual(tool["thinkingBefore"], "用户要元数据清单，先列 todo。")
        self.assertEqual(
            tool["assistantTextBefore"],
            "好的，这是经典的 Kaggle 房价预测数据集。先创建计划。",
        )

    def test_transform_tool_result_appends_memos_search_hint_after_three_failures(self) -> None:
        provider = memos_provider.MemTensorProvider()
        provider.on_turn_start(1, "run failing command")

        self.assertIsNone(
            provider._on_transform_tool_result(
                tool_name="terminal",
                result="boom",
                is_error=True,
            )
        )
        self.assertIsNone(
            provider._on_transform_tool_result(
                tool_name="terminal",
                result="boom again",
                is_error=True,
            )
        )
        third = provider._on_transform_tool_result(
            tool_name="terminal",
            result="boom third",
            is_error=True,
        )
        self.assertIsNotNone(third)
        self.assertIn("failed multiple times in a row", third or "")
        self.assertIn("memos_search", third or "")

        provider._on_transform_tool_result(
            tool_name="terminal",
            result="ok",
            is_error=False,
        )
        self.assertIsNone(
            provider._on_transform_tool_result(
                tool_name="terminal",
                result="boom after reset",
                is_error=True,
            )
        )

    def test_transform_tool_result_detects_plain_error_text(self) -> None:
        provider = memos_provider.MemTensorProvider()
        provider.on_turn_start(1, "run failing command")

        self.assertIsNone(
            provider._on_transform_tool_result(
                tool_name="terminal",
                result="Error: command failed",
            )
        )
        self.assertIsNone(
            provider._on_transform_tool_result(
                tool_name="terminal",
                result="Error: command failed again",
            )
        )
        third = provider._on_transform_tool_result(
            tool_name="terminal",
            result="Error: command failed third time",
        )
        self.assertIsNotNone(third)
        self.assertIn("memos_search", third or "")

    def test_post_llm_call_orders_backfilled_tools_before_later_tool_results(self) -> None:
        bridge = FakeBridge()
        with (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
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
                                    "arguments": '{"todos": [{"id": "1"}]}',
                                },
                            },
                            {
                                "id": "call_terminal_1",
                                "call_id": "call_terminal_1",
                                "type": "function",
                                "function": {
                                    "name": "terminal",
                                    "arguments": '{"command": "search flights"}',
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


class ChineseToolResultBridge(FakeBridge):
    """Fake bridge whose read-path responses embed Chinese characters.

    Used by ``HandleToolCallEnsureAsciiTests`` to prove that every
    ``json.dumps`` inside ``handle_tool_call`` passes
    ``ensure_ascii=False`` so Chinese memory content is returned to the
    host LLM as readable UTF-8 rather than ``\\uXXXX`` escapes (#2255).
    """

    _CH_REFLECTION = "用户提供了 Tushare KEY，需要在后续查询中携带。"
    _CH_SNIPPET = "记忆命中：北京晚高峰的地铁调度策略。"
    _CH_POLICY_TITLE = "策略：夜间批任务错峰"
    _CH_POLICY_BODY = "在凌晨 02:00 之后触发全量导入，避开在线读写高峰。"
    _CH_WORLD_TITLE = "世界模型：城市晚高峰"
    _CH_WORLD_BODY = "工作日 17:30-19:30 主干道车流密集，通勤需绕行。"
    _CH_SKILL_TITLE = "技能：中文摘要"
    _CH_SKILL_PROCEDURE = "先分段抽取关键句，再融合成 3 句摘要。"

    def request(self, method: str, params: dict | None = None, **_kwargs: object) -> dict:
        payload = params or {}
        self.calls.append((method, payload))
        if method == "session.open":
            return {"sessionId": payload.get("sessionId") or "hermes:test-session"}
        if method == "core.health":
            return {"ok": True}
        if method == "memory.search":
            return {
                "hits": [
                    {
                        "id": "trace-cn-1",
                        "refId": "trace-cn-1",
                        "refKind": "trace",
                        "tier": 1,
                        "score": 0.87,
                        "snippet": self._CH_SNIPPET,
                        "reflection": self._CH_REFLECTION,
                    },
                    {
                        "id": "world-cn-1",
                        "refId": "world-cn-1",
                        "refKind": "world_model",
                        "tier": 3,
                        "score": 0.71,
                        "snippet": f"{self._CH_WORLD_TITLE}\n{self._CH_WORLD_BODY}",
                    },
                ]
            }
        if method == "memory.get_trace":
            return {
                "id": payload.get("id"),
                "episodeId": "ep-cn-1",
                "agentText": "已按用户请求完成中文摘要生成。",
                "userText": "帮我把上面的中文材料压缩成 3 句摘要。",
                "reflection": self._CH_REFLECTION,
                "ts": "2026-08-16T02:50:22Z",
                "toolCalls": [],
                "value": 0.9,
            }
        if method == "memory.get_policy":
            return {
                "id": payload.get("id"),
                "title": self._CH_POLICY_TITLE,
                "procedure": self._CH_POLICY_BODY,
                "trigger": "夜间空闲窗口",
                "verification": "首屏读取 P95 无回退",
                "boundary": "仅离线批任务",
                "gain": "峰值 QPS 下降 30%",
                "support": 12,
                "status": "active",
            }
        if method == "memory.get_world":
            return {
                "id": payload.get("id"),
                "title": self._CH_WORLD_TITLE,
                "body": self._CH_WORLD_BODY,
                "policyIds": ["policy-cn-1"],
            }
        if method == "memory.timeline":
            return {
                "traces": [
                    {
                        "id": "trace-cn-1",
                        "snippet": self._CH_SNIPPET,
                        "reflection": self._CH_REFLECTION,
                    }
                ]
            }
        if method == "memory.list_world_models":
            return {
                "worldModels": [
                    {
                        "id": "world-cn-1",
                        "title": self._CH_WORLD_TITLE,
                        "body": self._CH_WORLD_BODY,
                        "policyIds": ["policy-cn-1"],
                    }
                ]
            }
        if method == "skill.list":
            return {
                "skills": [
                    {
                        "id": "skill-cn-1",
                        "title": self._CH_SKILL_TITLE,
                        "summary": self._CH_SKILL_PROCEDURE,
                    }
                ]
            }
        if method == "skill.get":
            return {
                "id": payload.get("id"),
                "title": self._CH_SKILL_TITLE,
                "procedure": self._CH_SKILL_PROCEDURE,
            }
        if method in {"episode.close", "session.close", "subagent.record"}:
            return {"ok": True}
        raise AssertionError(f"unexpected bridge method: {method}")


class HandleToolCallEnsureAsciiTests(unittest.TestCase):
    """Regression guard for #2255.

    Every ``json.dumps`` in ``MemTensorProvider.handle_tool_call`` must
    pass ``ensure_ascii=False`` so Chinese (and other non-ASCII) memory
    content reaches the host LLM as readable UTF-8. Without the flag,
    Python's default serialization escapes each non-ASCII code point to
    ``\\uXXXX``, dramatically increasing token load and making tool
    results unreadable for humans debugging the Hermes side.
    """

    def setUp(self) -> None:
        memos_provider.SHARED_BRIDGE_REGISTRY.close_all()
        self._mode_patch = patch.dict(
            "os.environ",
            {"MEMOS_HERMES_BRIDGE_MODE": "legacy"},
        )
        self._mode_patch.start()

    def tearDown(self) -> None:
        memos_provider.SHARED_BRIDGE_REGISTRY.close_all()
        self._mode_patch.stop()

    def _make_provider(self, bridge: ChineseToolResultBridge) -> object:
        patches = (
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.MemosBridgeClient", return_value=bridge),
        )
        for p in patches:
            self.addCleanup(p.stop)
            p.start()
        provider = memos_provider.MemTensorProvider()
        provider.initialize(
            "hermes:2255",
            hermes_home="/tmp/hermes-2255-home",
            platform="cli",
            agent_identity="hermes-2255",
        )
        self.addCleanup(provider.shutdown)
        return provider

    # -- individual tools -------------------------------------------------
    #
    # Each test proves ``ensure_ascii=False`` by asserting that the raw
    # serialized string contains the Chinese literal verbatim. That
    # guarantee is stronger than searching for the two-character sequence
    # ``\\u`` in the output: with ``ensure_ascii=True`` Python would emit
    # ``\uXXXX`` escapes and the raw Chinese literal would NOT appear, so
    # ``assertIn(_CH_..., raw)`` alone catches the regression while
    # avoiding false positives on legitimate values that just happen to
    # contain a backslash followed by ``u`` (e.g. Windows paths, regex
    # patterns, or unrelated escape sequences in future fields).

    def test_memos_search_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_search", {"query": "中文摘要"})

        self.assertIn(ChineseToolResultBridge._CH_REFLECTION, raw)
        parsed = json.loads(raw)
        self.assertEqual(
            parsed["hits"][0]["reflection"],
            ChineseToolResultBridge._CH_REFLECTION,
        )

    def test_memos_get_trace_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_get", {"id": "trace-cn-1", "kind": "trace"})

        self.assertIn(ChineseToolResultBridge._CH_REFLECTION, raw)
        parsed = json.loads(raw)
        self.assertTrue(parsed["found"])
        self.assertEqual(parsed["meta"]["reflection"], ChineseToolResultBridge._CH_REFLECTION)

    def test_memos_get_policy_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_get", {"id": "policy-cn-1", "kind": "policy"})

        self.assertIn(ChineseToolResultBridge._CH_POLICY_TITLE, raw)
        parsed = json.loads(raw)
        self.assertIn(ChineseToolResultBridge._CH_POLICY_BODY, parsed["body"])

    def test_memos_get_world_model_returns_utf8_chinese(self) -> None:
        """Regression guard for the ``world_model`` branch of ``memos_get``.

        Without this case a future accidental removal of
        ``ensure_ascii=False`` from the ``world_model`` branch of
        ``memos_get`` (routed via ``memory.get_world``) would go
        undetected — the other ``memos_get`` tests only exercise the
        ``trace`` and ``policy`` kinds.
        """
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_get", {"id": "world-cn-1", "kind": "world_model"})

        self.assertIn(ChineseToolResultBridge._CH_WORLD_TITLE, raw)
        parsed = json.loads(raw)
        self.assertTrue(parsed["found"])
        self.assertEqual(parsed["kind"], "world_model")
        self.assertEqual(parsed["meta"]["title"], ChineseToolResultBridge._CH_WORLD_TITLE)
        self.assertIn(ChineseToolResultBridge._CH_WORLD_BODY, parsed["body"])

    def test_memos_timeline_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_timeline", {"episodeId": "ep-cn-1"})

        self.assertIn(ChineseToolResultBridge._CH_SNIPPET, raw)
        parsed = json.loads(raw)
        self.assertEqual(parsed["traces"][0]["snippet"], ChineseToolResultBridge._CH_SNIPPET)

    def test_memos_skill_list_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_skill_list", {"limit": 5})

        self.assertIn(ChineseToolResultBridge._CH_SKILL_TITLE, raw)
        parsed = json.loads(raw)
        self.assertEqual(
            parsed["skills"][0]["title"],
            ChineseToolResultBridge._CH_SKILL_TITLE,
        )

    def test_memos_environment_list_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_environment", {"limit": 5})

        self.assertIn(ChineseToolResultBridge._CH_WORLD_BODY, raw)
        parsed = json.loads(raw)
        self.assertFalse(parsed["queried"])
        self.assertEqual(
            parsed["worldModels"][0]["title"],
            ChineseToolResultBridge._CH_WORLD_TITLE,
        )

    def test_memos_environment_query_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_environment", {"query": "晚高峰", "limit": 5})

        self.assertIn(ChineseToolResultBridge._CH_WORLD_TITLE, raw)
        parsed = json.loads(raw)
        self.assertTrue(parsed["queried"])

    def test_memos_skill_get_returns_utf8_chinese(self) -> None:
        bridge = ChineseToolResultBridge()
        provider = self._make_provider(bridge)

        raw = provider.handle_tool_call("memos_skill_get", {"id": "skill-cn-1"})

        self.assertIn(ChineseToolResultBridge._CH_SKILL_PROCEDURE, raw)
        parsed = json.loads(raw)
        self.assertTrue(parsed["found"])
        self.assertEqual(
            parsed["skill"]["procedure"],
            ChineseToolResultBridge._CH_SKILL_PROCEDURE,
        )


if __name__ == "__main__":
    unittest.main()
