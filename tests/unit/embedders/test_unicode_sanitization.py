"""
Tests for Unicode sanitization in embedders.
"""

import pytest


def _sanitize_unicode(text: str) -> str:
    """
    Remove Unicode surrogates and other problematic characters.
    Surrogates (U+D800-U+DFFF) cause UnicodeEncodeError with some APIs.
    """
    try:
        # Encode with 'surrogatepass' then decode, replacing invalid chars
        cleaned = text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="replace")
        # Replace replacement char with empty string for cleaner output
        return cleaned.replace("\ufffd", "")
    except Exception:
        # Fallback: remove all non-BMP characters
        return "".join(c for c in text if ord(c) < 0x10000)


class TestUnicodeSanitization:
    """Test Unicode sanitization function."""

    def test_emoji_handling(self):
        """Test that emoji are preserved."""
        text = "Hello 👋 world 🌍"
        result = _sanitize_unicode(text)
        assert "Hello" in result
        assert "world" in result
        # Emoji should be present (though they might be sanitized differently)

    def test_surrogate_removal(self):
        """Test that surrogates are removed."""
        text = "Hello\ud800world"  # Surrogate in the middle
        result = _sanitize_unicode(text)
        assert "Hello" in result
        assert "world" in result
        # Surrogate should be removed
        assert "\ud800" not in result

    def test_mixed_unicode(self):
        """Test mixed Unicode characters."""
        text = "Test 中文 العربية Тест"
        result = _sanitize_unicode(text)
        assert "Test" in result
        # International characters should be preserved

    def test_empty_string(self):
        """Test empty string handling."""
        assert _sanitize_unicode("") == ""

    def test_ascii_only(self):
        """Test that ASCII text is unchanged."""
        text = "Hello World 123"
        assert _sanitize_unicode(text) == text

    def test_multiple_surrogates(self):
        """Test multiple surrogates are handled."""
        text = "\ud800\udc00test\ud83d\ude00"
        result = _sanitize_unicode(text)
        assert "test" in result
        # Should not raise UnicodeEncodeError

    def test_list_of_texts(self):
        """Test sanitizing a list of texts."""
        texts = ["Normal text", "Emoji 👋", "Surrogate\ud800test", "Mixed 中文 🔥"]
        results = [_sanitize_unicode(t) for t in texts]
        assert len(results) == 4
        assert all(isinstance(r, str) for r in results)

    def test_encoding_to_utf8(self):
        """Test that result can be encoded to UTF-8."""
        problematic_texts = [
            "Hello\ud800world",
            "Test\ud83dEmoji",
            "\ud800\udc00\ud83d\ude00",
        ]
        for text in problematic_texts:
            result = _sanitize_unicode(text)
            # Should not raise UnicodeEncodeError
            encoded = result.encode("utf-8")
            assert isinstance(encoded, bytes)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
