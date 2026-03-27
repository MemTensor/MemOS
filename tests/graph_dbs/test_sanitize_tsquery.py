"""Tests for _sanitize_tsquery_words — standalone, no heavy imports."""

import re


# ---------------------------------------------------------------------------
# Inline the function under test to avoid pulling in the full memos import
# chain (which requires a running logging backend).  The canonical copy lives
# in ``memos.graph_dbs.polardb._sanitize_tsquery_words``.
# ---------------------------------------------------------------------------


def _sanitize_tsquery_words(query_words: list[str]) -> list[str]:
    valid_chars_re = re.compile(
        r"[^\w\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]",
    )
    sanitized: list[str] = []
    seen: set[str] = set()
    for w in query_words:
        w = w.strip().strip("'")
        cleaned = valid_chars_re.sub("", w)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            sanitized.append(cleaned)
    return sanitized


class TestSanitizeTsqueryWords:
    """Unit tests for FTS query word sanitization."""

    def test_plain_english_words(self):
        assert _sanitize_tsquery_words(["hello", "world"]) == ["hello", "world"]

    def test_chinese_text(self):
        result = _sanitize_tsquery_words(["我要", "测试"])
        assert result == ["我要", "测试"]

    def test_mixed_content_message_id_and_chinese(self):
        """Reproduce the original bug: mixed IDs + Chinese text."""
        words = ["message_id", "om_x100b544a390604b8c3e1b7d8641f08e", "我要测试"]
        result = _sanitize_tsquery_words(words)
        assert len(result) == 3
        assert "message_id" in result
        assert "om_x100b544a390604b8c3e1b7d8641f08e" in result
        assert "我要测试" in result

    def test_single_quoted_words_are_stripped(self):
        words = ["'hello'", "'world'"]
        result = _sanitize_tsquery_words(words)
        assert result == ["hello", "world"]

    def test_special_characters_removed(self):
        words = ["hello!", "world@#$"]
        result = _sanitize_tsquery_words(words)
        assert result == ["hello", "world"]

    def test_empty_words_filtered(self):
        words = ["", "  ", "hello", ""]
        result = _sanitize_tsquery_words(words)
        assert result == ["hello"]

    def test_deduplication(self):
        words = ["hello", "hello", "world"]
        result = _sanitize_tsquery_words(words)
        assert result == ["hello", "world"]

    def test_empty_input(self):
        assert _sanitize_tsquery_words([]) == []

    def test_all_special_chars_returns_empty(self):
        words = ["!@#", "$%^"]
        result = _sanitize_tsquery_words(words)
        assert result == []

    def test_underscores_preserved(self):
        words = ["message_id", "user_name"]
        result = _sanitize_tsquery_words(words)
        assert result == ["message_id", "user_name"]

    def test_tsquery_operators_stripped(self):
        """Tsquery operators like & | ! should be stripped from within words."""
        words = ["hello & world", "foo | bar"]
        result = _sanitize_tsquery_words(words)
        # Spaces and operators removed; alphanumeric parts merge
        assert "helloworld" in result
        assert "foobar" in result
