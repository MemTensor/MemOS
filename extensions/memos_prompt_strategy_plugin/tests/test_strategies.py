"""Tests for StrategyRegistry and prompt building."""

from memos_prompt_strategy_plugin.strategies import PromptStrategy, StrategyRegistry


class TestStrategyRegistry:
    def setup_method(self):
        self.reg = StrategyRegistry()
        self.reg.register_defaults()

    def test_default_strategies_registered(self):
        strategies = self.reg.all_strategies()
        assert "identity_relation" in strategies

    def test_build_prompt_returns_none_for_unknown(self):
        result = self.reg.build_prompt("nonexistent_category", "en", "hello")
        assert result is None

    def test_build_prompt_zh(self):
        prompt = self.reg.build_prompt("identity_relation", "zh", "我叫王沐辰，我的儿子叫王明泽")
        assert prompt is not None
        assert "王沐辰" in prompt
        assert "王明泽" in prompt
        assert "身份" in prompt or "关系" in prompt

    def test_build_prompt_en(self):
        prompt = self.reg.build_prompt("identity_relation", "en", "My name is Alice, my son is Bob")
        assert prompt is not None
        assert "Alice" in prompt
        assert "Bob" in prompt
        assert "identity" in prompt.lower() or "relationship" in prompt.lower()

    def test_build_prompt_with_custom_tags(self):
        prompt = self.reg.build_prompt(
            "identity_relation", "zh", "我叫张三", custom_tags=["family", "name"]
        )
        assert prompt is not None
        assert "family" in prompt
        assert "name" in prompt

    def test_custom_strategy_registration(self):
        custom = PromptStrategy(
            name="custom_test",
            template_en="Extract from: ${conversation} ${custom_tags_prompt}",
            template_zh="提取：${conversation} ${custom_tags_prompt}",
            description="Test strategy",
        )
        self.reg.register(custom)
        prompt = self.reg.build_prompt("custom_test", "en", "hello world")
        assert prompt is not None
        assert "hello world" in prompt


class TestStrategyRegistryIsolation:
    def test_empty_registry_returns_none(self):
        reg = StrategyRegistry()
        assert reg.build_prompt("identity_relation", "en", "hi") is None

    def test_get_unknown_returns_none(self):
        reg = StrategyRegistry()
        assert reg.get("nonexistent") is None
