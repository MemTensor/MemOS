"""Regression tests for issue #2427.

``validate_key_format`` exists in two copies — ``src/memos/api/utils/api_keys.py``
(the canonical home) and ``src/memos/api/middleware/auth.py`` (the
middleware gating every authenticated request). Both check the hex part
with ``int(hex_part, 16)``, which accepts non-canonical forms a generated
key can never have:

- leading ``+`` / ``-`` (sign)
- ``0x`` / ``0X`` prefix
- ``_`` separators (PEP 515)
- surrounding whitespace

So the documented format ``krlk_<64-hex-chars>`` is not actually enforced:
keys with embedded underscores, signs, or ``0x`` prefixes pass the format
gate and are hashed/looked up as-is, bypassing the canonical form that
``generate_api_key()`` produces.

These tests pin the new contract on both validator copies:

- the hex part must match ``[0-9a-f]{64}`` exactly
- the only valid form is the canonical lowercase hex string
"""

from __future__ import annotations

import pytest

from memos.api.middleware.auth import validate_key_format as validate_in_auth
from memos.api.utils.api_keys import generate_api_key, validate_key_format


CANONICAL = "krlk_" + "0123456789abcdef" * 4  # 64 hex chars, lowercase


class TestValidateKeyFormatUtils:
    def test_canonical_key_passes(self):
        assert validate_key_format(CANONICAL) is True

    def test_generated_key_always_passes(self):
        # The validator must accept every key that generate_api_key()
        # produces, since that is the documented format.
        for _ in range(20):
            assert validate_key_format(generate_api_key().key) is True

    @pytest.mark.parametrize(
        "bad_key",
        [
            # Leading sign
            "krlk_" + "+" + "a" * 63,
            "krlk_" + "-" + "a" * 63,
            # 0x prefix
            "krlk_" + "0x" + "a" * 62,
            "krlk_" + "0X" + "a" * 62,
            # Underscore separator (PEP 515)
            "krlk_" + "a" * 32 + "_" + "b" * 31,
            # Uppercase hex (the generator emits lowercase only)
            "krlk_" + "A" * 64,
            # Surrounding whitespace
            " krlk_" + "a" * 64,
            "krlk_" + "a" * 64 + " ",
            # Wrong total length
            "krlk_" + "a" * 63,
            "krlk_" + "a" * 65,
            # Empty hex part
            "krlk_",
            # Missing prefix
            "0123456789abcdef" * 4,
            "Bearer " + CANONICAL,
            # Non-string
            "",
        ],
    )
    def test_non_canonical_keys_rejected(self, bad_key):
        assert validate_key_format(bad_key) is False, (
            f"validate_key_format({bad_key!r}) should return False"
        )


class TestAuthMiddlewareValidator:
    """The middleware copy must enforce the same contract as the canonical
    one — issue #2427 documents both copies accepting non-canonical hex."""

    def test_canonical_key_passes(self):
        assert validate_in_auth(CANONICAL) is True

    def test_signed_hex_rejected(self):
        # The most surprising bit: ``int("+a..", 16)`` succeeds, so a signed
        # hex passes the middleware's validator today.
        assert validate_in_auth("krlk_" + "+" + "a" * 63) is False

    def test_underscore_rejected(self):
        assert validate_in_auth("krlk_" + "a" * 32 + "_" + "b" * 31) is False

    def test_uppercase_rejected(self):
        assert validate_in_auth("krlk_" + "A" * 64) is False

    def test_0x_prefix_rejected(self):
        assert validate_in_auth("krlk_" + "0x" + "a" * 62) is False
