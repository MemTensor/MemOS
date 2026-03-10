"""Tests for StrategyRegistry and prompt building."""

from memos_prompt_strategy_plugin.strategies import PromptStrategy, StrategyRegistry


class TestStrategyRegistry:
    def setup_method(self):
        self.reg = StrategyRegistry()
        self.reg.register_defaults()

    def test_all_default_strategies_registered(self):
        strategies = self.reg.all_strategies()
        expected = {
            "casual_chat",
            "task_oriented",
            "knowledge_sharing",
            "emotional",
            "code_discussion",
            "multi_turn_qa",
        }
        assert set(strategies.keys()) == expected

    def test_build_prompt_returns_none_for_unknown(self):
        result = self.reg.build_prompt("nonexistent_category", "en", "hello")
        assert result is None

    def test_build_prompt_en(self):
        prompt = self.reg.build_prompt("casual_chat", "en", "Hey, how are you?")
        assert prompt is not None
        assert "Hey, how are you?" in prompt
        assert "preferences" in prompt.lower() or "habits" in prompt.lower()

    def test_build_prompt_zh(self):
        prompt = self.reg.build_prompt("casual_chat", "zh", "你好，最近怎么样？")
        assert prompt is not None
        assert "你好，最近怎么样？" in prompt
        assert "偏好" in prompt or "习惯" in prompt

    def test_build_prompt_with_custom_tags(self):
        prompt = self.reg.build_prompt(
            "task_oriented", "en", "Please deploy by Friday", custom_tags=["deadline", "ops"]
        )
        assert prompt is not None
        assert "deadline" in prompt
        assert "ops" in prompt

    def test_task_oriented_has_deadline_focus(self):
        prompt = self.reg.build_prompt("task_oriented", "en", "meeting at 3pm")
        assert prompt is not None
        assert "deadline" in prompt.lower() or "task" in prompt.lower()

    def test_code_discussion_has_tech_focus(self):
        prompt = self.reg.build_prompt("code_discussion", "en", "fix the bug")
        assert prompt is not None
        assert "framework" in prompt.lower() or "tool" in prompt.lower()

    def test_emotional_has_feeling_focus(self):
        prompt = self.reg.build_prompt("emotional", "en", "I feel sad")
        assert prompt is not None
        assert "emotion" in prompt.lower() or "feeling" in prompt.lower()

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
        assert reg.build_prompt("casual_chat", "en", "hi") is None

    def test_get_unknown_returns_none(self):
        reg = StrategyRegistry()
        assert reg.get("nonexistent") is None
