"""
Test suite for src/memos/mem_os/utils/reference_utils.py

Focus: split_continuous_references handles every comma-based
separator style (with or without trailing whitespace, mixed styles
inside a single tag). Related issue: #2417
"""

import pytest

from memos.mem_os.utils.reference_utils import split_continuous_references


class TestSplitContinuousReferences:
    """Behavioral tests for split_continuous_references."""

    def test_splits_comma_space_separator(self):
        assert split_continuous_references("[1:aaa, 4:bbb, 7:ccc]") == "[1:aaa][4:bbb][7:ccc]"

    def test_splits_bare_comma_separator(self):
        assert split_continuous_references("[1:aaa,4:bbb,7:ccc]") == "[1:aaa][4:bbb][7:ccc]"

    def test_splits_mixed_comma_styles_bare_then_space(self):
        # Regression for #2417: bare comma followed by ", " style
        # previously left the first pair merged.
        assert (
            split_continuous_references("[1:92ff35fb,4:bfe6f044, 7:abcd1234]")
            == "[1:92ff35fb][4:bfe6f044][7:abcd1234]"
        )

    def test_splits_mixed_comma_styles_space_then_bare(self):
        assert split_continuous_references("[1:aaa, 4:bbb,7:ccc]") == "[1:aaa][4:bbb][7:ccc]"

    def test_splits_comma_with_multiple_spaces(self):
        assert split_continuous_references("[1:aaa,  4:bbb,\t7:ccc]") == "[1:aaa][4:bbb][7:ccc]"

    def test_single_reference_unchanged(self):
        assert split_continuous_references("[1:aaa]") == "[1:aaa]"

    def test_empty_string_returned_as_is(self):
        assert split_continuous_references("") == ""

    def test_text_without_brackets_unchanged(self):
        assert split_continuous_references("no brackets here") == "no brackets here"

    def test_text_with_multiple_bracket_pairs_unchanged(self):
        original = "[1:aaa] and [2:bbb, 3:ccc]"
        assert split_continuous_references(original) == original

    def test_text_without_comma_between_brackets_unchanged(self):
        assert split_continuous_references("hello [1:aaa] world") == "hello [1:aaa] world"

    def test_prefix_and_suffix_preserved(self):
        assert (
            split_continuous_references("prefix [1:aaa, 4:bbb] suffix")
            == "prefix [1:aaa][4:bbb] suffix"
        )

    def test_reversed_brackets_returned_unchanged(self):
        assert split_continuous_references("]1:aaa,2:bbb[") == "]1:aaa,2:bbb["

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("[1:x,2:y]", "[1:x][2:y]"),
            ("[1:x, 2:y]", "[1:x][2:y]"),
            ("[1:x,  2:y]", "[1:x][2:y]"),
            ("[1:x,\t2:y]", "[1:x][2:y]"),
        ],
    )
    def test_parametrized_trailing_whitespace_variants(self, raw, expected):
        assert split_continuous_references(raw) == expected
