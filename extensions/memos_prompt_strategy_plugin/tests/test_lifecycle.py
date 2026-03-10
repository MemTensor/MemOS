"""Tests for PromptStrategyPlugin lifecycle and hook integration."""

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_app():
    from memos.plugins.hooks import _hooks

    _hooks.clear()

    from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin

    app = FastAPI()
    plugin = PromptStrategyPlugin()
    plugin.on_load()
    plugin._bind_app(app)
    plugin.init_app()
    return app, plugin


class TestPluginLifecycle:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_metadata(self):
        from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin

        plugin = PromptStrategyPlugin()
        assert plugin.name == "prompt_strategy"
        assert plugin.version == "0.1.0"

    def test_on_load_initialises_components(self):
        from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin

        plugin = PromptStrategyPlugin()
        plugin.on_load()
        assert plugin.classifier is not None
        assert plugin.registry is not None
        assert len(plugin.registry.all_strategies()) > 0
        assert dict(plugin.stats) == {}

    def test_full_lifecycle(self):
        app, plugin = _make_app()
        paths = [r.path for r in app.routes]
        assert "/prompt_strategy/health" in paths
        assert "/prompt_strategy/strategies" in paths
        assert "/prompt_strategy/stats" in paths
        plugin.on_shutdown()


class TestPluginRoutes:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_health(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/prompt_strategy/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["plugin"] == "prompt_strategy"

    def test_strategies_list(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/prompt_strategy/strategies")
        assert resp.status_code == 200
        strategies = resp.json()
        assert "casual_chat" in strategies
        assert "task_oriented" in strategies

    def test_stats_empty(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/prompt_strategy/stats")
        assert resp.status_code == 200
        assert resp.json()["stats"] == {}


class TestHookIntegration:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_pre_extract_classifies_and_swaps_prompt(self):
        """When the plugin classifies a message as task_oriented, it returns
        the task-specific prompt containing the original mem_str."""
        from memos.plugins.hooks import trigger_hook

        _, plugin = _make_app()

        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt="original prompt",
            prompt_type="chat",
            mem_str="Please schedule a meeting and remind me about the deadline",
            lang="en",
            sources=[],
        )
        assert result != "original prompt"
        assert "schedule a meeting" in result
        assert plugin.stats["task_oriented"] >= 1

    def test_pre_extract_preserves_prompt_when_no_rule_matches(self):
        """When no classifier rule matches and the default prompt_type has no
        registered strategy, the original prompt passes through unchanged."""
        from memos.plugins.hooks import trigger_hook

        def _src(role, content):
            class _S:
                pass

            s = _S()
            s.role = role
            s.content = content
            return s

        _make_app()

        sources = [
            _src("user", "Let me think about that"),
            _src("assistant", "Sure, take your time"),
            _src("user", "Okay I have decided"),
        ]
        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt="original prompt",
            prompt_type="chat",
            mem_str="Let me think about that\nSure, take your time\nOkay I have decided",
            lang="en",
            sources=sources,
        )
        assert result == "original prompt"

    def test_pre_extract_tracks_stats(self):
        from memos.plugins.hooks import trigger_hook

        _, plugin = _make_app()

        trigger_hook(
            "mem_reader.pre_extract",
            prompt="p",
            prompt_type="chat",
            mem_str="I feel so happy and grateful today",
            lang="en",
            sources=[],
        )
        trigger_hook(
            "mem_reader.pre_extract",
            prompt="p",
            prompt_type="chat",
            mem_str="```python\nimport os\nprint(os.getcwd())\n```",
            lang="en",
            sources=[],
        )
        assert plugin.stats["emotional"] >= 1
        assert plugin.stats["code_discussion"] >= 1
