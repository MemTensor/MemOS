"""Tests for src/memos/mem_os/utils/reference_utils.py.

Focus: split_continuous_references shape guard.
Related issue: #2446 — plain bracketed prose such as "[apple, banana]" must
not be rewritten as "[apple][banana]". Only reference lists whose items are
``int:<id>`` pairs (e.g. ``[1:92ff35fb, 4:bfe6f044]``) should be split.
"""

from memos.mem_os.utils.reference_utils import split_continuous_references


class TestSplitContinuousReferences:
    """Shape guard on ``split_continuous_references``."""

    # --- happy path: real reference lists still split ------------------------

    def test_splits_two_int_id_items(self):
        assert (
            split_continuous_references("See [1:92ff35fb, 4:bfe6f044] now")
            == "See [1:92ff35fb][4:bfe6f044] now"
        )

    def test_splits_three_int_id_items(self):
        assert split_continuous_references("[1:aa, 2:bb, 3:cc]") == "[1:aa][2:bb][3:cc]"

    def test_handles_comma_without_space(self):
        assert (
            split_continuous_references("prefix [1:aa,2:bb] suffix") == "prefix [1:aa][2:bb] suffix"
        )

    def test_handles_mixed_separator_styles(self):
        """Regression: mixed ``", "`` and bare ``","`` separators in the same
        block must all be split (PR #2450 review).

        The previous two-step ``str.replace`` implementation left the bare
        comma between ``2:bb`` and ``3:cc`` intact, producing
        ``"[1:aa][2:bb,3:cc]"``.
        """
        assert (
            split_continuous_references("[1:aa, 2:bb,3:cc]") == "[1:aa][2:bb][3:cc]"
        )

    def test_handles_mixed_separator_styles_reversed(self):
        """Bare comma first, then ``", "`` — symmetric to the case above."""
        assert (
            split_continuous_references("[1:aa,2:bb, 3:cc]") == "[1:aa][2:bb][3:cc]"
        )

    # --- shape guard: non-reference brackets stay untouched ------------------

    def test_plain_prose_list_untouched(self):
        """The regression case from issue #2446."""
        text = "The set is [apple, banana] here"
        assert split_continuous_references(text) == text

    def test_mixed_reference_and_prose_untouched(self):
        """If even one item is not int:<id> the whole block is preserved."""
        text = "Look at [1:92ff35fb, banana] please"
        assert split_continuous_references(text) == text

    def test_numeric_only_items_untouched(self):
        """Numbers without a colon are not references."""
        text = "Pick [1, 2, 3] please"
        assert split_continuous_references(text) == text

    def test_non_integer_prefix_untouched(self):
        """The item prefix must be a decimal integer."""
        text = "Combine [a:1, b:2]"
        assert split_continuous_references(text) == text

    # --- boundary conditions unchanged ---------------------------------------

    def test_empty_string_returns_empty(self):
        assert split_continuous_references("") == ""

    def test_no_brackets_returns_text_unchanged(self):
        text = "no brackets, just commas"
        assert split_continuous_references(text) == text

    def test_multiple_open_brackets_returns_unchanged(self):
        text = "many [1:aa, 2:bb] and [3:cc, 4:dd]"
        assert split_continuous_references(text) == text

    def test_single_reference_item_unchanged(self):
        """A single item has no comma so nothing to split."""
        text = "just [1:aa]"
        assert split_continuous_references(text) == text
