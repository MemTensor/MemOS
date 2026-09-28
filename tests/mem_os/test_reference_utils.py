import unittest

from memos.mem_os.utils.reference_utils import split_continuous_references


class TestSplitContinuousReferences(unittest.TestCase):
    def test_spaced_comma(self):
        self.assertEqual(
            split_continuous_references("[1:92ff35fb, 4:bfe6f044]"),
            "[1:92ff35fb][4:bfe6f044]",
        )

    def test_tight_comma(self):
        self.assertEqual(
            split_continuous_references("[1:92ff35fb,4:bfe6f044]"),
            "[1:92ff35fb][4:bfe6f044]",
        )

    def test_mixed_separators(self):
        """Mixed ', ' and ',' separators used to leave earlier refs merged.

        The old two-pass str.replace applied one separator style per call;
        the first successful pass removed the substring the second pass
        searched for, so with "[a,b, c]" only the last boundary was split.
        """
        self.assertEqual(
            split_continuous_references("[1:92ff35fb,4:bfe6f044, 7:abcd1234]"),
            "[1:92ff35fb][4:bfe6f044][7:abcd1234]",
        )

    def test_ordinary_bracketed_text_untouched(self):
        # "[x, y]" has no reference-tag shape (numeric id + colon); it must
        # not be rewritten into "[x][y]" on the streaming chat path
        self.assertEqual(
            split_continuous_references("interval [x, y] ends"),
            "interval [x, y] ends",
        )
        self.assertEqual(split_continuous_references("cite [1, 2] here"), "cite [1, 2] here")

    def test_surrounding_text_preserved(self):
        self.assertEqual(
            split_continuous_references("see refs [1:aaaa, 2:bbbb] for details"),
            "see refs [1:aaaa][2:bbbb] for details",
        )

    def test_non_reference_text_untouched(self):
        for text in (
            "",
            "plain text",
            "[no commas here]",
            "two [brackets] twice [here]",
            "backwards ]here[",
        ):
            self.assertEqual(split_continuous_references(text), text)


if __name__ == "__main__":
    unittest.main()
