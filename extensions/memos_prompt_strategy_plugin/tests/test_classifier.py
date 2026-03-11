"""Tests for the single-rule identity/relation classifier."""

from memos_prompt_strategy_plugin.classifier import (
    IDENTITY_RELATION,
    MessageClassifier,
)


def _src(role: str, content: str):
    class _S:
        pass

    s = _S()
    s.role = role
    s.content = content
    return s


class TestIdentityRelationRule:
    def setup_method(self):
        self.clf = MessageClassifier()

    # ── Chinese: self-naming ────────────────────────────────────

    def test_wo_jiao(self):
        sources = [_src("user", "你好，我叫王沐辰")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_wo_shi(self):
        sources = [_src("user", "我是李明，今年30岁")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_wo_de_mingzi_shi(self):
        sources = [_src("user", "我的名字是张三")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    # ── Chinese: relation naming ────────────────────────────────

    def test_son(self):
        sources = [_src("user", "我的儿子叫王明泽")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_daughter(self):
        sources = [_src("user", "我女儿叫小红")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_wife(self):
        sources = [_src("user", "我老婆是刘芳")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_mother(self):
        sources = [_src("user", "我妈妈叫李秀英")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_friend(self):
        sources = [_src("user", "我朋友叫赵磊")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_pet(self):
        sources = [_src("user", "我的猫叫小花")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    # ── Chinese: combined self + relation ───────────────────────

    def test_combined(self):
        sources = [_src("user", "我叫王沐辰，我的儿子叫王明泽")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    # ── English ─────────────────────────────────────────────────

    def test_my_name_is(self):
        sources = [_src("user", "Hi, my name is Alice")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_im(self):
        sources = [_src("user", "I'm Bob, nice to meet you")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_call_me(self):
        sources = [_src("user", "Just call me Charlie")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_my_son_is(self):
        sources = [_src("user", "My son is called David")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    def test_my_wife_is(self):
        sources = [_src("user", "My wife's name is Emma")]
        assert self.clf.classify(sources, "", "chat", {}) == IDENTITY_RELATION

    # ── No match → None ─────────────────────────────────────────

    def test_no_identity_returns_none(self):
        sources = [_src("user", "今天天气不错")]
        assert self.clf.classify(sources, "", "chat", {}) is None

    def test_task_text_returns_none(self):
        sources = [_src("user", "请帮我安排明天的会议")]
        assert self.clf.classify(sources, "", "chat", {}) is None

    def test_code_returns_none(self):
        sources = [_src("user", "```python\nprint('hello')\n```")]
        assert self.clf.classify(sources, "", "chat", {}) is None

    def test_empty_returns_none(self):
        assert self.clf.classify([], "", "chat", {}) is None

    # ── mem_str fallback ────────────────────────────────────────

    def test_uses_mem_str_when_no_sources(self):
        result = self.clf.classify([], "我叫王沐辰，我的儿子叫王明泽", "chat", {})
        assert result == IDENTITY_RELATION
