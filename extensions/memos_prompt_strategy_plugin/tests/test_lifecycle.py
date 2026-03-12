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


def _src(role, content):
    class _S:
        pass

    s = _S()
    s.role = role
    s.content = content
    return s


class TestPluginLifecycle:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_metadata(self):
        from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin

        plugin = PromptStrategyPlugin()
        assert plugin.name == "prompt_strategy"
        assert plugin.version == "0.2.0"

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
        assert "identity_relation" in strategies

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

    def test_pre_extract_swaps_prompt_for_identity(self):
        """When identity/relation pattern is detected, the prompt is swapped."""
        from memos.plugins.hooks import trigger_hook

        _, plugin = _make_app()

        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt="original prompt",
            prompt_type="chat",
            mem_str="我叫王沐辰，我的儿子叫王明泽",
            lang="zh",
            sources=[],
        )
        assert result != "original prompt"
        assert "王沐辰" in result
        assert "王明泽" in result
        assert plugin.stats["identity_relation"] >= 1

    def test_pre_extract_preserves_prompt_for_normal_text(self):
        """When no classifier rule matches, original prompt passes through."""
        from memos.plugins.hooks import trigger_hook

        _make_app()

        sources = [_src("user", "今天天气不错，出去走走吧")]
        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt="original prompt",
            prompt_type="chat",
            mem_str="今天天气不错，出去走走吧",
            lang="zh",
            sources=sources,
        )
        assert result == "original prompt"

    def test_pre_extract_english_identity(self):
        from memos.plugins.hooks import trigger_hook

        _, plugin = _make_app()

        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt="original prompt",
            prompt_type="chat",
            mem_str="My name is Alice and my son is Bob",
            lang="en",
            sources=[],
        )
        assert result != "original prompt"
        assert "Alice" in result
        assert plugin.stats["identity_relation"] >= 1

    def test_pre_extract_version_pipeline_appends_supplement(self):
        """When prompt_type='version', the plugin appends identity emphasis
        instead of replacing the entire prompt."""
        from memos.plugins.hooks import trigger_hook

        _, plugin = _make_app()

        version_prompt = "...existing version prompt with candidates..."
        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt=version_prompt,
            prompt_type="version",
            mem_str="我叫王沐辰，我的儿子叫王明泽",
            lang="zh",
            sources=[],
        )
        assert version_prompt in result
        assert "身份" in result or "关系" in result
        assert plugin.stats["identity_relation"] >= 1

    def test_pre_extract_version_pipeline_no_match(self):
        """When prompt_type='version' but no identity pattern, prompt unchanged."""
        from memos.plugins.hooks import trigger_hook

        _make_app()

        version_prompt = "...existing version prompt with candidates..."
        result = trigger_hook(
            "mem_reader.pre_extract",
            prompt=version_prompt,
            prompt_type="version",
            mem_str="今天天气不错",
            lang="zh",
            sources=[],
        )
        assert result == version_prompt
