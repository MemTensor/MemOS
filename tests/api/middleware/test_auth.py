"""Tests for authentication middleware."""


from memos.api.middleware.auth import (
    get_key_prefix,
    hash_api_key,
    validate_key_format,
)


class TestValidateKeyFormat:
    """Test API key format validation in middleware."""

    def test_valid_key(self):
        """Valid keys should pass validation."""
        # Test with all lowercase hex chars
        test_key = "krlk_" + "a" * 64
        assert validate_key_format(test_key)

        test_key = "krlk_" + "0123456789abcdef" * 4
        assert validate_key_format(test_key)

    def test_invalid_prefix(self):
        """Keys without krlk_ prefix should fail."""
        assert not validate_key_format("mk_" + "a" * 64)
        assert not validate_key_format("api_" + "a" * 64)
        assert not validate_key_format("a" * 69)

    def test_invalid_length(self):
        """Keys with wrong hex length should fail."""
        assert not validate_key_format("krlk_" + "a" * 63)  # Too short
        assert not validate_key_format("krlk_" + "a" * 65)  # Too long
        assert not validate_key_format("krlk_")  # No hex part

    def test_reject_leading_plus_sign(self):
        """Keys with leading + should be rejected."""
        # This currently passes but should fail - int('+' + hex, 16) works
        invalid_key = "krlk_" + "+" + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject leading +"

    def test_reject_leading_minus_sign(self):
        """Keys with leading - should be rejected."""
        invalid_key = "krlk_" + "-" + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject leading -"

    def test_reject_0x_prefix(self):
        """Keys with 0x prefix should be rejected."""
        # This currently passes but should fail - int('0x' + hex, 16) works
        invalid_key = "krlk_" + "0x" + "a" * 62
        assert not validate_key_format(invalid_key), "Should reject 0x prefix"

    def test_reject_underscores(self):
        """Keys with underscores in hex should be rejected."""
        # This currently passes but should fail - int() accepts _ separators
        invalid_key = "krlk_" + "a" * 30 + "_" + "b" * 33
        assert not validate_key_format(invalid_key), "Should reject underscores"

        invalid_key = "krlk_" + "1234_5678_9abc_def0" + "a" * 46
        assert not validate_key_format(invalid_key), "Should reject underscores"

    def test_reject_whitespace(self):
        """Keys with whitespace in hex should be rejected."""
        invalid_key = "krlk_" + " " + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject leading space"

        invalid_key = "krlk_" + "a" * 63 + " "
        assert not validate_key_format(invalid_key), "Should reject trailing space"

        invalid_key = "krlk_" + "a" * 32 + " " + "b" * 31
        assert not validate_key_format(invalid_key), "Should reject embedded space"

        invalid_key = "krlk_" + "\t" + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject tabs"

    def test_reject_uppercase_hex(self):
        """Keys with uppercase hex should be rejected."""
        # Generated keys use lowercase only
        invalid_key = "krlk_" + "A" * 64
        assert not validate_key_format(invalid_key), "Should reject uppercase hex"

        invalid_key = "krlk_" + "a" * 32 + "B" + "c" * 31
        assert not validate_key_format(invalid_key), "Should reject mixed case"

    def test_reject_non_hex_chars(self):
        """Keys with non-hex characters should be rejected."""
        assert not validate_key_format("krlk_" + "g" * 64)
        assert not validate_key_format("krlk_" + "z" * 64)
        assert not validate_key_format("krlk_" + "!" * 64)

    def test_none_and_empty(self):
        """None and empty strings should fail."""
        assert not validate_key_format(None)
        assert not validate_key_format("")


class TestHashApiKey:
    """Test API key hashing."""

    def test_hash_deterministic(self):
        """Same key should produce same hash."""
        key = "krlk_" + "a" * 64
        hash1 = hash_api_key(key)
        hash2 = hash_api_key(key)
        assert hash1 == hash2

    def test_hash_unique(self):
        """Different keys should produce different hashes."""
        key1 = "krlk_" + "a" * 64
        key2 = "krlk_" + "b" * 64
        assert hash_api_key(key1) != hash_api_key(key2)


class TestGetKeyPrefix:
    """Test key prefix extraction."""

    def test_get_prefix_normal_key(self):
        """Should extract first 12 chars."""
        key = "krlk_abcdef123456789"
        assert get_key_prefix(key) == "krlk_abcdef1"
        assert len(get_key_prefix(key)) == 12

    def test_get_prefix_short_key(self):
        """Should return full key if shorter than 12 chars."""
        key = "krlk_abc"
        assert get_key_prefix(key) == key
