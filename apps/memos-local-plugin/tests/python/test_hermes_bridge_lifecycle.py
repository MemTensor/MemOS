"""Bridge lifecycle tests for issue #1910 — process leak hardening.

The invariant under test: no matter how many ``MemTensorProvider``
instances a host constructs (old hermes-agent versions rebuilt one per
background-review fork, i.e. per turn), the adapter must keep **at most
one** live bridge client per host process, must not pin abandoned
provider instances in memory, and must stop all of its threads once the
last provider shuts down.

These tests run against fake bridges (no Node subprocess), mirroring the
conventions in ``test_hermes_provider_pipeline.py``.
"""

from __future__ import annotations

import gc
import sys
import threading
import time
import types
import unittest
import weakref

from pathlib import Path
from unittest.mock import MagicMock, patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import memos_provider  # noqa: E402

from bridge_client import BridgeError  # noqa: E402


class FakeBridge:
    """Minimal JSON-RPC bridge double matching the pipeline-test fake."""

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
            return {"query": {"episodeId": "ep-1"}, "injectedContext": "ctx"}
        if method == "turn.end":
            return {"traceIds": ["tr-1"]}
        return {"ok": True}

    def close(self) -> None:
        self.closed = True


class DeadOnHealthBridge(FakeBridge):
    """Simulates a crashed bridge process: every health ping pipe-breaks."""

    def request(self, method: str, params: dict | None = None, **_kwargs: object) -> dict:
        if method == "core.health":
            raise BridgeError("transport_closed", "[Errno 32] Broken pipe")
        return super().request(method, params, **_kwargs)


def _reset_bridge_runtime() -> None:
    reset = getattr(memos_provider, "_reset_bridge_runtime_for_tests", None)
    if callable(reset):
        reset()


def _keepalive_threads() -> list[threading.Thread]:
    return [
        t
        for t in threading.enumerate()
        if t.name == "memos-bridge-keepalive" and t.is_alive()
    ]


class _FakeHermesPluginHost:
    """Stands in for hermes_cli.plugins.get_plugin_manager()."""

    def __init__(self) -> None:
        self.manager = types.SimpleNamespace(_hooks={})


class BridgeLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_bridge_runtime()
        self.addCleanup(_reset_bridge_runtime)

        self._daemon_patches = [
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
        ]
        for p in self._daemon_patches:
            p.start()
            self.addCleanup(p.stop)

        # Fake hermes host plugin manager so hook registration exercises
        # the real (global, deduplicated) registration path.
        self.plugin_host = _FakeHermesPluginHost()
        hermes_plugins = types.ModuleType("hermes_cli.plugins")
        hermes_plugins.get_plugin_manager = lambda: self.plugin_host.manager
        hermes_cli = types.ModuleType("hermes_cli")
        hermes_cli.plugins = hermes_plugins
        self._saved_modules = {
            name: sys.modules.get(name) for name in ("hermes_cli", "hermes_cli.plugins")
        }
        sys.modules["hermes_cli"] = hermes_cli
        sys.modules["hermes_cli.plugins"] = hermes_plugins
        self.addCleanup(self._restore_modules)

    def _restore_modules(self) -> None:
        for name, mod in self._saved_modules.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod

    def _factory(self, bridges: list[FakeBridge] | None = None) -> MagicMock:
        made: list[FakeBridge] = []

        def _make() -> FakeBridge:
            bridge = bridges.pop(0) if bridges else FakeBridge()
            made.append(bridge)
            return bridge

        mock = MagicMock(side_effect=_make)
        mock.made = made  # type: ignore[attr-defined]
        return mock

    def _initialized(self, session: str) -> memos_provider.MemTensorProvider:
        provider = memos_provider.MemTensorProvider()
        provider.initialize(session, hermes_home="/tmp/hermes-test", platform="cli")
        return provider

    # ─── One bridge per process, no matter how many providers ────────────

    def test_many_provider_instances_share_single_bridge_client(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            providers = [self._initialized(f"session-{i}") for i in range(3)]

        self.assertEqual(factory.call_count, 1)
        bridges = {id(p._bridge) for p in providers}
        self.assertEqual(len(bridges), 1)
        # Every provider still opened its own session on the shared bridge.
        shared = providers[0]._bridge
        opened = [params for method, params in shared.calls if method == "session.open"]
        self.assertEqual(
            sorted(p.get("sessionId") for p in opened),
            ["session-0", "session-1", "session-2"],
        )
        for p in providers:
            p.shutdown()

    def test_reinitialize_same_provider_does_not_spawn_second_client(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            provider = self._initialized("session-a")
            first = provider._bridge
            provider.initialize("session-a-reinit", hermes_home="/tmp/hermes-test")

        self.assertEqual(factory.call_count, 1)
        self.assertIs(provider._bridge, first)
        self.assertFalse(first.closed)
        provider.shutdown()

    # ─── Orderly shutdown of the shared client ────────────────────────────

    def test_shutdown_of_last_provider_closes_shared_client_and_keepalive(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            a = self._initialized("session-a")
            b = self._initialized("session-b")
            shared = a._bridge

            a.shutdown()
            self.assertFalse(shared.closed, "client must survive while b is live")

            b.shutdown()
        self.assertTrue(shared.closed)

        deadline = time.time() + 3.0
        while time.time() < deadline and _keepalive_threads():
            time.sleep(0.02)
        self.assertEqual(_keepalive_threads(), [])

    # ─── Host hook hygiene ────────────────────────────────────────────────

    def test_global_hooks_registered_once_for_many_providers(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            providers = [self._initialized(f"session-{i}") for i in range(3)]

        hooks = self.plugin_host.manager._hooks
        for hook_name in ("post_tool_call", "post_llm_call", "transform_tool_result"):
            self.assertEqual(
                len(hooks.get(hook_name, [])),
                1,
                f"hook {hook_name} must be installed exactly once, "
                f"got {len(hooks.get(hook_name, []))}",
            )
        for p in providers:
            p.shutdown()

    def test_hook_dispatch_still_reaches_the_matching_provider(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            provider = self._initialized("session-a")
            provider.on_turn_start(1, "task")

            for cb in self.plugin_host.manager._hooks.get("post_tool_call", []):
                cb(
                    tool_name="terminal",
                    args={"cmd": "ls"},
                    result="ok",
                    tool_call_id="t1",
                    session_id="session-a",
                )

        self.assertEqual([tc["name"] for tc in provider._tool_calls], ["terminal"])
        provider.shutdown()

    # ─── Abandoned providers must be collectable, not immortal ───────────

    def test_abandoned_provider_is_garbage_collectable(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            provider = self._initialized("session-abandoned")
            ref = weakref.ref(provider)
            # Host drops the provider without ever calling shutdown() —
            # exactly what pre-#27190 hermes review forks did every turn.
            del provider
            gc.collect()

        self.assertIsNone(
            ref(),
            "abandoned provider must be garbage-collectable; something "
            "(global hooks / keepalive thread / host handler) is pinning it",
        )

    # ─── Crash recovery without per-orphan resurrection ──────────────────

    def test_keepalive_respawns_dead_shared_bridge_exactly_once(self) -> None:
        import bridge_supervisor as supervisor_mod

        factory = self._factory(bridges=[DeadOnHealthBridge(), FakeBridge()])
        with (
            patch.object(supervisor_mod, "KEEPALIVE_INTERVAL_SEC", 0.05),
            patch("memos_provider.MemosBridgeClient", factory),
        ):
            provider = self._initialized("session-a")
            dead = provider._bridge

            deadline = time.time() + 3.0
            while time.time() < deadline and factory.call_count < 2:
                time.sleep(0.02)

            self.assertEqual(factory.call_count, 2)
            self.assertTrue(dead.closed)
            # The replacement is healthy, so no further respawn happens.
            time.sleep(0.3)
            self.assertEqual(factory.call_count, 2)
            provider.shutdown()

    def test_respawn_after_last_release_does_not_revive_client(self) -> None:
        """Race guard: a health ping can be mid-flight while the last
        provider shuts down; the subsequent respawn must not revive a
        zero-holder client that nobody will ever close."""
        import bridge_supervisor as supervisor_mod

        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            provider = self._initialized("session-a")
            client = provider._bridge
            provider.shutdown()

            revived = supervisor_mod.supervisor.respawn(client)

        self.assertIsNone(revived)
        self.assertIsNone(supervisor_mod.supervisor.peek())
        self.assertEqual(factory.call_count, 1)

    def test_keepalive_recreates_client_lost_while_holders_remain(self) -> None:
        """A failed reconnect can discard the shared client while other
        holders survive; the keepalive must recreate it proactively
        instead of idling on None forever."""
        import bridge_supervisor as supervisor_mod

        factory = self._factory()
        with (
            patch.object(supervisor_mod, "KEEPALIVE_INTERVAL_SEC", 0.05),
            patch("memos_provider.MemosBridgeClient", factory),
        ):
            a = self._initialized("session-a")
            b = self._initialized("session-b")
            shared = a._bridge

            # B's reconnect created-and-failed path discards the client.
            supervisor_mod.supervisor.discard(b, shared)
            self.assertIsNone(supervisor_mod.supervisor.peek())

            deadline = time.time() + 3.0
            while time.time() < deadline and supervisor_mod.supervisor.peek() is None:
                time.sleep(0.02)

            self.assertIsNotNone(
                supervisor_mod.supervisor.peek(),
                "keepalive must respawn a client while holders remain",
            )
            self.assertEqual(factory.call_count, 2)
            a.shutdown()
            b.shutdown()

    def test_rapid_release_then_acquire_keeps_keepalive_alive(self) -> None:
        """Stop-event reuse race: shutdown() of the last holder followed
        immediately by a fresh initialize() (same keepalive interval)
        must leave the new holder with a working keepalive — the old
        thread may still report is_alive() while exiting."""
        import bridge_supervisor as supervisor_mod

        factory = self._factory(bridges=[FakeBridge(), DeadOnHealthBridge(), FakeBridge()])
        with (
            patch.object(supervisor_mod, "KEEPALIVE_INTERVAL_SEC", 0.05),
            patch("memos_provider.MemosBridgeClient", factory),
        ):
            first = self._initialized("session-a")
            first.shutdown()
            # Immediately re-enter: the previous keepalive thread can
            # still be alive at this point with its stop event set.
            second = self._initialized("session-b")

            self.assertFalse(supervisor_mod.supervisor._keepalive_stop.is_set())
            self.assertTrue(
                supervisor_mod.supervisor._keepalive_thread is not None
                and supervisor_mod.supervisor._keepalive_thread.is_alive()
            )

            # The fresh keepalive must actually guard the new client:
            # its bridge dies on health ping and gets respawned.
            deadline = time.time() + 3.0
            while time.time() < deadline and factory.call_count < 3:
                time.sleep(0.02)
            self.assertEqual(factory.call_count, 3)
            second.shutdown()

    def test_host_llm_handler_falls_through_when_registrant_was_dropped(self) -> None:
        """host.llm.complete is last-registrant-wins on the shared client;
        if that registrant is GC'd, the weak wrapper must route to a
        surviving provider instead of failing the whole fallback path."""
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            survivor = self._initialized("session-a")
            survivor._handle_host_llm_complete = lambda params: {"text": "from-survivor"}

            dropped = self._initialized("session-b")  # registers last, wins
            shared = dropped._bridge
            del dropped
            gc.collect()

            handler = shared.host_handlers["host.llm.complete"]
            result = handler({"messages": [{"role": "user", "content": "ping"}]})

        self.assertEqual(result, {"text": "from-survivor"})
        survivor.shutdown()

    def test_stale_provider_binding_rebinds_to_current_shared_client(self) -> None:
        factory = self._factory()
        with patch("memos_provider.MemosBridgeClient", factory):
            a = self._initialized("session-a")
            b = self._initialized("session-b")
            stale = b._bridge

            # A detects a dead pipe and reconnects: the shared client is
            # replaced exactly once.
            a._reconnect_bridge("session-a")
            self.assertEqual(factory.call_count, 2)
            current = a._bridge
            self.assertIsNot(current, stale)
            self.assertTrue(stale.closed)

            # B lazily rebinds to the replacement instead of spawning a third.
            self.assertTrue(b._ensure_bridge("session-b"))
            self.assertIs(b._bridge, current)
            self.assertEqual(factory.call_count, 2)
            reopened = [
                params
                for method, params in current.calls
                if method == "session.open" and params.get("sessionId") == "session-b"
            ]
            self.assertEqual(len(reopened), 1)

            a.shutdown()
            b.shutdown()


if __name__ == "__main__":
    unittest.main()
