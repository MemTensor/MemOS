"""Tests for MessageClassifier rule-based classification."""

from memos_prompt_strategy_plugin.classifier import (
    CASUAL_CHAT,
    CODE_DISCUSSION,
    EMOTIONAL,
    KNOWLEDGE_SHARING,
    MULTI_TURN_QA,
    TASK_ORIENTED,
    MessageClassifier,
)


def _src(role: str, content: str):
    """Helper: lightweight source-like object."""

    class _S:
        pass

    s = _S()
    s.role = role
    s.content = content
    return s


class TestClassifierRules:
    def setup_method(self):
        self.clf = MessageClassifier()

    # ── code_discussion ──────────────────────────────────────────

    def test_code_block_triggers_code(self):
        sources = [_src("user", "Here is my code:\n```python\nprint('hello')\n```")]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == CODE_DISCUSSION

    def test_tech_keywords_trigger_code(self):
        sources = [
            _src("user", "I need to import the SDK and call the API via HTTP with JSON payload")
        ]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == CODE_DISCUSSION

    # ── task_oriented ────────────────────────────────────────────

    def test_task_keywords_en(self):
        sources = [_src("user", "Please schedule a meeting and set up the deployment pipeline")]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == TASK_ORIENTED

    def test_task_keywords_zh(self):
        sources = [_src("user", "请帮我安排明天的会议，并提醒我截止日期")]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == TASK_ORIENTED

    # ── emotional ────────────────────────────────────────────────

    def test_emotion_en(self):
        sources = [_src("user", "I feel so happy and grateful for everything today")]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == EMOTIONAL

    def test_emotion_zh(self):
        sources = [_src("user", "今天特别开心，也很感恩身边的朋友")]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == EMOTIONAL

    # ── knowledge_sharing ────────────────────────────────────────

    def test_long_text_knowledge(self):
        long_text = "This is a detailed explanation of how transformers work.\n" * 20
        sources = [_src("user", long_text)]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == KNOWLEDGE_SHARING

    # ── multi_turn_qa ────────────────────────────────────────────

    def test_multi_turn_qa(self):
        sources = [
            _src("user", "What is the best approach for caching?"),
            _src("assistant", "It depends on your use case. What latency do you need?"),
            _src("user", "Under 100ms. Which solution fits?"),
            _src("assistant", "Redis would be ideal for that latency requirement."),
        ]
        text = "\n".join(s.content for s in sources)
        result = self.clf.classify(sources, text, "chat", {})
        assert result == MULTI_TURN_QA

    # ── casual_chat ──────────────────────────────────────────────

    def test_short_casual(self):
        sources = [_src("user", "Hey, nice weather today!")]
        result = self.clf.classify(sources, "", "chat", {})
        assert result == CASUAL_CHAT

    # ── fallback ─────────────────────────────────────────────────

    def test_no_match_returns_default(self):
        sources = [
            _src("user", "Let me think about that for a moment"),
            _src("assistant", "Sure, take your time"),
            _src("user", "Okay I have decided"),
        ]
        text = "\n".join(s.content for s in sources)
        result = self.clf.classify(sources, text, "chat", {})
        assert result == "chat"
