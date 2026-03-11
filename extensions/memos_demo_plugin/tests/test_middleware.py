"""DemoPlugin middleware integration tests."""

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


class TestMiddlewareRegistration:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_audit_middleware_logs(self, caplog):
        from memos_demo_plugin.plugin import DemoPlugin

        app = FastAPI()

        @app.get("/test")
        async def test_endpoint():
            return {"ok": True}

        plugin = DemoPlugin()
        plugin.on_load()
        _init_plugin(plugin, app)

        client = TestClient(app)
        with caplog.at_level(logging.INFO):
            resp = client.get("/test")

        assert resp.status_code == 200
        assert any("[Demo Audit]" in r.message for r in caplog.records)

    def test_audit_middleware_on_plugin_routes(self, caplog):
        app, _ = _make_app()

        client = TestClient(app)
        with caplog.at_level(logging.INFO):
            client.get("/demo/health")

        assert any(
            "[Demo Audit]" in r.message and "/demo/health" in r.message for r in caplog.records
        )
