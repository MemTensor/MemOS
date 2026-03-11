"""DemoPlugin lifecycle & PluginManager integration tests."""

import logging

from fastapi import FastAPI


logging.basicConfig(level=logging.DEBUG)


def _init_plugin(plugin, app):
    """Simulate the PluginManager initialization flow."""
    plugin._bind_app(app)
    plugin.init_app()


class TestDemoPluginLifecycle:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_metadata(self):
        from memos_demo_plugin.plugin import DemoPlugin

        plugin = DemoPlugin()
        assert plugin.name == "demo"
        assert plugin.version == "0.1.0"

    def test_on_load_initializes_state(self):
        from memos_demo_plugin.plugin import DemoPlugin

        plugin = DemoPlugin()
        plugin.on_load()

        assert plugin.add_counter == {}
        assert plugin.request_log == []
        assert plugin.post_process_log == []
        assert plugin.hook_test_log == []

    def test_on_shutdown_no_error(self):
        from memos_demo_plugin.plugin import DemoPlugin

        plugin = DemoPlugin()
        plugin.on_load()
        plugin.on_shutdown()

    def test_full_lifecycle(self):
        """Full lifecycle: on_load → init_app → normal operation → on_shutdown."""
        from memos_demo_plugin.plugin import DemoPlugin

        app = FastAPI()
        plugin = DemoPlugin()
        plugin.on_load()
        _init_plugin(plugin, app)

        paths = [r.path for r in app.routes]
        assert "/demo/health" in paths
        assert "/demo/stats" in paths
        assert "/demo/test-hook" in paths

        plugin.on_shutdown()


class TestPluginManager:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_manual_registration_and_init(self):
        from memos.plugins.manager import PluginManager
        from memos_demo_plugin.plugin import DemoPlugin

        app = FastAPI()
        manager = PluginManager()

        plugin = DemoPlugin()
        plugin.on_load()
        manager._plugins[plugin.name] = plugin

        assert "demo" in manager.plugins

        manager.init_app(app)

        paths = [r.path for r in app.routes]
        assert "/demo/health" in paths
        assert "/demo/stats" in paths

    def test_shutdown(self):
        from memos.plugins.manager import PluginManager
        from memos_demo_plugin.plugin import DemoPlugin

        manager = PluginManager()
        plugin = DemoPlugin()
        plugin.on_load()
        manager._plugins[plugin.name] = plugin

        manager.shutdown()
