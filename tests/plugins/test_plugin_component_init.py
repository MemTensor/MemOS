from __future__ import annotations

from collections import namedtuple


class TestPluginComponentInit:
    def test_build_plugin_context_shapes_expected_sections(self):
        from memos.plugins.component_bootstrap import build_plugin_context

        context = build_plugin_context(
            graph_db="graph",
            embedder="embedder",
            default_cube_config="cube",
            nli_client_config={"base_url": "http://nli"},
            mem_reader_config="mem_reader",
            reranker_config="reranker",
            feedback_reranker_config="feedback_reranker",
            internet_retriever_config="internet",
        )

        assert context["shared"]["graph_db"] == "graph"
        assert context["shared"]["embedder"] == "embedder"
        assert context["configs"]["default_cube_config"] == "cube"
        assert context["configs"]["nli_client_config"]["base_url"] == "http://nli"
        assert "components" not in context

    def test_manager_calls_init_components(self):
        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        class DummyPlugin(MemOSPlugin):
            name = "dummy"

            def on_load(self) -> None:
                self.calls = 0

            def init_components(self, context: dict) -> None:
                self.calls += 1
                context["components"]["dummy"] = "ok"

        plugin = DummyPlugin()
        plugin.on_load()
        manager = PluginManager()
        manager._plugins[plugin.name] = plugin
        context = {"components": {}}

        manager.init_components(context)

        assert plugin.calls == 1
        assert context["components"]["dummy"] == "ok"

    def test_discover_is_idempotent(self, monkeypatch):
        import importlib.metadata

        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        EntryPoint = namedtuple("EntryPoint", ["name", "load"])

        class DummyPlugin(MemOSPlugin):
            name = "dummy"

        load_calls = {"count": 0}

        def load_plugin():
            load_calls["count"] += 1
            return DummyPlugin

        class EntryPoints(list):
            def select(self, *, group):
                assert group == "memos.plugins"
                return self

        monkeypatch.setattr(
            importlib.metadata,
            "entry_points",
            lambda: EntryPoints([EntryPoint(name="dummy", load=load_plugin)]),
        )

        manager = PluginManager()
        manager.discover()
        manager.discover()

        assert load_calls["count"] == 1
        assert list(manager.plugins) == ["dummy"]

    def test_discover_loads_plugins_by_default(self, monkeypatch):
        import importlib.metadata

        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        EntryPoint = namedtuple("EntryPoint", ["name", "load"])

        class OptInPlugin(MemOSPlugin):
            name = "regular"

        class EntryPoints(list):
            def select(self, *, group):
                assert group == "memos.plugins"
                return self

        monkeypatch.delenv("MEMOS_DISABLED_PLUGINS", raising=False)
        monkeypatch.setattr(
            importlib.metadata,
            "entry_points",
            lambda: EntryPoints([EntryPoint(name="regular", load=lambda: OptInPlugin)]),
        )

        manager = PluginManager()
        manager.discover()

        assert list(manager.plugins) == ["regular"]

    def test_discover_skips_plugins_disabled_by_default(self, monkeypatch):
        import importlib.metadata

        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        EntryPoint = namedtuple("EntryPoint", ["name", "load"])

        class DreamLikePlugin(MemOSPlugin):
            name = "dream"
            enabled_by_default = False

        class EntryPoints(list):
            def select(self, *, group):
                assert group == "memos.plugins"
                return self

        monkeypatch.delenv("MEMOS_DISABLED_PLUGINS", raising=False)
        monkeypatch.delenv("MEMOS_ENABLED_PLUGINS", raising=False)
        monkeypatch.setattr(
            importlib.metadata,
            "entry_points",
            lambda: EntryPoints([EntryPoint(name="dream", load=lambda: DreamLikePlugin)]),
        )

        manager = PluginManager()
        manager.discover()

        assert list(manager.plugins) == []

    def test_discover_loads_default_disabled_plugin_when_enabled(self, monkeypatch):
        import importlib.metadata

        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        EntryPoint = namedtuple("EntryPoint", ["name", "load"])

        class DreamLikePlugin(MemOSPlugin):
            name = "dream"
            enabled_by_default = False

        class EntryPoints(list):
            def select(self, *, group):
                assert group == "memos.plugins"
                return self

        monkeypatch.delenv("MEMOS_DISABLED_PLUGINS", raising=False)
        monkeypatch.setenv("MEMOS_ENABLED_PLUGINS", "dream")
        monkeypatch.setattr(
            importlib.metadata,
            "entry_points",
            lambda: EntryPoints([EntryPoint(name="dream", load=lambda: DreamLikePlugin)]),
        )

        manager = PluginManager()
        manager.discover()

        assert list(manager.plugins) == ["dream"]

    def test_discover_skips_disabled_plugin(self, monkeypatch):
        import importlib.metadata

        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        EntryPoint = namedtuple("EntryPoint", ["name", "load"])

        class DisabledPlugin(MemOSPlugin):
            name = "disabled_one"

        class EntryPoints(list):
            def select(self, *, group):
                assert group == "memos.plugins"
                return self

        monkeypatch.setenv("MEMOS_DISABLED_PLUGINS", "disabled_one")
        monkeypatch.setattr(
            importlib.metadata,
            "entry_points",
            lambda: EntryPoints([EntryPoint(name="disabled_one", load=lambda: DisabledPlugin)]),
        )

        manager = PluginManager()
        manager.discover()

        assert list(manager.plugins) == []

    def test_discover_disabled_env_overrides_enabled_env(self, monkeypatch):
        import importlib.metadata

        from memos.plugins.base import MemOSPlugin
        from memos.plugins.manager import PluginManager

        EntryPoint = namedtuple("EntryPoint", ["name", "load"])

        class DreamLikePlugin(MemOSPlugin):
            name = "dream"
            enabled_by_default = False

        class EntryPoints(list):
            def select(self, *, group):
                assert group == "memos.plugins"
                return self

        monkeypatch.setenv("MEMOS_DISABLED_PLUGINS", "dream")
        monkeypatch.setenv("MEMOS_ENABLED_PLUGINS", "dream")
        monkeypatch.setattr(
            importlib.metadata,
            "entry_points",
            lambda: EntryPoints([EntryPoint(name="dream", load=lambda: DreamLikePlugin)]),
        )

        manager = PluginManager()
        manager.discover()

        assert list(manager.plugins) == []

    def test_builtin_dream_plugin_is_disabled_by_default(self):
        from memos.dream import CommunityDreamPlugin

        assert CommunityDreamPlugin.enabled_by_default is False
