"""Tests for API key utilities."""


from memos.api.utils.api_keys import (
    generate_api_key,
    hash_key,
    validate_key_format,
)


class TestGenerateAPIKey:
    """Test API key generation."""

    def test_generate_api_key_format(self):
        """Generated key should have correct format."""
        api_key = generate_api_key()
        assert api_key.key.startswith("krlk_")
        assert len(api_key.key) == 69  # 'krlk_' (5) + 64 hex chars
        assert validate_key_format(api_key.key)

    def test_generate_api_key_randomness(self):
        """Each generated key should be unique."""
        keys = [generate_api_key().key for _ in range(10)]
        assert len(set(keys)) == 10


class TestValidateKeyFormat:
    """Test API key format validation."""

    def test_valid_key(self):
        """Valid keys should pass validation."""
        # Generate a real key
        valid_key = generate_api_key().key
        assert validate_key_format(valid_key)

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
        # This currently passes but should fail
        invalid_key = "krlk_" + "+" + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject leading +"

    def test_reject_leading_minus_sign(self):
        """Keys with leading - should be rejected."""
        invalid_key = "krlk_" + "-" + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject leading -"

    def test_reject_0x_prefix(self):
        """Keys with 0x prefix should be rejected."""
        # This currently passes but should fail
        invalid_key = "krlk_" + "0x" + "a" * 62
        assert not validate_key_format(invalid_key), "Should reject 0x prefix"

    def test_reject_underscores(self):
        """Keys with underscores in hex should be rejected."""
        # This currently passes but should fail
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

        invalid_key = "krlk_" + "\n" + "a" * 63
        assert not validate_key_format(invalid_key), "Should reject newlines"

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
        assert not validate_key_format("krlk_" + "a" * 63 + "g")

    def test_none_and_empty(self):
        """None and empty strings should fail."""
        assert not validate_key_format(None)
        assert not validate_key_format("")
        assert not validate_key_format("   ")

    def test_non_string_input(self):
        """Non-string inputs should fail."""
        assert not validate_key_format(123)
        assert not validate_key_format(["krlk_", "a" * 64])
        assert not validate_key_format({"key": "krlk_" + "a" * 64})


class TestHashKey:
    """Test key hashing."""

    def test_hash_key_deterministic(self):
        """Same key should produce same hash."""
        key = "krlk_" + "a" * 64
        hash1 = hash_key(key)
        hash2 = hash_key(key)
        assert hash1 == hash2

    def test_hash_key_unique(self):
        """Different keys should produce different hashes."""
        key1 = "krlk_" + "a" * 64
        key2 = "krlk_" + "b" * 64
        assert hash_key(key1) != hash_key(key2)

    def test_hash_key_length(self):
        """SHA-256 hash should be 64 hex chars."""
        key = generate_api_key().key
        key_hash = hash_key(key)
        assert len(key_hash) == 64
        assert all(c in "0123456789abcdef" for c in key_hash)
