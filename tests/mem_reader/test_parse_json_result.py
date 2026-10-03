"""Regression tests for issue #2456.

A malformed LLM extraction response with a trailing comma before a closing
brace (``[...],]`` or ``{"a": 1,}``) used to be silently converted to ``{}``
by :func:`memos.mem_reader.utils.parse_json_result`, which downstream was
reported as a successful ``/product/add`` with ``data: []`` and no memories
stored.

The parser now attempts a narrow trailing-comma repair (**outside quoted
strings only**) as a last-chance recovery before giving up with ``{}``. These
tests pin that behavior.
"""

import unittest

from memos.mem_reader.utils import parse_json_result


class TestParseJsonResultTrailingComma(unittest.TestCase):
    """Issue #2456: trailing comma from LLM should be repaired, not dropped."""

    # --- the exact reproduction from the bug report ------------------------

    def test_issue_2456_reproduction(self):
        """Minimal deterministic reproduction from the bug report must now
        recover the memory list instead of returning ``{}``."""
        valid = '{"memory list": [{"value": "synthetic evidence"}]}'
        malformed = '{"memory list": [{"value": "synthetic evidence"}],}'

        expected = {"memory list": [{"value": "synthetic evidence"}]}

        self.assertEqual(parse_json_result(valid), expected)
        # Was ``{}`` before the fix — now the repair branch recovers the
        # original payload so ``/product/add`` can persist the memory.
        self.assertEqual(parse_json_result(malformed), expected)

    # --- trailing comma in various positions -------------------------------

    def test_trailing_comma_before_object_close(self):
        """``{"a": 1,}`` -> ``{"a": 1}``."""
        self.assertEqual(parse_json_result('{"a": 1,}'), {"a": 1})

    def test_trailing_comma_before_array_close(self):
        """``[1, 2, 3,]`` -> ``[1, 2, 3]`` when wrapped in an object."""
        self.assertEqual(
            parse_json_result('{"xs": [1, 2, 3,]}'),
            {"xs": [1, 2, 3]},
        )

    def test_trailing_comma_before_newline_and_close(self):
        """Whitespace / newlines between the comma and the closer must not
        defeat the repair."""
        raw = '{"xs": [\n  1,\n  2,\n],\n}'
        self.assertEqual(parse_json_result(raw), {"xs": [1, 2]})

    def test_trailing_comma_inside_fenced_code_block(self):
        """``parse_json_result`` already strips ``` fences; the repair must
        still fire on the inner payload."""
        raw = '```json\n{"a": 1,}\n```'
        self.assertEqual(parse_json_result(raw), {"a": 1})

    # --- safety: do not touch commas that are legitimate -------------------

    def test_comma_inside_string_is_not_stripped(self):
        """A literal ``,}`` *inside* a quoted string must not be touched."""
        # The value contains ``foo,}`` as literal data. Repair would corrupt
        # the string if the state machine were naive.
        raw = '{"msg": "foo,}"}'
        self.assertEqual(parse_json_result(raw), {"msg": "foo,}"})

    def test_escaped_quote_inside_string_does_not_confuse_scanner(self):
        """``\\"`` inside a string must keep the scanner in-string, so a
        trailing comma that follows (still inside the string) stays."""
        raw = '{"msg": "he said \\"hi,\\" then left,}"}'
        self.assertEqual(
            parse_json_result(raw),
            {"msg": 'he said "hi," then left,}'},
        )

    def test_valid_json_is_unchanged(self):
        """Valid JSON must round-trip unchanged — no accidental repair."""
        raw = '{"a": [1, 2, 3], "b": {"c": "d"}}'
        self.assertEqual(
            parse_json_result(raw),
            {"a": [1, 2, 3], "b": {"c": "d"}},
        )

    # --- hard-failure contract preserved ------------------------------------

    def test_genuinely_malformed_still_returns_empty_dict(self):
        """When the trailing-comma repair cannot help (missing value,
        unmatched braces that even ``_cheap_close`` cannot resolve, etc.),
        the historical ``{}`` return contract must be preserved so the 15+
        callers do not need to change."""
        # Missing value for key ``a`` — not a trailing-comma problem.
        self.assertEqual(parse_json_result('{"a":}'), {})

    def test_non_json_text_still_returns_empty_dict(self):
        """Pure chatter with no JSON must still return ``{}`` — pins the
        existing ``test_parse_json_result_failure`` contract."""
        self.assertEqual(parse_json_result("this is not json at all"), {})

    def test_empty_input_returns_empty_dict(self):
        self.assertEqual(parse_json_result(""), {})
        self.assertEqual(parse_json_result(None), {})  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
