"""Concurrency and lifecycle tests for the Hermes shared bridge runtime."""

from __future__ import annotations

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

import memos_provider  # noqa: E402

from bridge_client import BridgeError  # noqa: E402
from shared_bridge_runtime import (  # noqa: E402
    HermesHookDispatcher,
    SharedBridgeRuntimeRegistry,
)


class FakeBridge:
    _next_pid = 4100

    def __init__(self) -> None:
        type(self)._next_pid += 1
        self.pid = type(self)._next_pid
        self.closed = False
        self.calls: list[tuple[str, dict]] = []
        self.handlers: dict[str, object] = {}

    def request(self, method: str, params: dict | None = None, **_kwargs: object) -> dict:
        if self.closed:
            raise BridgeError("transport_closed", "bridge client is closed")
        payload = params or {}
        self.calls.append((method, payload))
        if method == "core.health":
            return {"ok": True}
        if method == "session.open":
            return {"sessionId": payload.get("sessionId")}
        if method == "turn.start":
            return {
                "query": {
                    "sessionId": payload.get("sessionId"),
                    "episodeId": f"episode:{payload.get('sessionId')}",
                },
                "injectedContext": "shared memory",
            }
        if method == "turn.end":
            return {"traceIds": [f"trace:{payload.get('sessionId')}"]}
        return {}

    def register_host_handler(self, method: str, handler: object) -> None:
        self.handlers[method] = handler

    def close(self) -> None:
        self.closed = True


class FakeManager:
    def __init__(self) -> None:
        self._hooks: dict[str, list[object]] = {}


class FakeProvider:
    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self.tool_calls = 0
        self.llm_calls = 0
        self.transforms = 0

    def _on_post_tool_call(self, **_kwargs: object) -> None:
        self.tool_calls += 1

    def _on_post_llm_call(self, **_kwargs: object) -> None:
        self.llm_calls += 1

    def _on_transform_tool_result(self, **_kwargs: object) -> str:
        self.transforms += 1
        return f"handled:{self._session_id}"


class SharedBridgeRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = SharedBridgeRuntimeRegistry(
            keepalive_interval=3600.0,
            keepalive_timeout=0.1,
        )

    def tearDown(self) -> None:
        self.registry.close_all()

    def test_two_leases_share_one_bridge_and_release_does_not_close_it(self) -> None:
        created: list[FakeBridge] = []

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        first = self.registry.acquire(("shared-home",), client_factory=factory)
        second = self.registry.acquire(("shared-home",), client_factory=factory)

        self.assertEqual(len(created), 1)
        self.assertEqual(first.pid, second.pid)

        first.close()
        self.assertFalse(created[0].closed)
        self.assertEqual(second.request("core.health"), {"ok": True})

        second.close()
        self.assertFalse(created[0].closed)

    def test_concurrent_reconnect_creates_one_replacement(self) -> None:
        created: list[FakeBridge] = []

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        first = self.registry.acquire(("shared-home",), client_factory=factory)
        second = self.registry.acquire(("shared-home",), client_factory=factory)
        generation = first.generation
        barrier = threading.Barrier(3)

        def reconnect(lease) -> None:
            barrier.wait()
            lease.reconnect(expected_generation=generation)

        threads = [
            threading.Thread(target=reconnect, args=(first,)),
            threading.Thread(target=reconnect, args=(second,)),
        ]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=2.0)

        self.assertEqual(len(created), 2)
        self.assertTrue(created[0].closed)
        self.assertEqual(first.generation, generation + 1)
        self.assertEqual(first.pid, second.pid)

    def test_host_handler_is_registered_once_per_bridge_generation(self) -> None:
        bridge = FakeBridge()
        lease_a = self.registry.acquire(("shared-home",), client_factory=lambda: bridge)
        lease_b = self.registry.acquire(("shared-home",), client_factory=lambda: bridge)

        def handler_a(_params: object) -> dict[str, str]:
            return {"content": "a"}

        def handler_b(_params: object) -> dict[str, str]:
            return {"content": "b"}

        lease_a.register_host_handler("host.llm.complete", handler_a)
        lease_b.register_host_handler("host.llm.complete", handler_b)

        self.assertEqual(list(bridge.handlers), ["host.llm.complete"])
        dispatcher = bridge.handlers["host.llm.complete"]
        self.assertEqual(dispatcher({}), {"content": "b"})  # type: ignore[operator]

        lease_b.close()
        self.assertEqual(dispatcher({}), {"content": "a"})  # type: ignore[operator]

    def test_initial_host_handler_is_installed_before_first_health_check(self) -> None:
        class StartupBridge(FakeBridge):
            def request(
                self,
                method: str,
                params: dict | None = None,
                **kwargs: object,
            ) -> dict:
                if method == "core.health":
                    self_test.assertIn("host.llm.complete", self.handlers)
                return super().request(method, params, **kwargs)

        self_test = self

        def handler(_params: object) -> dict[str, str]:
            return {"content": "ready"}

        bridge = StartupBridge()
        lease = self.registry.acquire(
            ("shared-home",),
            client_factory=lambda: bridge,
            host_handlers={"host.llm.complete": handler},
        )

        dispatcher = bridge.handlers["host.llm.complete"]
        self.assertEqual(dispatcher({}), {"content": "ready"})  # type: ignore[operator]
        lease.close()

    def test_runtime_keys_isolate_distinct_data_homes(self) -> None:
        created: list[FakeBridge] = []

        def factory() -> FakeBridge:
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        first = self.registry.acquire(("home-a",), client_factory=factory)
        second = self.registry.acquire(("home-b",), client_factory=factory)

        self.assertEqual(len(created), 2)
        self.assertNotEqual(first.pid, second.pid)

    def test_failed_new_acquire_does_not_revoke_existing_leases(self) -> None:
        attempts = 0

        def factory() -> FakeBridge:
            nonlocal attempts
            attempts += 1
            if attempts > 1:
                raise RuntimeError("bridge spawn failed")
            return FakeBridge()

        lease = self.registry.acquire(("shared-home",), client_factory=factory)
        with self.assertRaises(RuntimeError):
            lease.reconnect(expected_generation=lease.generation)
        with self.assertRaises(BridgeError) as blocked:
            self.registry.acquire(("shared-home",), client_factory=factory)

        self.assertIn("backing off", str(blocked.exception))
        self.assertEqual(lease.status()["leases"], 1)


class HermesHookDispatcherTests(unittest.TestCase):
    def test_registers_one_global_hook_set_and_routes_by_session(self) -> None:
        manager = FakeManager()
        dispatcher = HermesHookDispatcher()
        first = FakeProvider("session-a")
        second = FakeProvider("session-b")

        dispatcher.bind(manager, first)
        dispatcher.bind(manager, second)
        dispatcher.bind(manager, second)

        self.assertEqual(len(manager._hooks["post_tool_call"]), 1)
        self.assertEqual(len(manager._hooks["post_llm_call"]), 1)
        self.assertEqual(len(manager._hooks["transform_tool_result"]), 1)

        manager._hooks["post_tool_call"][0](session_id="session-b")  # type: ignore[operator]
        self.assertEqual(first.tool_calls, 0)
        self.assertEqual(second.tool_calls, 1)

        result = manager._hooks["transform_tool_result"][0](session_id="session-a")  # type: ignore[operator]
        self.assertEqual(result, "handled:session-a")
        self.assertEqual(first.transforms, 1)
        self.assertEqual(second.transforms, 0)

    def test_ambiguous_sessionless_event_is_not_broadcast(self) -> None:
        manager = FakeManager()
        dispatcher = HermesHookDispatcher()
        first = FakeProvider("session-a")
        second = FakeProvider("session-b")
        dispatcher.bind(manager, first)
        dispatcher.bind(manager, second)

        manager._hooks["post_tool_call"][0](session_id="")  # type: ignore[operator]

        self.assertEqual(first.tool_calls, 0)
        self.assertEqual(second.tool_calls, 0)

    def test_unbind_removes_provider_without_unregistering_global_hooks(self) -> None:
        manager = FakeManager()
        dispatcher = HermesHookDispatcher()
        provider = FakeProvider("session-a")
        dispatcher.bind(manager, provider)

        dispatcher.unbind(provider)
        manager._hooks["post_llm_call"][0](session_id="session-a")  # type: ignore[operator]

        self.assertEqual(provider.llm_calls, 0)
        self.assertEqual(len(manager._hooks["post_llm_call"]), 1)


class SharedProviderIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        memos_provider.SHARED_BRIDGE_REGISTRY.close_all()
        self._mode_patch = patch.dict(
            "os.environ",
            {
                "MEMOS_HERMES_BRIDGE_MODE": "shared",
                "MEMOS_HOME": "/tmp/memos-hermes-shared-runtime-test",
            },
        )
        self._mode_patch.start()

    def tearDown(self) -> None:
        memos_provider.SHARED_BRIDGE_REGISTRY.close_all()
        self._mode_patch.stop()

    def test_two_providers_share_physical_bridge_and_keep_sessions_isolated(self) -> None:
        created: list[FakeBridge] = []

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        with (
            patch("memos_provider.MemosBridgeClient", side_effect=factory),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0) as kill_zombies,
        ):
            first = memos_provider.MemTensorProvider()
            second = memos_provider.MemTensorProvider()
            first.initialize("session-a")
            second.initialize("session-b")

            self.assertEqual(len(created), 1)
            self.assertEqual(first._bridge.pid, second._bridge.pid)

            first.prefetch("remember A")
            second.prefetch("remember B")
            first.sync_turn("remember A", "stored A")
            second.sync_turn("remember B", "stored B")
            kill_zombies.assert_not_called()

            first.shutdown()
            self.assertFalse(created[0].closed)
            self.assertIn("Recalled Memories", second.prefetch("still alive"))
            second.shutdown()
            self.assertFalse(created[0].closed)

        session_ids = [
            payload.get("sessionId")
            for method, payload in created[0].calls
            if method in {"session.open", "turn.start", "turn.end", "session.close"}
        ]
        self.assertIn("session-a", session_ids)
        self.assertIn("session-b", session_ids)

    def test_lazy_provider_acquire_reuses_healthy_shared_bridge(self) -> None:
        created: list[FakeBridge] = []

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        with (
            patch("memos_provider.MemosBridgeClient", side_effect=factory),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0),
        ):
            first = memos_provider.MemTensorProvider()
            first.initialize("session-a")
            assert first._bridge is not None
            original_pid = first._bridge.pid
            original_generation = first._bridge.generation

            second = memos_provider.MemTensorProvider()
            second._session_id = "session-b"
            self.assertTrue(second._ensure_bridge("session-b"))

            self.assertEqual(len(created), 1)
            assert second._bridge is not None
            self.assertEqual(second._bridge.pid, original_pid)
            self.assertEqual(second._bridge.generation, original_generation)
            self.assertEqual(second._bridge.status()["leases"], 2)

            first.shutdown()
            second.shutdown()

    def test_distinct_data_home_runtime_keeps_its_spawn_environment(self) -> None:
        created: list[FakeBridge] = []
        client_kwargs: list[dict[str, object]] = []

        def factory(*_args: object, **kwargs: object) -> FakeBridge:
            client_kwargs.append(dict(kwargs))
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        with (
            patch("memos_provider.MemosBridgeClient", side_effect=factory),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0),
        ):
            first = memos_provider.MemTensorProvider()
            second = memos_provider.MemTensorProvider()
            with patch.dict("os.environ", {"MEMOS_HOME": "/tmp/memos-home-a"}):
                first.initialize("session-a")
            with patch.dict("os.environ", {"MEMOS_HOME": "/tmp/memos-home-b"}):
                second.initialize("session-b")

            self.assertEqual(len(created), 2)
            home_a = str(Path("/tmp/memos-home-a").resolve())
            home_b = str(Path("/tmp/memos-home-b").resolve())
            self.assertEqual(client_kwargs[0]["runtime_home"], home_a)
            self.assertEqual(client_kwargs[1]["runtime_home"], home_b)

            assert first._bridge is not None
            with patch.dict("os.environ", {"MEMOS_HOME": "/tmp/memos-home-b"}):
                first._bridge.reconnect(expected_generation=first._bridge.generation)

            self.assertEqual(len(created), 3)
            self.assertEqual(client_kwargs[2]["runtime_home"], home_a)
            self.assertEqual(
                client_kwargs[2]["extra_env"],
                {"MEMOS_HOME": home_a},
            )

            first.shutdown()
            second.shutdown()

    def test_lazy_acquire_failure_releases_new_lease(self) -> None:
        class RejectSessionBridge(FakeBridge):
            def request(
                self,
                method: str,
                params: dict | None = None,
                **kwargs: object,
            ) -> dict:
                if method == "session.open":
                    raise BridgeError("internal", "session rejected")
                return super().request(method, params, **kwargs)

        with (
            patch(
                "memos_provider.MemosBridgeClient",
                side_effect=lambda *_args, **_kwargs: RejectSessionBridge(),
            ),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0),
        ):
            provider = memos_provider.MemTensorProvider()
            provider._session_id = "session-a"

            self.assertFalse(provider._ensure_bridge("session-a"))
            self.assertIsNone(provider._bridge)
            statuses = memos_provider.SHARED_BRIDGE_REGISTRY.status()
            self.assertEqual(len(statuses), 1)
            self.assertEqual(statuses[0]["leases"], 0)

            provider.shutdown()

    def test_lazy_acquire_reconnects_once_on_transport_closed(self) -> None:
        created: list[FakeBridge] = []

        class FirstSessionOpenFails(FakeBridge):
            def request(
                self,
                method: str,
                params: dict | None = None,
                **kwargs: object,
            ) -> dict:
                if method == "session.open":
                    raise BridgeError("transport_closed", "bridge subprocess exited")
                return super().request(method, params, **kwargs)

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            bridge = FirstSessionOpenFails() if not created else FakeBridge()
            created.append(bridge)
            return bridge

        with (
            patch("memos_provider.MemosBridgeClient", side_effect=factory),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0),
        ):
            provider = memos_provider.MemTensorProvider()
            provider._session_id = "session-a"

            self.assertTrue(provider._ensure_bridge("session-a"))
            self.assertEqual(len(created), 2)
            self.assertTrue(created[0].closed)
            assert provider._bridge is not None
            self.assertEqual(provider._bridge.generation, 2)
            self.assertEqual(provider._bridge.status()["leases"], 1)

            provider.shutdown()

    def test_existing_lease_is_retained_when_reconnect_fails(self) -> None:
        attempts = 0

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            nonlocal attempts
            attempts += 1
            if attempts > 1:
                raise RuntimeError("replacement spawn failed")
            return FakeBridge()

        with (
            patch("memos_provider.MemosBridgeClient", side_effect=factory),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0),
        ):
            provider = memos_provider.MemTensorProvider()
            provider.initialize("session-a")
            original_lease = provider._bridge
            assert original_lease is not None

            with self.assertRaises(RuntimeError):
                provider._reconnect_bridge("session-a")

            self.assertIs(provider._bridge, original_lease)
            self.assertEqual(original_lease.status()["leases"], 1)

            provider.shutdown()

    def test_provider_reopens_its_session_after_another_lease_reconnects(self) -> None:
        created: list[FakeBridge] = []

        def factory(*_args: object, **_kwargs: object) -> FakeBridge:
            bridge = FakeBridge()
            created.append(bridge)
            return bridge

        with (
            patch("memos_provider.MemosBridgeClient", side_effect=factory),
            patch("memos_provider.ensure_bridge_running", return_value=True),
            patch("memos_provider.ensure_viewer_daemon", return_value=True),
            patch("memos_provider.kill_zombie_bridges", return_value=0),
        ):
            first = memos_provider.MemTensorProvider()
            second = memos_provider.MemTensorProvider()
            first.initialize("session-a")
            second.initialize("session-b")

            old_generation = first._bridge.generation
            first._bridge.reconnect(expected_generation=old_generation)
            self.assertEqual(len(created), 2)

            second.handle_tool_call("memos_search", {"query": "after reconnect"})
            methods = [method for method, _payload in created[1].calls]
            session_open_index = methods.index("session.open")
            search_index = methods.index("memory.search")
            self.assertLess(session_open_index, search_index)
            reopened = created[1].calls[session_open_index][1]
            self.assertEqual(reopened["sessionId"], "session-b")

            first.shutdown()
            second.shutdown()


if __name__ == "__main__":
    unittest.main()
