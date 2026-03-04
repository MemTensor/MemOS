"""DemoPlugin routes and /demo/test-hook endpoint tests."""

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient


logging.basicConfig(level=logging.DEBUG)


def _init_plugin(plugin, app):
    plugin._bind_app(app)
    plugin.init_app()


def _make_app():
    from memos_demo_plugin.plugin import DemoPlugin

    app = FastAPI()
    plugin = DemoPlugin()
    plugin.on_load()
    _init_plugin(plugin, app)
    return app, plugin


# ========================================================================= #
#  Route registration verification
# ========================================================================= #


class TestRouteRegistration:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_routes_exist(self):
        app, _ = _make_app()
        paths = [r.path for r in app.routes]
        assert "/demo/health" in paths
        assert "/demo/stats" in paths
        assert "/demo/test-hook" in paths

    def test_health_endpoint(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/demo/health")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["plugin"] == "demo"
        assert data["version"] == "0.1.0"

    def test_stats_endpoint_empty(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/demo/stats")

        assert resp.status_code == 200
        data = resp.json()
        assert data["add_counter"] == {}
        assert data["total_adds"] == 0
        assert data["recent_requests"] == []

    def test_stats_endpoint_after_hooks(self):
        from memos.plugins.hooks import trigger_hook

        app, plugin = _make_app()

        class FakeRequest:
            user_id = "user_42"

        trigger_hook("add.before", request=FakeRequest())
        trigger_hook("add.after", request=FakeRequest(), result={"ok": True})
        trigger_hook("add.before", request=FakeRequest())
        trigger_hook("add.after", request=FakeRequest(), result={"ok": True})

        client = TestClient(app)
        resp = client.get("/demo/stats")
        data = resp.json()

        assert data["add_counter"]["user_42"] == 2
        assert data["total_adds"] == 2
        assert len(data["recent_requests"]) == 2


# ========================================================================= #
#  /demo/test-hook endpoint — @hookable + custom trigger_hook full chain
# ========================================================================= #


class TestHookEndpoint:
    """Verify full hook call chain of the test endpoint:
    demo.test.before → business logic → demo.test.post_process → demo.test.after
    """

    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_basic_response(self):
        app, _ = _make_app()
        client = TestClient(app)

        resp = client.post("/demo/test-hook", json={"user_id": "tester", "message": "ping"})
        assert resp.status_code == 200

        data = resp.json()
        hook_result = data["hook_test"]
        assert hook_result["user_id"] == "tester"
        assert hook_result["echo"] == "ping"
        assert hook_result["processed"] is True

    def test_after_hook_injects_field(self):
        """demo.test.after callback injects hook_after_injected=True."""
        app, _ = _make_app()
        client = TestClient(app)

        resp = client.post("/demo/test-hook", json={"user_id": "u1", "message": "hi"})
        assert resp.json()["hook_test"]["hook_after_injected"] is True

    def test_post_process_hook_injects_field(self):
        """demo.test.post_process custom hook injects hook_post_process_injected=True."""
        app, _ = _make_app()
        client = TestClient(app)

        resp = client.post("/demo/test-hook", json={"user_id": "u2", "message": "world"})
        assert resp.json()["hook_test"]["hook_post_process_injected"] is True

    def test_records_all_three_phases(self):
        """plugin.hook_test_log should record all three phases: before / post_process / after."""
        app, plugin = _make_app()
        client = TestClient(app)

        client.post("/demo/test-hook", json={"user_id": "u3", "message": "test"})

        phases = [entry["phase"] for entry in plugin.hook_test_log]
        assert "before" in phases
        assert "post_process" in phases
        assert "after" in phases

    def test_state_in_response(self):
        """plugin_state.hook_test_log in response should contain records for all three phases."""
        app, _ = _make_app()
        client = TestClient(app)

        resp = client.post("/demo/test-hook", json={"user_id": "u4", "message": "check"})
        data = resp.json()

        log = data["plugin_state"]["hook_test_log"]
        assert len(log) >= 3
        assert any(e["phase"] == "before" for e in log)
        assert any(e["phase"] == "post_process" for e in log)
        assert any(e["phase"] == "after" for e in log)

    def test_multiple_calls_accumulate(self):
        """hook_test_log should accumulate after multiple calls."""
        app, plugin = _make_app()
        client = TestClient(app)

        client.post("/demo/test-hook", json={"user_id": "a"})
        client.post("/demo/test-hook", json={"user_id": "b"})

        assert len(plugin.hook_test_log) >= 6

    def test_default_values(self):
        """Call with default parameters."""
        app, _ = _make_app()
        client = TestClient(app)

        resp = client.post("/demo/test-hook", json={})
        data = resp.json()

        assert data["hook_test"]["user_id"] == "anonymous"
        assert data["hook_test"]["echo"] == "hello"

    def test_custom_hook_enrich_report(self):
        """demo.report.enrich custom hook example — response contains user_report extended by callback."""
        app, _ = _make_app()
        client = TestClient(app)

        resp = client.post("/demo/test-hook", json={"user_id": "alice"})
        data = resp.json()

        report = data["user_report"]
        assert report["user_id"] == "alice"
        assert "add_count" in report
        assert "operation_count" in report
        assert report["enriched_by"] == "demo"
        assert "total_users_tracked" in report
        assert "is_active_user" in report
