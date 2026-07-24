"""Tests for context-aware query expansion in TaskGoalParser fast mode.

Covers the fix for #1365: referential queries (e.g. "再找找其他价格优惠的")
no longer drift to unrelated older memories because the most recent user
message is prepended to the query for embedding search.
"""

from unittest.mock import MagicMock

import pytest

from memos.memories.textual.tree_text_memory.retrieve.task_goal_parser import (
    TaskGoalParser,
)


@pytest.fixture
def parser():
    """Build a TaskGoalParser with a mock LLM (not used in fast mode)."""
    return TaskGoalParser(llm=MagicMock())


class TestParseFastContextExpansion:
    """Tests that ``_parse_fast`` uses conversation history correctly."""

    def test_no_conversation_keeps_original_query(self, parser):
        """Without conversation, query is unchanged."""
        result = parser._parse_fast("找商品", context="")
        assert result.rephrased_query == "找商品"
        assert result.memories == ["找商品"]

    def test_referential_query_gets_augmented(self, parser):
        """Short referential queries are prepended with last user message."""
        conversation = [
            {"role": "user", "content": "帮我找A商品"},
            {"role": "assistant", "content": "找到了A商品"},
            {"role": "user", "content": "再找找其他价格优惠的"},
        ]
        result = parser._parse_fast("再找找其他价格优惠的", conversation=conversation, context="")
        assert "帮我找A商品" in result.rephrased_query
        assert "再找找其他价格优惠的" in result.rephrased_query

    def test_non_referential_long_query_not_augmented(self, parser):
        """Long, self-contained queries are not augmented."""
        conversation = [
            {"role": "user", "content": "帮我找A商品"},
            {"role": "assistant", "content": "找到了"},
        ]
        long_query = "请帮我搜索一下关于大型语言模型训练过程中梯度爆炸问题的解决方案"
        result = parser._parse_fast(long_query, conversation=conversation, context="")
        assert result.rephrased_query == long_query

    def test_english_referential_query(self, parser):
        """English referential words also trigger augmentation."""
        conversation = [
            {"role": "user", "content": "Find me a red dress"},
            {"role": "assistant", "content": "Here are some red dresses"},
        ]
        result = parser._parse_fast("show me more", conversation=conversation, context="")
        assert "Find me a red dress" in result.rephrased_query
        assert "show me more" in result.rephrased_query

    def test_empty_conversation(self, parser):
        """Empty conversation list does not cause errors."""
        result = parser._parse_fast("找商品", conversation=[], context="")
        assert result.rephrased_query == "找商品"

    def test_conversation_without_user_messages(self, parser):
        """Conversation with only assistant messages does not augment."""
        conversation = [
            {"role": "assistant", "content": "Hello there"},
        ]
        result = parser._parse_fast("再找找", conversation=conversation, context="")
        assert result.rephrased_query == "再找找"

    def test_long_last_user_message_truncated(self, parser):
        """Very long last user messages are truncated to 120 chars."""
        long_msg = "A" * 300
        conversation = [
            {"role": "user", "content": long_msg},
        ]
        result = parser._parse_fast("再找找", conversation=conversation, context="")
        # The augmented query should contain the truncated version (first 120 chars)
        assert "A" * 120 in result.rephrased_query
        assert "A" * 121 not in result.rephrased_query  # Verify truncation actually occurred

    def test_parse_method_passes_conversation_in_fast_mode(self, parser):
        """The public ``parse`` method passes conversation to ``_parse_fast``."""
        conversation = [
            {"role": "user", "content": "帮我找A商品"},
            {"role": "assistant", "content": "好的"},
        ]
        result = parser.parse(
            task_description="再找找",
            context="",
            conversation=conversation,
            mode="fast",
        )
        assert "帮我找A商品" in result.rephrased_query
